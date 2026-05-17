import log from "electron-log";

import { TOOL_DEFINITIONS } from "./tool_definitions";
import type { AgentContext, UserMessageContentPart } from "./tools/types";
import {
  parseTextToolCalls,
  type ParsedTextToolCall,
} from "./text_tool_call_parser";

const logger = log.scope("text_tool_call_executor");

export interface TextToolCallExecutionOutcome {
  parsed: ParsedTextToolCall[];
  executed: Array<{
    toolName: string;
    args: Record<string, unknown>;
    result: string;
    durationMs: number;
  }>;
  failed: Array<{
    toolName: string;
    args: Record<string, unknown>;
    error: string;
  }>;
  reminder: UserMessageContentPart[] | null;
}

export interface RunTextToolCallFallbackInput {
  assistantText: string;
  ctx: AgentContext;
  autopilot: boolean;
}

/**
 * Detects tool calls emitted as plain text by the model, executes the ones we
 * can safely run (read-only always; write tools only when autopilot is on),
 * and returns a synthetic user message that re-grounds the model in the
 * correct tool-call format.
 *
 * Returns `null` when no text tool calls were detected — callers can fast-skip
 * this branch without paying the parsing cost.
 */
export async function runTextToolCallFallback(
  input: RunTextToolCallFallbackInput,
): Promise<TextToolCallExecutionOutcome | null> {
  const knownToolNames = TOOL_DEFINITIONS.map((tool) => tool.name);
  const parsed = parseTextToolCalls({
    text: input.assistantText,
    knownToolNames,
  });
  if (parsed.length === 0) return null;

  const outcome: TextToolCallExecutionOutcome = {
    parsed,
    executed: [],
    failed: [],
    reminder: null,
  };

  for (const call of parsed) {
    const definition = TOOL_DEFINITIONS.find(
      (tool) => tool.name === call.toolName,
    );
    if (!definition) continue;

    // Validate args against the tool's zod schema. Skip the call entirely if
    // the parsed args don't satisfy the contract — better to nudge the model
    // back to a real tool call than to execute with corrupted input.
    const parsedArgs = definition.inputSchema.safeParse(call.args);
    if (!parsedArgs.success) {
      outcome.failed.push({
        toolName: call.toolName,
        args: call.args,
        error: `Args did not match the tool's schema: ${parsedArgs.error.message.slice(0, 280)}`,
      });
      continue;
    }

    const isWriteTool = !!definition.modifiesState;
    if (isWriteTool && !input.autopilot) {
      outcome.failed.push({
        toolName: call.toolName,
        args: parsedArgs.data as Record<string, unknown>,
        error:
          "Skipped fallback execution because the tool modifies state and the mission is not in autopilot. Re-emit this call using the structured tool-call interface.",
      });
      continue;
    }

    const start = Date.now();
    try {
      const result = await definition.execute(parsedArgs.data, input.ctx);
      outcome.executed.push({
        toolName: call.toolName,
        args: parsedArgs.data as Record<string, unknown>,
        result: typeof result === "string" ? result : JSON.stringify(result),
        durationMs: Date.now() - start,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      outcome.failed.push({
        toolName: call.toolName,
        args: parsedArgs.data as Record<string, unknown>,
        error: message,
      });
      logger.warn(
        `Text tool-call fallback failed for ${call.toolName}:`,
        message,
      );
    }
  }

  outcome.reminder = buildReminderMessage(outcome);
  return outcome;
}

function buildReminderMessage(
  outcome: TextToolCallExecutionOutcome,
): UserMessageContentPart[] {
  const lines: string[] = [];
  lines.push(
    "[Auto-recovery] Your previous turn emitted one or more tool calls as plain TEXT (e.g. `<set_chat_summary>{...}` or ```json blocks). Your runtime does not execute text tool calls — only structured tool calls produced through your provider's function-calling interface work.",
  );

  if (outcome.executed.length > 0) {
    lines.push("");
    lines.push(
      "The system tried to recover by parsing and running these on your behalf. Treat the results as if you had called the tools yourself:",
    );
    for (const entry of outcome.executed) {
      const argsPreview = JSON.stringify(entry.args).slice(0, 400);
      const resultPreview = entry.result.slice(0, 800);
      lines.push("");
      lines.push(`- tool: ${entry.toolName}`);
      lines.push(`  args: ${argsPreview}`);
      lines.push(`  result: ${resultPreview}`);
    }
  }

  if (outcome.failed.length > 0) {
    lines.push("");
    lines.push(
      "These could NOT be executed automatically — re-issue them as proper tool calls if you still want them:",
    );
    for (const entry of outcome.failed) {
      const argsPreview = JSON.stringify(entry.args).slice(0, 400);
      lines.push("");
      lines.push(`- tool: ${entry.toolName}`);
      lines.push(`  args: ${argsPreview}`);
      lines.push(`  error: ${entry.error}`);
    }
  }

  lines.push("");
  lines.push(
    "From now on, ALWAYS invoke tools through the structured tool-call mechanism your provider exposes. Do not paste tool-call XML or JSON into your prose. If your provider does not surface a function-call API, request an `update_todos` call first and the runtime will treat that as the signal that you are tool-call capable.",
  );

  return [{ type: "text", text: lines.join("\n") }];
}
