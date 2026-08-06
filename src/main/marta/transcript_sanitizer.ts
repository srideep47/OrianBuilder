/** Text used when a model returned only hidden protocol instead of an answer. */
export const MARTA_UNSAFE_OUTPUT_FALLBACK =
  "I couldn't complete that turn because the model returned an invalid internal tool command.";

const COMPLETE_PROTOCOL_BLOCKS: RegExp[] = [
  /<tool_call\b[^>]*>[\s\S]*?<\/tool_call\s*>/gi,
  /<function(?:\s+[^>]*|=[^>]*)?>[\s\S]*?<\/function\s*>/gi,
  /<(system|developer|analysis|internal(?:_instructions?)?)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
  /<\|tool_call_begin\|>[\s\S]*?<\|tool_call_end\|>/gi,
  /<｜tool▁call▁begin｜>[\s\S]*?<｜tool▁call▁end｜>/gi,
  /<\|im_start\|>\s*(?:system|developer|tool|analysis)\b[\s\S]*?<\|im_end\|>/gi,
  /```(?:tool|tool_call|function)\s*[\r\n]+[\s\S]*?```/gi,
];

const INTERNAL_DIRECTIVES: RegExp[] = [
  /(^|\s)(?:do not|don't)\s+(?:claim|delegate|show|expose|reveal|print|display)\b[^.?!]*(?:[.?!]|$)/gi,
  /(^|\s)(?:tell the user|ask the user|say so|offer to|briefly ask|continue the user's request|use real tool calls|never output tool calls)\b[^.?!]*(?:[.?!]|$)/gi,
  /(^|\s)the (?:model|assistant) should\b[^.?!]*(?:[.?!]|$)/gi,
];

const PROMPT_LEAK_MARKERS = [
  "you are marta, the orchestrator of orion",
  "--- what is true right now ---",
  "<tool_calling>",
  "<tool_calling_best_practices>",
];

/**
 * Remove model/tool protocol and prompt-only directives from user-visible text.
 *
 * This is deliberately a display-boundary filter, not a parser for tool calls.
 * A malformed text tool call must remain unexecuted; the filter merely ensures
 * that XML, ChatML control tokens, and private instructions never become chat
 * transcript or speech.
 */
export function sanitizeMartaTranscriptText(rawText: string): string {
  let text = rawText.replace(/\u0000/g, "");

  for (const block of COMPLETE_PROTOCOL_BLOCKS) text = text.replace(block, " ");

  // If a model omitted the closing token, hide from the first protocol marker
  // onward. Keeping a prefix is safe and more useful than discarding a normal
  // sentence that preceded the malformed call.
  const unclosedProtocol =
    /<tool_call\b|<function(?:\s|=)|<\|tool_call|<｜tool▁call|<\|im_start\|>\s*(?:system|developer|tool|analysis)\b|```(?:tool|tool_call|function)\b/i.exec(
      text,
    );
  if (unclosedProtocol?.index !== undefined) {
    text = text.slice(0, unclosedProtocol.index);
  }

  // Remove orphaned control tags/tokens left by malformed nesting.
  text = text
    .replace(
      /<\/?(?:tool_call|function|system|developer|analysis|internal(?:_instructions?)?)(?:\s+[^>]*|=[^>]*)?>/gi,
      " ",
    )
    .replace(
      /<\|(?:im_start|im_end|tool_call_begin|tool_call_end|tool_call)\|>/gi,
      " ",
    )
    .replace(/<｜tool▁call▁(?:begin|end)｜>/gi, " ");

  const lower = text.toLowerCase();
  const promptLeakIndex = PROMPT_LEAK_MARKERS.reduce((earliest, marker) => {
    const index = lower.indexOf(marker);
    return index >= 0 && (earliest < 0 || index < earliest) ? index : earliest;
  }, -1);
  if (promptLeakIndex >= 0) text = text.slice(0, promptLeakIndex);

  // `[System]` is used by fallback executors as a model-facing repair message.
  // It and everything after it are private protocol, never narration.
  const systemLine = /(?:^|\n)\s*\[system\]/i.exec(text);
  if (systemLine?.index !== undefined) text = text.slice(0, systemLine.index);
  text = text.replace(
    /(?:^|\n)\s*(?:system|developer|internal instructions?)\s*:\s*[^\n]*(?=\n|$)/gi,
    "\n",
  );

  for (const directive of INTERNAL_DIRECTIVES)
    text = text.replace(directive, "$1");

  return text
    .replace(/[\t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+([,.;!?])/g, "$1")
    .trim();
}

/**
 * Drop the model-facing task-id clause from a delegate summary.
 *
 * The id belongs in the tool result, where Marta needs it to refer to the task
 * later, and in the `taskId` contract field, where the Stage needs it to follow
 * exactly this delegation. It does not belong in the conversation: a spoken
 * reply that recites "claude:4b526aed-e359-4e7a-bd74-2758e3dae5e8" is unusable,
 * and a transcript full of GUIDs is unreadable.
 */
export function withoutTaskIdClause(summary: string): string {
  return summary.replace(/\s*Task id:\s*\S+?\.(?=\s|$)/g, "").trim();
}

/** Return safe text, or a truthful fallback when protocol was the whole reply. */
export function safeMartaAssistantText(rawText: string): string {
  const safe = sanitizeMartaTranscriptText(rawText);
  return safe || (rawText.trim() ? MARTA_UNSAFE_OUTPUT_FALLBACK : "");
}

/**
 * Sentence-buffered sanitizer for streamed narration.
 *
 * Buffering one sentence prevents a split marker (`<tool_` then `call>`) or a
 * split directive (`Do not` then `claim`) from flashing on screen before the
 * final response can be checked. It also matches the voice bus, which begins
 * speaking at complete-sentence boundaries.
 */
export class MartaTranscriptDeltaSanitizer {
  private buffer = "";

  push(chunk: string): string[] {
    this.buffer += chunk;
    return this.drain(false);
  }

  finish(): string[] {
    return this.drain(true);
  }

  private drain(flush: boolean): string[] {
    const output: string[] = [];
    while (this.buffer) {
      const boundary = this.findSentenceBoundary(this.buffer);
      if (boundary < 0 && !flush) break;
      const end = boundary < 0 ? this.buffer.length : boundary;
      const rawSegment = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end);
      const safe = sanitizeMartaTranscriptText(rawSegment);
      if (!safe) continue;
      const prefix = output.length > 0 || /^\s/.test(rawSegment) ? " " : "";
      output.push(`${prefix}${safe}`);
    }
    return output;
  }

  private findSentenceBoundary(value: string): number {
    for (let index = 0; index < value.length; index += 1) {
      const character = value[index];
      if (character === "\n") return index + 1;
      if (character === "." || character === "!" || character === "?") {
        const next = value[index + 1];
        if (next === undefined || /\s/.test(next)) return index + 1;
      }
    }
    return -1;
  }
}
