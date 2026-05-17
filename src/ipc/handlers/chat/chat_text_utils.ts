/**
 * Text / tag manipulation helpers used across the chat stream pipeline.
 *
 * - Tag removal: strip thinking blocks, problem reports, and any orianbuilder-* tag
 * - hasUnclosedOrianBuilderWrite: detects truncated write blocks
 * - escapeOrianBuilderTags: rewrites orianbuilder-* tags in reasoning content so
 *   they don't get processed as real actions
 * - parseMcpToolKey: splits a tool key like "server__tool" back into parts
 * - formatMessagesForSummary: collapses a long chat history for summarization
 */

import * as path from "path";

import type { CodebaseFile } from "@/utils/codebase";
import { estimateTokens } from "@/ipc/utils/token_utils";

const TEXT_FILE_EXTENSIONS = [
  ".md",
  ".txt",
  ".json",
  ".csv",
  ".js",
  ".ts",
  ".html",
  ".css",
];

export async function isTextFile(filePath: string): Promise<boolean> {
  const ext = path.extname(filePath).toLowerCase();
  return TEXT_FILE_EXTENSIONS.includes(ext);
}

/**
 * Safely parse an MCP tool key that combines server and tool names.
 * Splits on the LAST occurrence of "__" to avoid ambiguity if either side
 * contains "__" as part of its sanitized name.
 */
export function parseMcpToolKey(toolKey: string): {
  serverName: string;
  toolName: string;
} {
  const separator = "__";
  const lastIndex = toolKey.lastIndexOf(separator);
  if (lastIndex === -1) {
    return { serverName: "", toolName: toolKey };
  }
  const serverName = toolKey.slice(0, lastIndex);
  const toolName = toolKey.slice(lastIndex + separator.length);
  return { serverName, toolName };
}

export function removeNonEssentialTags(text: string): string {
  return removeProblemReportTags(removeThinkingTags(text));
}

export function removeThinkingTags(text: string): string {
  const thinkRegex = /<think>([\s\S]*?)<\/think>/g;
  return text.replace(thinkRegex, "").trim();
}

export function removeProblemReportTags(text: string): string {
  const problemReportRegex =
    /<orianbuilder-problem-report[^>]*>[\s\S]*?<\/orianbuilder-problem-report>/g;
  return text.replace(problemReportRegex, "").trim();
}

export function removeOrianBuilderTags(text: string): string {
  const orianbuilderRegex =
    /<orianbuilder-[^>]*>[\s\S]*?<\/orianbuilder-[^>]*>/g;
  return text.replace(orianbuilderRegex, "").trim();
}

export function hasUnclosedOrianBuilderWrite(text: string): boolean {
  const openRegex = /<orianbuilder-write[^>]*>/g;
  let lastOpenIndex = -1;
  let match;

  while ((match = openRegex.exec(text)) !== null) {
    lastOpenIndex = match.index;
  }

  if (lastOpenIndex === -1) {
    return false;
  }

  const textAfterLastOpen = text.substring(lastOpenIndex);
  const hasClosingTag = /<\/orianbuilder-write>/.test(textAfterLastOpen);

  return !hasClosingTag;
}

/**
 * Rewrite orianbuilder-* tags so they don't get processed as real actions when
 * they appear inside reasoning content. Substitutes the leading '<' with a
 * look-alike fullwidth character.
 */
export function escapeOrianBuilderTags(text: string): string {
  return text
    .replace(/<orianbuilder/g, "＜orianbuilder")
    .replace(/<\/orianbuilder/g, "＜/orianbuilder");
}

export function formatMessagesForSummary(
  messages: { role: string; content: string | undefined }[],
): string {
  if (messages.length <= 8) {
    return messages
      .map((m) => `<message role="${m.role}">${m.content}</message>`)
      .join("\n");
  }

  const firstMessages = messages.slice(0, 2);
  const lastMessages = messages.slice(-6);

  const combinedMessages = [
    ...firstMessages,
    {
      role: "system",
      content: `[... ${messages.length - 8} messages omitted ...]`,
    },
    ...lastMessages,
  ];

  return combinedMessages
    .map((m) => `<message role="${m.role}">${m.content}</message>`)
    .join("\n");
}

export const CODEBASE_PROMPT_PREFIX = "This is my codebase.";

export function createCodebasePrompt(codebaseInfo: string): string {
  return `${CODEBASE_PROMPT_PREFIX} ${codebaseInfo}`;
}

/**
 * Files always kept in-context regardless of token budget — entry points,
 * package manifests, build/router config. Reference-only files the model
 * almost certainly needs to make sense of anything else it sees.
 */
