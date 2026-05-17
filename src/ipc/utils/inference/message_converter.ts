// Pure OpenAI ↔ plain-prompt message conversion utilities used by the
// TensorRT inference path. No side effects, no state.
//
// (Previously this module also converted to node-llama-cpp's chat history
// shape, but that path was retired when inference moved to the llama-server
// child process — llama-server consumes OpenAI messages directly.)

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OpenAIMessage {
  role: string;
  content?: unknown;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

export function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

export function stringifyOpenAIContent(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (typeof content === "number" || typeof content === "boolean") {
    return String(content);
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part == null) return "";
        if (typeof part === "string") return part;
        if (typeof part === "number" || typeof part === "boolean") {
          return String(part);
        }
        if (typeof part === "object") {
          const typedPart = part as Record<string, unknown>;
          if (typeof typedPart.text === "string") return typedPart.text;
          if (typeof typedPart.value === "string") return typedPart.value;
          if (typedPart.type === "image" || typedPart.type === "image_url") {
            return "[image]";
          }
          return safeJsonStringify(typedPart);
        }
        return String(part);
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof content === "object") return safeJsonStringify(content);
  return String(content);
}

export function stripThinkingBlocks(text: string): {
  visibleText: string;
  removedThinking: boolean;
} {
  if (!text.includes("<think>")) {
    return { visibleText: text, removedThinking: false };
  }

  let visibleText = "";
  let cursor = 0;
  let removedThinking = false;
  while (cursor < text.length) {
    const openIndex = text.indexOf("<think>", cursor);
    if (openIndex === -1) {
      visibleText += text.slice(cursor);
      break;
    }
    visibleText += text.slice(cursor, openIndex);
    removedThinking = true;
    const closeIndex = text.indexOf("</think>", openIndex + 7);
    if (closeIndex === -1) {
      break;
    }
    cursor = closeIndex + 8;
  }

  return { visibleText, removedThinking };
}

export function createThinkingStripper() {
  let inThink = false;
  let pending = "";

  const longestTagSuffix = (text: string, tag: string) => {
    for (let len = Math.min(tag.length - 1, text.length); len > 0; len -= 1) {
      const suffix = text.slice(-len);
      if (tag.startsWith(suffix)) return suffix;
    }
    return "";
  };

  return {
    push(chunk: string): {
      visibleText: string;
      enteredThinking: boolean;
      exitedThinking: boolean;
    } {
      const openTag = "<think>";
      const closeTag = "</think>";
      const input = pending + chunk;
      pending = "";
      let visibleText = "";
      let enteredThinking = false;
      let exitedThinking = false;
      let cursor = 0;

      while (cursor < input.length) {
        if (inThink) {
          const closeIndex = input.indexOf(closeTag, cursor);
          if (closeIndex === -1) {
            pending = longestTagSuffix(input.slice(cursor), closeTag);
            break;
          }
          cursor = closeIndex + closeTag.length;
          inThink = false;
          exitedThinking = true;
          continue;
        }

        const openIndex = input.indexOf(openTag, cursor);
        if (openIndex === -1) {
          const tail = input.slice(cursor);
          pending = longestTagSuffix(tail, openTag);
          visibleText += tail.slice(0, tail.length - pending.length);
          break;
        }

        visibleText += input.slice(cursor, openIndex);
        cursor = openIndex + openTag.length;
        inThink = true;
        enteredThinking = true;
      }

      return { visibleText, enteredThinking, exitedThinking };
    },
    flush(): string {
      if (inThink) {
        pending = "";
        return "";
      }
      const visibleText = pending;
      pending = "";
      return visibleText;
    },
  };
}

export function estimateOpenAIRequestTokens(
  rawMessages: OpenAIMessage[],
  payload?: { tools?: unknown },
): number {
  const messageChars = rawMessages.reduce((sum, message) => {
    const content = stringifyOpenAIContent(message.content);
    let chars =
      (message.role === "assistant"
        ? stripThinkingBlocks(content).visibleText.length
        : content.length) +
      message.role.length +
      8;
    if (message.tool_calls)
      chars += safeJsonStringify(message.tool_calls).length;
    if (message.tool_call_id) chars += message.tool_call_id.length;
    return sum + chars;
  }, 0);
  const toolChars = payload?.tools
    ? safeJsonStringify(payload.tools).length
    : 0;
  return Math.ceil((messageChars + toolChars) / 4);
}

export function openAiToPlainPrompt(rawMessages: OpenAIMessage[]): {
  system: string;
  prompt: string;
} {
  const system = rawMessages
    .filter((m) => m.role === "system")
    .map((m) => stringifyOpenAIContent(m.content))
    .join("\n\n");
  const turns = rawMessages
    .filter((m) => m.role !== "system")
    .map((m) => {
      const rawContent = stringifyOpenAIContent(m.content);
      const content =
        m.role === "assistant"
          ? stripThinkingBlocks(rawContent).visibleText.trim()
          : rawContent;
      if (m.role === "assistant") return `Assistant: ${content}`;
      if (m.role === "tool") return `Tool: ${content}`;
      return `User: ${content}`;
    });
  return {
    system,
    prompt: `${turns.join("\n\n")}\n\nAssistant:`,
  };
}

export function sseChunk(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}
