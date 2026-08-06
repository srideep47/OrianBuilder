/**
 * Final renderer boundary for assistant text.
 *
 * Main already keeps tool protocol separate from narration, but persisted
 * conversations and older/local providers can still contain protocol markup.
 * The Stage must fail closed: a malformed tool frame is omitted rather than
 * shown as if it were Marta speaking.
 */
export function sanitizeAssistantPresentation(value: string): string {
  return value
    .replace(/<tool_call\b[^>]*>[\s\S]*?<\/tool_call>/gi, "")
    .replace(/<tool_result\b[^>]*>[\s\S]*?<\/tool_result>/gi, "")
    .replace(/<tool_call\b[^>]*>[\s\S]*$/gi, "")
    .replace(/<tool_result\b[^>]*>[\s\S]*$/gi, "")
    .replace(
      /<\/?(?:function|tool|system|developer|assistant|analysis|scratchpad)\b[^>]*>/gi,
      "",
    )
    .replace(
      /^\s*(?:system|developer|internal(?: prompt)?|hidden instruction)\s*:\s*.*$/gim,
      "",
    )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
