import { jsonrepair } from "jsonrepair";

/**
 * Parses tool calls that a model emitted as plain text rather than through the
 * AI SDK's structured tool-call protocol. Common cases:
 *
 *  1. Local GGUFs (Qwen, DeepSeek, Llama 3.x variants without function-call
 *     fine-tuning) that emit OrianBuilder XML tags directly:
 *        <set_chat_summary>{"summary": "..."}</set_chat_summary>
 *        <set_chat_summary>{"summary": "..."}            (unterminated)
 *
 *  2. Hermes/Functionary tool-call format:
 *        <tool_call>{"name": "X", "arguments": {...}}</tool_call>
 *
 *  3. Markdown code block carrying a JSON envelope:
 *        ```json
 *        {"tool": "X", "arguments": {...}}
 *        ```
 *
 *  4. Plain JSON line:
 *        {"name": "set_chat_summary", "arguments": {"summary": "..."}}
 *
 * The parser is intentionally permissive: it uses `jsonrepair` to tolerate
 * mid-string truncation, missing closing braces, smart quotes, and trailing
 * commas — all common in local-model output.
 */

export interface ParsedTextToolCall {
  toolName: string;
  args: Record<string, unknown>;
  /** Source format used to detect this call. */
  source:
    | "named_xml_tag"
    | "tool_call_envelope"
    | "json_code_block"
    | "plain_json"
    | "orianbuilder_tool_tag";
  /** The exact raw substring of the assistant text that produced this call. */
  raw: string;
}

const NAMED_XML_TAG_PATTERN = (toolName: string) => {
  const escaped = toolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Matches `<tool>{json}</tool>`, `<tool>{json}` (unterminated), or
  // `<tool>` followed by a JSON-shaped chunk.
  return new RegExp(
    `<${escaped}>\\s*(\\{[\\s\\S]*?\\})(?:\\s*<\\/${escaped}>|(?=\\n\\n|<|$))`,
    "g",
  );
};

const TOOL_CALL_ENVELOPE_PATTERN =
  /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g;
const JSON_CODE_BLOCK_PATTERN =
  /```(?:json|tool|tool_call)\s*\n([\s\S]*?)\n\s*```/g;
const ORIANBUILDER_TOOL_TAG_PATTERN =
  /<orianbuilder-tool\s+name="([^"]+)"[^>]*>\s*(\{[\s\S]*?\})\s*<\/orianbuilder-tool>/g;

function tryParseJson(input: string): Record<string, unknown> | null {
  if (!input || typeof input !== "string") return null;
  try {
    const repaired = jsonrepair(input);
    const parsed = JSON.parse(repaired);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function normalizeEnvelope(parsed: Record<string, unknown>): {
  name: string | null;
  args: Record<string, unknown>;
} {
  const name =
    (typeof parsed.name === "string" && parsed.name) ||
    (typeof parsed.tool === "string" && parsed.tool) ||
    (typeof parsed.tool_name === "string" && parsed.tool_name) ||
    null;
  const rawArgs =
    parsed.arguments ?? parsed.args ?? parsed.input ?? parsed.parameters;
  let args: Record<string, unknown> = {};
  if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)) {
    args = rawArgs as Record<string, unknown>;
  } else if (typeof rawArgs === "string") {
    args = tryParseJson(rawArgs) ?? {};
  } else {
    // If the envelope has neither name nor arguments keys, treat the whole
    // payload (minus name) as args — common in raw plain_json emissions.
    const { name: _omit, tool: _omit2, tool_name: _omit3, ...rest } = parsed;
    args = rest as Record<string, unknown>;
  }
  return { name: name ? name.trim() : null, args };
}

/**
 * Parse assistant text and return any tool calls embedded as plain text. The
 * caller passes the list of valid tool names so we never invent a fake tool.
 */
export function parseTextToolCalls(input: {
  text: string;
  knownToolNames: readonly string[];
}): ParsedTextToolCall[] {
  if (!input.text) return [];

  const knownSet = new Set(input.knownToolNames);
  const found: ParsedTextToolCall[] = [];
  const seenRaw = new Set<string>();

  const pushIfNew = (call: ParsedTextToolCall) => {
    const key = `${call.toolName}|${call.raw}`;
    if (seenRaw.has(key)) return;
    seenRaw.add(key);
    found.push(call);
  };

  // 1. <orianbuilder-tool name="X">{...}</orianbuilder-tool>
  for (const match of input.text.matchAll(ORIANBUILDER_TOOL_TAG_PATTERN)) {
    const [raw, toolName, jsonChunk] = match;
    if (!knownSet.has(toolName)) continue;
    const args = tryParseJson(jsonChunk);
    if (args) {
      pushIfNew({
        toolName,
        args,
        source: "orianbuilder_tool_tag",
        raw,
      });
    }
  }

  // 2. <tool_call>{"name":"X","arguments":{...}}</tool_call>
  for (const match of input.text.matchAll(TOOL_CALL_ENVELOPE_PATTERN)) {
    const [raw, envelope] = match;
    const parsed = tryParseJson(envelope);
    if (!parsed) continue;
    const { name, args } = normalizeEnvelope(parsed);
    if (name && knownSet.has(name)) {
      pushIfNew({
        toolName: name,
        args,
        source: "tool_call_envelope",
        raw,
      });
    }
  }

  // 3. ```json\n{"tool":"X","arguments":{...}}\n```
  for (const match of input.text.matchAll(JSON_CODE_BLOCK_PATTERN)) {
    const [raw, body] = match;
    const parsed = tryParseJson(body);
    if (!parsed) continue;
    const { name, args } = normalizeEnvelope(parsed);
    if (name && knownSet.has(name)) {
      pushIfNew({
        toolName: name,
        args,
        source: "json_code_block",
        raw,
      });
    }
  }

  // 4. <known_tool_name>{...}</known_tool_name>  (Qwen failure mode)
  for (const toolName of input.knownToolNames) {
    // Cheap pre-check before regex.
    if (!input.text.includes(`<${toolName}>`)) continue;
    const pattern = NAMED_XML_TAG_PATTERN(toolName);
    for (const match of input.text.matchAll(pattern)) {
      const [raw, jsonChunk] = match;
      const args = tryParseJson(jsonChunk);
      if (args) {
        pushIfNew({
          toolName,
          args,
          source: "named_xml_tag",
          raw,
        });
      }
    }
  }

  return found;
}

/**
 * Returns true if the assistant text plausibly contains a tool-call attempt
 * (used for telemetry / mission events). Cheaper than a full parse — only
 * checks for the well-known markers.
 */
export function hasTextToolCallMarkers(text: string): boolean {
  if (!text) return false;
  return (
    text.includes("<tool_call>") ||
    text.includes("<orianbuilder-tool ") ||
    /```(?:json|tool|tool_call)\s*\n/.test(text) ||
    /<(?:set_chat_summary|update_todos|write_file|read_file|run_terminal_command|create_project|search_replace)>/.test(
      text,
    )
  );
}
