import { createHash } from "node:crypto";
import type { ModelMessage } from "ai";

import { TOOL_DEFINITIONS } from "../tool_definitions";
import { setChatSummaryTool } from "../tools/set_chat_summary";
import { hasIncompleteTodos } from "../prepare_step_utils";
import { StreamStalledError } from "../streaming/stall_detector";
import type { AgentContext } from "../tools/types";

// ============================================================================
// Tool Streaming State Management
// ============================================================================

/**
 * Track streaming state per tool call ID
 */
interface ToolStreamingEntry {
  toolName: string;
  argsAccumulated: string;
}
const toolStreamingEntries = new Map<string, ToolStreamingEntry>();

export function getOrCreateStreamingEntry(
  id: string,
  toolName?: string,
): ToolStreamingEntry | undefined {
  let entry = toolStreamingEntries.get(id);
  if (!entry && toolName) {
    entry = {
      toolName,
      argsAccumulated: "",
    };
    toolStreamingEntries.set(id, entry);
  }
  return entry;
}

export function cleanupStreamingEntry(id: string): void {
  toolStreamingEntries.delete(id);
}

export function findToolDefinition(toolName: string) {
  return TOOL_DEFINITIONS.find((t) => t.name === toolName);
}

type PlainTextToolCall = {
  toolName: string;
  args: Record<string, unknown>;
  signature: string;
};

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function parsePlainTextToolAttributes(value: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const attrPattern = /([a-zA-Z0-9_-]+)="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = attrPattern.exec(value)) !== null) {
    args[match[1]] = decodeXmlText(match[2]).trim();
  }
  return args;
}

function parsePlainTextToolArgs(
  attributes: string,
  body: string,
): Record<string, unknown> {
  const args = parsePlainTextToolAttributes(attributes);
  const childPattern = /<([a-zA-Z0-9_-]+)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g;
  let match: RegExpExecArray | null;
  let childCount = 0;
  while ((match = childPattern.exec(body)) !== null) {
    childCount += 1;
    args[match[1]] = decodeXmlText(match[2]).trim();
  }

  const trimmedBody = decodeXmlText(body).trim();
  if (childCount === 0 && trimmedBody.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmedBody) as Record<string, unknown>;
      return { ...args, ...parsed };
    } catch {
      return args;
    }
  }

  return args;
}

export function extractPlainTextToolCall(input: {
  text: string;
  availableToolNames: Set<string>;
  alreadyExecuted: Set<string>;
}): PlainTextToolCall | null {
  const pattern = /<([a-zA-Z][a-zA-Z0-9_]*)(\s[^>]*)?>([\s\S]*?)<\/\1>/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(input.text)) !== null) {
    const toolName = match[1];
    if (
      !input.availableToolNames.has(toolName) ||
      toolName === setChatSummaryTool.name
    ) {
      continue;
    }

    const toolDef = findToolDefinition(toolName);
    if (!toolDef) continue;

    const rawArgs = parsePlainTextToolArgs(match[2] ?? "", match[3] ?? "");
    const parsedArgs = toolDef.inputSchema.safeParse(rawArgs);
    if (!parsedArgs.success) {
      continue;
    }

    const signature = `${toolName}:${JSON.stringify(parsedArgs.data)}`;
    if (input.alreadyExecuted.has(signature)) {
      continue;
    }

    return {
      toolName,
      args: parsedArgs.data as Record<string, unknown>,
      signature,
    };
  }

  return null;
}

export function stringifyManualToolResult(result: unknown): string {
  if (
    result &&
    typeof result === "object" &&
    "type" in result &&
    (result as { type?: unknown }).type === "text" &&
    "value" in result
  ) {
    return String((result as { value?: unknown }).value ?? "");
  }
  return typeof result === "string" ? result : JSON.stringify(result, null, 2);
}

