/**
 * Streaming-loop helpers for the local-agent.
 *
 * The streamText loop in AgentStreamRunner.ts iterates over the AI SDK's
 * fullStream and translates each part into either user-visible text chunks
 * (which get appended to fullResponse and forwarded over IPC) or tool-call
 * lifecycle events (which get rendered as XML in the UI). The translation
 * is mechanical but verbose, so it lives here.
 */

import type { AgentContext } from "../tools/types";
import { parsePartialJson } from "../tools/types";
import {
  cleanupStreamingEntry,
  findToolDefinition,
  getOrCreateStreamingEntry,
} from "./AgentStepProcessor";
import {
  maybeCaptureRetryReplayEvent,
  maybeCaptureRetryReplayText,
  type RetryReplayEvent,
} from "../retry_replay_utils";
import type { StreamDiagnostics } from "../stream_diagnostics";

export const STREAM_STALL_TIMEOUT_MS = 90_000;

export type StreamPartState = {
  inThinkingBlock: boolean;
  passProducedChatText: boolean;
  attemptToolInputIds: Set<string>;
};

/**
 * Resolve the per-attempt stall timeout from user settings.
 *
 * Clamped to [30s, 300s]; defaults to 90s when unset.
 */
export function resolveStreamStallTimeoutMs(
  settingValueSeconds: number | undefined,
): number {
  return Math.max(
    30_000,
    Math.min(300_000, (settingValueSeconds ?? 90) * 1000),
  );
}

/**
 * AI SDK fullStream part — typed loosely because the SDK's actual part union
 * is complex and varies by part.type. The dispatch logic below narrows each
 * branch by reading the specific fields it needs.
 */
export type StreamPart = { type: string } & Record<string, unknown>;

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Process a single AI SDK stream part, accumulating side effects on `state`
 * and returning the user-visible text chunk (possibly empty) to append to
 * the running response.
 */
export function processStreamPart(params: {
  part: StreamPart;
  state: StreamPartState;
  ctx: AgentContext;
  diagnostics: StreamDiagnostics;
  activeRetryReplayEvents: RetryReplayEvent[];
  attemptRetryReplayEvents: RetryReplayEvent[];
}): string {
  const {
    part,
    state,
    ctx,
    diagnostics,
    activeRetryReplayEvents,
    attemptRetryReplayEvents,
  } = params;

  let chunk = "";

  // Close an open <think> block when the model switches away from reasoning.
  if (
    state.inThinkingBlock &&
    !["reasoning-delta", "reasoning-end", "reasoning-start"].includes(part.type)
  ) {
    chunk = "</think>\n";
    state.inThinkingBlock = false;
  }

  switch (part.type) {
    case "text-delta": {
      state.passProducedChatText = true;
      const text = asString(part.text);
      chunk += text;
      diagnostics.observeText(text);
      maybeCaptureRetryReplayText(activeRetryReplayEvents, text);
      break;
    }

    case "reasoning-start":
      if (!state.inThinkingBlock) {
        chunk = "<think>";
        state.inThinkingBlock = true;
      }
      break;

    case "reasoning-delta":
      if (!state.inThinkingBlock) {
        chunk = "<think>";
        state.inThinkingBlock = true;
      }
      chunk += asString(part.text);
      break;

    case "reasoning-end":
      if (state.inThinkingBlock) {
        chunk = "</think>\n";
        state.inThinkingBlock = false;
      }
      break;

    case "tool-input-start": {
      const id = asString(part.id);
      const toolName = asString(part.toolName);
      getOrCreateStreamingEntry(id, toolName);
      state.attemptToolInputIds.add(id);
      break;
    }

    case "tool-input-delta": {
      const id = asString(part.id);
      const entry = getOrCreateStreamingEntry(id);
      if (entry) {
        entry.argsAccumulated += asString(part.delta);
        const toolDef = findToolDefinition(entry.toolName);
        if (toolDef?.buildXml) {
          const argsPartial = parsePartialJson(entry.argsAccumulated);
          const xml = toolDef.buildXml(argsPartial, false);
          if (xml) {
            ctx.onXmlStream(xml);
          }
        }
      }
      break;
    }

    case "tool-input-end": {
      const id = asString(part.id);
      const entry = getOrCreateStreamingEntry(id);
      if (entry) {
        const toolDef = findToolDefinition(entry.toolName);
        if (toolDef?.buildXml) {
          const argsPartial = parsePartialJson(entry.argsAccumulated);
          const xml = toolDef.buildXml(argsPartial, true);
          if (xml) {
            ctx.onXmlComplete(xml);
          }
        }
      }
      cleanupStreamingEntry(id);
      state.attemptToolInputIds.delete(id);
      break;
    }

    case "tool-call":
      diagnostics.observeToolCall();
      maybeCaptureRetryReplayEvent(attemptRetryReplayEvents, part);
      break;

    case "tool-result":
      maybeCaptureRetryReplayEvent(attemptRetryReplayEvents, part);
      break;
  }

  return chunk;
}