const CRITICAL_FILE_BASENAMES = new Set([
  "package.json",
  "tsconfig.json",
  "vite.config.ts",
  "vite.config.js",
  "next.config.js",
  "next.config.ts",
  "tailwind.config.js",
  "tailwind.config.ts",
  "postcss.config.js",
  "index.html",
  "main.tsx",
  "main.ts",
  "App.tsx",
  "App.ts",
  "router.tsx",
  "routes.ts",
  "readme.md",
]);

function isCriticalFile(filePath: string): boolean {
  const base = filePath.split("/").pop()?.toLowerCase() ?? "";
  return CRITICAL_FILE_BASENAMES.has(base);
}

function formatFileBlock(file: CodebaseFile): string {
  return `<orianbuilder-file path="${file.path}">\n${file.content}\n</orianbuilder-file>\n\n`;
}

export interface TrimmedCodebase {
  /** The codebase string to ship in the prompt. */
  formattedOutput: string;
  /** Paths of files whose contents were dropped to fit the budget. */
  omittedPaths: string[];
  /** True if anything was actually dropped. */
  trimmed: boolean;
  /** Estimated token count of the returned formattedOutput. */
  estimatedTokens: number;
}

/**
 * Cap the codebase prompt at a token budget. Without this, a local 32K-context
 * model receives a 58K-token codebase + 30K history and silently truncates its
 * response mid-write, producing broken files like `from-indigo-500 to` that
 * crash the preview.
 *
 * Priority order when trimming (highest priority kept first):
 *   1. Files marked `force` or `focused` by the chat-context resolver
 *   2. Critical project files (package.json, vite.config.ts, App.tsx, …)
 *   3. Remaining files in input order (already mtime-sorted oldest-first;
 *      we reverse so newer files win when the budget runs out)
 *
 * If the budget is non-positive we don't trim — caller decides whether to
 * skip codebase injection entirely.
 */
export function trimCodebaseToTokenBudget(
  files: CodebaseFile[],
  budgetTokens: number,
): TrimmedCodebase {
  if (!Number.isFinite(budgetTokens) || budgetTokens <= 0) {
    const formattedOutput = files.map(formatFileBlock).join("");
    return {
      formattedOutput,
      omittedPaths: [],
      trimmed: false,
      estimatedTokens: estimateTokens(formattedOutput),
    };
  }

  const scoreFile = (file: CodebaseFile): number => {
    if (file.force || file.focused) return 0;
    if (isCriticalFile(file.path)) return 1;
    return 2;
  };

  const indexed = files.map((file, originalIndex) => ({
    file,
    originalIndex,
    score: scoreFile(file),
    tokens: estimateTokens(formatFileBlock(file)),
  }));

  // Stable sort: by score asc, then reverse-original (newest first within tier).
  indexed.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    return b.originalIndex - a.originalIndex;
  });

  const included: typeof indexed = [];
  const omitted: typeof indexed = [];
  let used = 0;
  for (const entry of indexed) {
    if (entry.score === 0 || used + entry.tokens <= budgetTokens) {
      included.push(entry);
      used += entry.tokens;
    } else {
      omitted.push(entry);
    }
  }

  if (omitted.length === 0) {
    const formattedOutput = files.map(formatFileBlock).join("");
    return {
      formattedOutput,
      omittedPaths: [],
      trimmed: false,
      estimatedTokens: estimateTokens(formattedOutput),
    };
  }

  // Emit in the original order so the prompt reads naturally (oldest → newest).
  included.sort((a, b) => a.originalIndex - b.originalIndex);

  const fileBlocks = included.map((e) => formatFileBlock(e.file)).join("");
  const omittedPaths = omitted
    .map((e) => e.file.path)
    .sort((a, b) => a.localeCompare(b));
  const omittedSection =
    `<orianbuilder-omitted-files note="Truncated to fit the model's context window. ` +
    `Ask for any of these files by name if you need them.">\n` +
    omittedPaths.map((p) => `- ${p}`).join("\n") +
    `\n</orianbuilder-omitted-files>\n\n`;

  const formattedOutput = fileBlocks + omittedSection;
  return {
    formattedOutput,
    omittedPaths,
    trimmed: true,
    estimatedTokens: estimateTokens(formattedOutput),
  };
}

export function createOtherAppsCodebasePrompt(
  otherAppsCodebaseInfo: string,
): string {
  return `
# Referenced Apps

These are the other apps that I've mentioned in my prompt. These other apps' codebases are READ-ONLY.

${otherAppsCodebaseInfo}
`;
}
