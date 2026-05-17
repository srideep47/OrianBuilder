/**
 * Tool execution helpers for the local-agent streaming loop.
 *
 * - getMcpTools: builds the MCP toolset for a chat session
 * - getExecutableTool: narrows an AI SDK tool entry to one that has an execute method
 * - executePlainTextToolFallback: runs a single plain-text tool call recovered after a pass
 *   that produced text instead of structured tool calls
 */

import type { IpcMainInvokeEvent } from "electron";
import type { ToolExecutionOptions, ToolSet, ModelMessage } from "ai";
import log from "electron-log";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { mcpServers } from "@/db/schema";
import { mcpManager } from "@/ipc/utils/mcp_manager";
import { requireMcpToolConsent } from "@/ipc/utils/mcp_consent";
import { parseMcpToolKey, sanitizeMcpName } from "@/ipc/utils/mcp_tool_utils";
import { logMissionEvent } from "@/ipc/utils/mission_utils";

import {
  type AgentContext,
  type UserMessageContentPart,
  escapeXmlAttr,
  escapeXmlContent,
} from "../tools/types";
import { hasTextToolCallMarkers } from "../text_tool_call_parser";
import { runTextToolCallFallback } from "../text_tool_call_executor";
import type { MissionAutonomyProfile } from "@/ipc/types/mission";
import { stringifyManualToolResult } from "./AgentStepProcessor";

const logger = log.scope("local_agent_handler");

export const MAX_TEXT_TOOL_CALL_FALLBACK_ATTEMPTS = 6;

export type ExecutableTool = {
  execute: (args: Record<string, unknown>) => unknown | Promise<unknown>;
};

export function getExecutableTool(
  toolSet: ToolSet,
  toolName: string,
): ExecutableTool | null {
  const candidate = toolSet[toolName];
  if (
    candidate &&
    typeof candidate === "object" &&
    "execute" in candidate &&
    typeof candidate.execute === "function"
  ) {
    return candidate as unknown as ExecutableTool;
  }
  return null;
}

export async function getMcpTools(
  event: IpcMainInvokeEvent,
  ctx: AgentContext,
  mcpSessionId: string,
): Promise<ToolSet> {
  const mcpToolSet: ToolSet = {};

  try {
    const servers = await db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.enabled, true));

    for (const s of servers) {
      const client = await mcpManager.acquireClient(s.id, mcpSessionId);
      const toolSet = await client.tools();

      for (const [name, mcpTool] of Object.entries(toolSet)) {
        const key = `${sanitizeMcpName(s.name || "")}__${sanitizeMcpName(name)}`;

        mcpToolSet[key] = {
          description: mcpTool.description,
          inputSchema: mcpTool.inputSchema,
          execute: async (args: unknown, execCtx: ToolExecutionOptions) => {
            try {
              const inputPreview =
                typeof args === "string"
                  ? args
                  : Array.isArray(args)
                    ? args.join(" ")
                    : JSON.stringify(args).slice(0, 500);

              const ok = await requireMcpToolConsent(event, {
                serverId: s.id,
                serverName: s.name,
                toolName: name,
                toolDescription: mcpTool.description,
                inputPreview,
              });

              if (!ok) throw new Error(`User declined running tool ${key}`);

              const { serverName, toolName } = parseMcpToolKey(key);
              const content = JSON.stringify(args, null, 2);
              ctx.onXmlComplete(
                `<orianbuilder-mcp-tool-call server="${serverName}" tool="${toolName}">\n${content}\n</orianbuilder-mcp-tool-call>`,
              );

              const res = await mcpTool.execute(args, execCtx);
              const resultStr =
                typeof res === "string" ? res : JSON.stringify(res);

              ctx.onXmlComplete(
                `<orianbuilder-mcp-tool-result server="${serverName}" tool="${toolName}">\n${resultStr}\n</orianbuilder-mcp-tool-result>`,
              );

              return resultStr;
            } catch (error) {
              const errorMessage =
                error instanceof Error ? error.message : String(error);
              const errorStack =
                error instanceof Error && error.stack ? error.stack : "";
              ctx.onXmlComplete(
                `<orianbuilder-output type="error" message="MCP tool '${key}' failed: ${escapeXmlAttr(errorMessage)}">${escapeXmlContent(errorStack || errorMessage)}</orianbuilder-output>`,
              );
              throw error;
            }
          },
        };
      }
    }
  } catch (e) {
    logger.warn("Failed building MCP toolset for local-agent", e);
  }

  return mcpToolSet;
}

/**
 * Execute a plain-text tool call extracted from a model response that emitted
 * tool XML as prose instead of as a structured tool call. Returns the synthetic
 * user message describing the recovered execution, ready to be appended to
 * conversation history so the model can continue.
 */
