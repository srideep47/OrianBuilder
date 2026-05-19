/**
 * Stream-chunk processor for the chat handler.
 *
 * Iterates over the AI SDK's fullStream and translates each part into the
 * orianbuilder-* XML chunks that the renderer expects. The MCP tool dispatch
 * also lives here — it's wired into the AI SDK as part of the tool set passed
 * to streamText.
 */

import type { IpcMainInvokeEvent } from "electron";
import type { TextStreamPart, ToolExecutionOptions, ToolSet } from "ai";

type AsyncIterableStream<T> = AsyncIterable<T> & ReadableStream<T>;
import log from "electron-log";
import { eq } from "drizzle-orm";

import { db } from "../../../db";
import { mcpServers } from "../../../db/schema";
import { mcpManager } from "../../utils/mcp_manager";
import { requireMcpToolConsent } from "../../utils/mcp_consent";
import {
  OrianBuilderError,
  OrianBuilderErrorKind,
} from "@/errors/orianbuilder_error";
import { cleanFullResponse } from "../../utils/cleanFullResponse";

import { escapeOrianBuilderTags, parseMcpToolKey } from "./chat_text_utils";

const logger = log.scope("chat_stream_handlers");

export async function processStreamChunks({
  fullStream,
  fullResponse,
  abortController,
  chatId,
  processResponseChunkUpdate,
}: {
  fullStream: AsyncIterableStream<TextStreamPart<ToolSet>>;
  fullResponse: string;
  abortController: AbortController;
  chatId: number;
  processResponseChunkUpdate: (params: {
    fullResponse: string;
  }) => Promise<string>;
}): Promise<{ fullResponse: string; incrementalResponse: string }> {
  let incrementalResponse = "";
  let inThinkingBlock = false;

  for await (const part of fullStream) {
    let chunk = "";
    if (
      inThinkingBlock &&
      !["reasoning-delta", "reasoning-end", "reasoning-start"].includes(
        part.type,
      )
    ) {
      chunk = "</think>";
      inThinkingBlock = false;
    }
    if (part.type === "text-delta") {
      chunk += part.text;
    } else if (part.type === "reasoning-delta") {
      if (!inThinkingBlock) {
        chunk = "<think>";
        inThinkingBlock = true;
      }

      chunk += escapeOrianBuilderTags(part.text);
    } else if (part.type === "tool-call") {
      const { serverName, toolName } = parseMcpToolKey(part.toolName);
      const content = escapeOrianBuilderTags(JSON.stringify(part.input));
      chunk = `<orianbuilder-mcp-tool-call server="${serverName}" tool="${toolName}">\n${content}\n</orianbuilder-mcp-tool-call>\n`;
    } else if (part.type === "tool-result") {
      const { serverName, toolName } = parseMcpToolKey(part.toolName);
      const content = escapeOrianBuilderTags(part.output);
      chunk = `<orianbuilder-mcp-tool-result server="${serverName}" tool="${toolName}">\n${content}\n</orianbuilder-mcp-tool-result>\n`;
    }

    if (!chunk) {
      continue;
    }

    fullResponse += chunk;
    incrementalResponse += chunk;
    fullResponse = cleanFullResponse(fullResponse);
    fullResponse = await processResponseChunkUpdate({
      fullResponse,
    });

    if (abortController.signal.aborted) {
      logger.log(`Stream for chat ${chatId} was aborted`);
      break;
    }
  }

  return { fullResponse, incrementalResponse };
}

export async function getMcpTools(event: IpcMainInvokeEvent): Promise<ToolSet> {
  const mcpToolSet: ToolSet = {};
  try {
    const servers = await db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.enabled, true as any));
    for (const s of servers) {
      const client = await mcpManager.getClient(s.id);
      const toolSet = await client.tools();
      for (const [name, mcpTool] of Object.entries(toolSet)) {
        const key = `${String(s.name || "").replace(/[^a-zA-Z0-9_-]/g, "-")}__${String(name).replace(/[^a-zA-Z0-9_-]/g, "-")}`;
        mcpToolSet[key] = {
          description: mcpTool.description,
          inputSchema: mcpTool.inputSchema,
          execute: async (args: unknown, execCtx: ToolExecutionOptions) => {
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

            if (!ok)
              throw new OrianBuilderError(
                `User declined running tool ${key}`,
                OrianBuilderErrorKind.UserCancelled,
              );
            const res = await mcpTool.execute(args, execCtx);

            return typeof res === "string" ? res : JSON.stringify(res);
          },
        };
      }
    }
  } catch (e) {
    logger.warn("Failed building MCP toolset", e);
  }
  return mcpToolSet;
}