export const PLANNING_QUESTIONNAIRE_TOOL_NAME = "planning_questionnaire";
export const MAX_TERMINATED_STREAM_RETRIES = 3;
export const STREAM_RETRY_BASE_DELAY_MS = 400;
const STREAM_CONTINUE_MESSAGE =
  "[System] Your previous response stream was interrupted by a transient network error. Continue from exactly where you left off and do not repeat text that has already been sent.";

const RETRYABLE_STREAM_ERROR_STATUS_CODES = new Set([
  408, 429, 500, 502, 503, 504,
]);
const RETRYABLE_STREAM_ERROR_PATTERNS = [
  "server_error",
  "internal server error",
  "service unavailable",
  "bad gateway",
  "gateway timeout",
  "too many requests",
  "rate_limit",
  "overloaded",
  "econnrefused",
  "enotfound",
  "econnreset",
  "epipe",
  "etimedout",
];

export function getStepToolNames(step: { toolCalls: Array<unknown> }) {
  return step.toolCalls
    .map((toolCall) => {
      if (!toolCall || typeof toolCall !== "object") {
        return null;
      }
      const maybeToolCall = toolCall as Record<string, unknown>;
      return typeof maybeToolCall.toolName === "string"
        ? maybeToolCall.toolName
        : null;
    })
    .filter((toolName): toolName is string => !!toolName);
}

export function hasRepeatedToolSignature(
  toolName: string,
  repeatedCount: number,
) {
  return ({ steps }: { steps: Array<{ toolCalls: Array<unknown> }> }) => {
    const signatures = steps
      .map((step) => getStepSignature(step.toolCalls))
      .filter((signature): signature is string => !!signature);
    const latestSignature = signatures.at(-1);
    if (!latestSignature?.startsWith(`${toolName}:`)) {
      return false;
    }
    if (signatures.length < repeatedCount) {
      return false;
    }
    return signatures
      .slice(-repeatedCount)
      .every((signature) => signature === latestSignature);
  };
}

export function getStepSignature(toolCalls: Array<unknown>) {
  if (toolCalls.length === 0) {
    return null;
  }
  return toolCalls
    .map((toolCall) => {
      if (!toolCall || typeof toolCall !== "object") {
        return "unknown:null";
      }
      const maybeToolCall = toolCall as Record<string, unknown>;
      const toolName =
        typeof maybeToolCall.toolName === "string"
          ? maybeToolCall.toolName
          : "unknown";
      const input =
        maybeToolCall.input ??
        maybeToolCall.args ??
        maybeToolCall.arguments ??
        null;
      const inputSignature = createHash("sha1")
        .update(stableSignatureJson(input))
        .digest("hex")
        .slice(0, 10);
      return `${toolName}:${inputSignature}`;
    })
    .join(",");
}

function stableSignatureJson(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, nestedValue) => {
      if (
        nestedValue &&
        typeof nestedValue === "object" &&
        !Array.isArray(nestedValue)
      ) {
        return Object.fromEntries(
          Object.entries(nestedValue as Record<string, unknown>).sort(
            ([a], [b]) => a.localeCompare(b),
          ),
        );
      }
      return nestedValue;
    });
  } catch {
    return String(value);
  }
}

export function buildTerminatedRetryContinuationInstruction(): ModelMessage {
  return {
    role: "user",
    content: [{ type: "text", text: STREAM_CONTINUE_MESSAGE }],
  };
}