export async function executePlainTextToolFallback(params: {
  toolName: string;
  args: Record<string, unknown>;
  allTools: ToolSet;
}): Promise<ModelMessage> {
  const { toolName, args, allTools } = params;
  const tool = getExecutableTool(allTools, toolName);
  let toolResultText = "";
  try {
    if (!tool) {
      throw new Error(`Tool ${toolName} is not executable`);
    }
    const result = await tool.execute(args);
    toolResultText = stringifyManualToolResult(result);
  } catch (error) {
    toolResultText = error instanceof Error ? error.message : String(error);
  }

  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `[System] You emitted <${toolName}> as plain XML text instead of making a real tool call. The backend executed that tool for you.\n\nTool result:\n${toolResultText.slice(0, 8000)}\n\nContinue the user's request from this result. Use real tool calls for future actions; do not print tool XML as prose.`,
      },
    ],
  };
}

/**
 * Mutable bookkeeping for the in-step text-tool-call fallback.
 *
 * Counter values are wrapped in an object so we can mutate them via the
 * shared reference (the streaming loop reads them again to decide whether
 * to short-circuit subsequent passes).
 */
export type TextToolCallFallbackState = {
  textToolCallFallbackAttempts: number;
  totalFallbackToolCalls: number;
  pendingUserMessages: UserMessageContentPart[][];
  warningMessages: string[];
};

/**
 * Triggered when the model emits a tool call as prose instead of through the
 * AI SDK's structured slot (common with local GGUFs like Qwen, DeepSeek, plain
 * Llama 3.x). Parses the text, executes what's safely recoverable, and pushes
 * a synthetic user message containing the results so the model can continue.
 *
 * After MAX_TEXT_TOOL_CALL_FALLBACK_ATTEMPTS unsuccessful recoveries, aborts
 * the run so the user can switch to a tool-capable model.
 *
 * Mutates `state` (counters and the pending-message / warning arrays).
 */
export async function maybeRunInStepTextToolCallFallback(params: {
  step: { toolCalls: Array<unknown>; text?: string };
  ctx: AgentContext;
  state: TextToolCallFallbackState;
  autonomyProfile: MissionAutonomyProfile;
  abortController: AbortController;
  missionId: number | null | undefined;
  missionStepCheckpointCount: number;
  stepMetadata: Record<string, unknown>;
}): Promise<void> {
  const {
    step,
    ctx,
    state,
    autonomyProfile,
    abortController,
    missionId,
    missionStepCheckpointCount,
    stepMetadata,
  } = params;

  if (
    step.toolCalls.length !== 0 ||
    typeof step.text !== "string" ||
    !hasTextToolCallMarkers(step.text) ||
    state.textToolCallFallbackAttempts >= MAX_TEXT_TOOL_CALL_FALLBACK_ATTEMPTS
  ) {
    return;
  }

  state.textToolCallFallbackAttempts += 1;
  try {
    const outcome = await runTextToolCallFallback({
      assistantText: step.text,
      ctx,
      autopilot:
        autonomyProfile === "full-autopilot-sandbox" ||
        autonomyProfile === "trusted-workspace",
    });
    if (outcome) {
      state.totalFallbackToolCalls += outcome.executed.length;
      if (outcome.reminder) {
        state.pendingUserMessages.push(outcome.reminder);
      }
      await logMissionEvent({
        missionId,
        eventType: "model_emitted_tool_call_as_text",
        summary: `Model emitted ${outcome.parsed.length} tool call(s) as text on step ${missionStepCheckpointCount}; recovered ${outcome.executed.length}, skipped ${outcome.failed.length}`,
        metadata: {
          ...stepMetadata,
          attempt: state.textToolCallFallbackAttempts,
          parsedToolNames: outcome.parsed.map((entry) => entry.toolName),
          executedToolNames: outcome.executed.map((entry) => entry.toolName),
          failedToolNames: outcome.failed.map((entry) => entry.toolName),
        },
      }).catch((err) =>
        logger.warn("Failed to log text-tool-call fallback event:", err),
      );
    }
  } catch (err) {
    logger.warn("Text-tool-call fallback threw unexpectedly:", err);
  }

  if (
    state.textToolCallFallbackAttempts >= MAX_TEXT_TOOL_CALL_FALLBACK_ATTEMPTS
  ) {
    state.warningMessages.push(
      "Model emitted tool calls as plain text repeatedly. Switch to a provider that supports function calling (OpenAI, Anthropic, Gemini, or a GGUF with a tool-call template) to continue.",
    );
    await logMissionEvent({
      missionId,
      eventType: "model_emitted_tool_call_as_text_abort_threshold",
      summary: "Aborting stream: model repeatedly emitted tool calls as text",
      metadata: {
        ...stepMetadata,
        attempts: state.textToolCallFallbackAttempts,
      },
    }).catch(() => {});
    abortController.abort();
  }
}
