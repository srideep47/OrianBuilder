/**
 * Stream diagnostics — captures structural info about a single agent stream
 * so the user can diagnose model-integration issues (tool calls emitted as
 * text, thinking-block leaks, unexpected stop, etc.).
 *
 * The summary is logged at INFO level at the end of each stream attempt
 * and is meant to be copy-pasteable into a bug report.
 */

import log from "electron-log";

const logger = log.scope("stream_diagnostics");

/**
 * Patterns that indicate the model's tool-calling format isn't being
 * understood by the AI SDK and is leaking into text. Each match suggests
 * the inference server's tool-call parser isn't configured correctly for
 * the model (e.g., LM Studio running Qwen 3.6 without the fixed chat
 * template — see docs/integrations/qwen-lm-studio.md).
 */
const SUSPICIOUS_TEXT_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "qwen_tool_call_tag", re: /<tool_call\b/i },
  { name: "qwen_pipe_tool_call", re: /\|\|call\|/i },
  { name: "qwen_thinking_open", re: /<think\b/i },
  { name: "qwen_thinking_alt", re: /<thinking\b/i },
  {
    name: "qwen_system_reminder",
    re: /<system[-_]reminder\b/i,
  },
  { name: "function_call_json", re: /"function"\s*:\s*\{/ },
  { name: "tool_use_block", re: /<\|tool_call_begin\|>/i },
];

export interface StreamDiagnosticsRecord {
  attemptId: string;
  modelName: string;
  modelProvider: string;
  isQwen: boolean;
  samplingParams: {
    temperature?: number;
    topP?: number;
    topK?: number;
    presencePenalty?: number;
    maxOutputTokens?: number;
  };
  partTypeCounts: Record<string, number>;
  toolCallCount: number;
  textCharCount: number;
  suspiciousTextHits: Record<string, number>;
  finishReason?: string;
  durationMs: number;
}

export class StreamDiagnostics {
  private record: StreamDiagnosticsRecord;
  private startedAt: number;
  private textBuffer: string = "";

  constructor(init: {
    attemptId: string;
    modelName: string;
    modelProvider: string;
    isQwen: boolean;
    samplingParams: StreamDiagnosticsRecord["samplingParams"];
  }) {
    this.startedAt = Date.now();
    this.record = {
      ...init,
      partTypeCounts: Object.create(null),
      toolCallCount: 0,
      textCharCount: 0,
      suspiciousTextHits: Object.create(null),
      durationMs: 0,
    };
  }

  observePart(partType: string): void {
    const counts = this.record.partTypeCounts;
    counts[partType] = (counts[partType] ?? 0) + 1;
  }

  observeText(text: string): void {
    if (!text) return;
    this.record.textCharCount += text.length;
    // Keep a sliding window of text so we don't blow up memory on long runs.
    this.textBuffer = (this.textBuffer + text).slice(-32_000);
  }

  observeToolCall(): void {
    this.record.toolCallCount += 1;
  }

  setFinishReason(reason: string): void {
    this.record.finishReason = reason;
  }

  finalize(): StreamDiagnosticsRecord {
    this.record.durationMs = Date.now() - this.startedAt;
    for (const pattern of SUSPICIOUS_TEXT_PATTERNS) {
      const matches = this.textBuffer.match(new RegExp(pattern.re, "gi"));
      if (matches && matches.length > 0) {
        this.record.suspiciousTextHits[pattern.name] = matches.length;
      }
    }
    return this.record;
  }

  emit(level: "info" | "warn" = "info"): void {
    const final = this.finalize();
    const summary = {
      attempt: final.attemptId,
      model: `${final.modelProvider}:${final.modelName}`,
      isQwen: final.isQwen,
      sampling: final.samplingParams,
      parts: final.partTypeCounts,
      toolCalls: final.toolCallCount,
      textChars: final.textCharCount,
      suspicious: final.suspiciousTextHits,
      finishReason: final.finishReason,
      durationMs: final.durationMs,
    };
    if (level === "warn") {
      logger.warn("Stream diagnostics:", JSON.stringify(summary));
    } else {
      logger.info("Stream diagnostics:", JSON.stringify(summary));
    }

    // If any suspicious pattern fired, also surface a hint about likely
    // misconfiguration so the user knows where to look.
    const suspicious = Object.keys(final.suspiciousTextHits);
    if (suspicious.length > 0) {
      logger.warn(
        `Possible model-integration issue — model output contains tokens that ` +
          `look like a tool-call/thinking format leaking into text: ${suspicious.join(", ")}. ` +
          `If using Qwen 3.x via LM Studio, see docs/integrations/qwen-lm-studio.md ` +
          `for the chat-template fix.`,
      );
    }
  }
}