export function unwrapStreamError(error: unknown): unknown {
  if (isRecord(error) && "error" in error) {
    return error.error;
  }
  return error;
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  if (typeof error === "string") {
    return error;
  }
  if (isRecord(error)) {
    if (typeof error.message === "string" && error.message.length > 0) {
      return error.message;
    }
    if ("error" in error) {
      return getErrorMessage(error.error);
    }
    if ("cause" in error) {
      return getErrorMessage(error.cause);
    }
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function isTerminatedStreamError(error: unknown): boolean {
  const normalized = unwrapStreamError(error);
  const message = getErrorMessage(normalized).toLowerCase();
  if (message.includes("typeerror: terminated") || message === "terminated") {
    return true;
  }
  const cause =
    isRecord(normalized) && "cause" in normalized
      ? normalized.cause
      : undefined;
  if (cause) {
    return isTerminatedStreamError(cause);
  }
  return false;
}

export function isRetryableProviderStreamError(error: unknown): boolean {
  const normalized = unwrapStreamError(error);
  if (!isRecord(normalized)) {
    return false;
  }

  const statusCode =
    (typeof normalized.statusCode === "number" && normalized.statusCode) ||
    (typeof normalized.status === "number" && normalized.status) ||
    (isRecord(normalized.response) &&
    typeof normalized.response.status === "number"
      ? normalized.response.status
      : undefined);

  if (
    typeof statusCode === "number" &&
    (statusCode >= 500 || RETRYABLE_STREAM_ERROR_STATUS_CODES.has(statusCode))
  ) {
    return true;
  }

  const errorString =
    [
      typeof normalized.message === "string" ? normalized.message : undefined,
      typeof normalized.code === "string" ? normalized.code : undefined,
      typeof normalized.type === "string" ? normalized.type : undefined,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase() || getErrorMessage(normalized).toLowerCase();

  return RETRYABLE_STREAM_ERROR_PATTERNS.some((pattern) =>
    errorString.includes(pattern),
  );
}

export function shouldRetryTransientStreamError(params: {
  error: unknown;
  retryCount: number;
  aborted: boolean;
}): boolean {
  const { error, retryCount, aborted } = params;
  return (
    !aborted &&
    retryCount < MAX_TERMINATED_STREAM_RETRIES &&
    (error instanceof StreamStalledError ||
      isTerminatedStreamError(error) ||
      isRetryableProviderStreamError(error))
  );
}

export async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export function getPlanningQuestionnaireErrorFromStep(step: {
  content?: unknown;
}): string | null {
  if (!Array.isArray(step.content)) {
    return null;
  }

  for (const part of step.content) {
    if (!isRecord(part) || part.toolName !== PLANNING_QUESTIONNAIRE_TOOL_NAME) {
      continue;
    }

    if (part.type === "tool-error") {
      return typeof part.error === "string" ? part.error : "Unknown tool error";
    }

    if (
      part.type === "tool-result" &&
      typeof part.output === "string" &&
      part.output.startsWith("Error:")
    ) {
      return part.output;
    }
  }

  return null;
}

export function buildPlanningQuestionnaireReflectionMessage(
  errorDetail?: string,
  planModeOnly?: boolean,
): string {
  const base = "Your planning_questionnaire tool call had a format error.";
  const detail = errorDetail ? ` The error was: ${errorDetail}` : "";
  if (planModeOnly) {
    return `[System]${base}${detail} Review the tool's input schema, fix the issue, and re-call planning_questionnaire with correct arguments.`;
  }
  return `[System]${base}${detail} Skip the questionnaire step and proceed directly to the planning phase.`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function stepOnlyCalledTool(
  step: { toolCalls: Array<unknown> },
  toolName: string,
): boolean {
  return (
    step.toolCalls.length > 0 &&
    step.toolCalls.every(
      (toolCall) => isRecord(toolCall) && toolCall.toolName === toolName,
    )
  );
}

export function shouldRunTodoFollowUpPass(params: {
  readOnly: boolean;
  planModeOnly: boolean;
  passEndedWithText: boolean;
  todos: AgentContext["todos"];
  todoFollowUpLoops: number;
  maxTodoFollowUpLoops: number;
}): boolean {
  const {
    readOnly,
    planModeOnly,
    passEndedWithText,
    todos,
    todoFollowUpLoops,
    maxTodoFollowUpLoops,
  } = params;
  return (
    !readOnly &&
    !planModeOnly &&
    passEndedWithText &&
    hasIncompleteTodos(todos) &&
    todoFollowUpLoops < maxTodoFollowUpLoops
  );
}
