/**
 * File-search helpers used by the app handlers. Wraps ripgrep and converts
 * its byte-based match offsets into character indices so UI snippets line up
 * correctly with multi-byte text (emoji, CJK, accented characters).
 */

import { spawn } from "node:child_process";
import path from "node:path";
import log from "electron-log";

import type { AppFileSearchResult } from "../../types/app";
import { normalizePath } from "../../../../shared/normalizePath";
import {
  getRgExecutablePath,
  MAX_FILE_SEARCH_SIZE,
  RIPGREP_EXCLUDED_GLOBS,
} from "../../utils/ripgrep_utils";

const logger = log.scope("app_handlers");

export function sanitizeSnippetText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Convert a byte offset in a UTF-8 encoded string to a character index.
 * Ripgrep emits byte offsets, but JavaScript strings index by characters.
 * Handles multi-byte UTF-8 characters (emoji, CJK, accented characters).
 */
export function byteOffsetToCharIndex(
  text: string,
  byteOffset: number,
): number {
  const totalBytes = Buffer.from(text, "utf8").length;
  const safeByteOffset = Math.min(byteOffset, totalBytes);

  for (let i = 0; i <= text.length; i++) {
    const bytesUpToIndex = Buffer.from(text.slice(0, i), "utf8").length;
    if (bytesUpToIndex >= safeByteOffset) {
      return i;
    }
  }

  return text.length;
}

export function buildSnippetFromMatch({
  lineText,
  start,
  end,
  lineNumber,
}: {
  lineText: string;
  start: number;
  end: number;
  lineNumber: number;
}): NonNullable<AppFileSearchResult["snippets"]>[number] {
  const safeLine = lineText.replace(/\r?\n$/, "");
  const startChar = byteOffsetToCharIndex(safeLine, start);
  const endChar = byteOffsetToCharIndex(safeLine, end);
  const before = sanitizeSnippetText(safeLine.slice(0, startChar));
  const match = sanitizeSnippetText(safeLine.slice(startChar, endChar));
  const after = sanitizeSnippetText(safeLine.slice(endChar));

  return {
    before,
    match,
    after,
    line: lineNumber,
  };
}

export async function searchAppFilesWithRipgrep({
  appPath,
  query,
}: {
  appPath: string;
  query: string;
}): Promise<AppFileSearchResult[]> {
  return new Promise((resolve, reject) => {
    const results = new Map<string, AppFileSearchResult>();
    const args = [
      "--json",
      "--no-config",
      "--ignore-case",
      "--fixed-strings",
      "--max-filesize",
      `${MAX_FILE_SEARCH_SIZE}`,
      ...RIPGREP_EXCLUDED_GLOBS.flatMap((glob) => ["--glob", glob]),
      query,
      ".",
    ];

    const rg = spawn(getRgExecutablePath(), args, { cwd: appPath });
    let buffer = "";

    rg.stdout.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type !== "match" || !event.data) {
            continue;
          }

          const matchPath = event.data.path?.text as string;
          if (!matchPath) continue;

          const absolutePath = path.isAbsolute(matchPath)
            ? matchPath
            : path.join(appPath, matchPath);
          const relativePath = normalizePath(
            path.relative(appPath, absolutePath),
          );
          if (relativePath.startsWith("..")) {
            continue;
          }

          const lineText = event.data.lines?.text as string;
          const lineNumber = event.data.line_number as number;
          const submatch = event.data.submatches?.[0];
          if (
            typeof lineText !== "string" ||
            typeof lineNumber !== "number" ||
            !submatch
          ) {
            continue;
          }

          const snippet = buildSnippetFromMatch({
            lineText,
            start: submatch.start,
            end: submatch.end,
            lineNumber,
          });

          const existing = results.get(relativePath);
          if (!existing) {
            results.set(relativePath, {
              path: relativePath,
              matchesContent: true,
              snippets: [snippet],
            });
          } else {
            if (!existing.snippets) {
              existing.snippets = [];
            }
            const existingLine = existing.snippets.find(
              (s) => s.line === snippet.line,
            );
            if (!existingLine) {
              existing.snippets.push(snippet);
            }
          }
        } catch (error) {
          logger.warn("Failed to parse ripgrep output line:", line, error);
        }
      }
    });

    rg.stderr.on("data", (data) => {
      const message = data.toString();
      if (message.toLowerCase().includes("binary file skipped")) {
        return;
      }
      logger.debug("ripgrep stderr:", message);
    });

    rg.on("close", (code) => {
      // ripgrep exits with code 1 when no matches are found; treat as success.
      if (code !== 0 && code !== 1) {
        reject(new Error(`ripgrep exited with code ${code}`));
        return;
      }
      resolve(Array.from(results.values()));
    });

    rg.on("error", (error) => {
      reject(error);
    });
  });
}
