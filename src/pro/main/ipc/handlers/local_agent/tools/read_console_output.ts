import { z } from "zod";
import log from "electron-log";
import { ToolDefinition, AgentContext, escapeXmlContent } from "./types";
import { getLogs } from "@/lib/log_store";
import { db } from "@/db";
import { chats } from "@/db/schema";
import { eq } from "drizzle-orm";
import { DyadError, DyadErrorKind } from "@/errors/dyad_error";

const logger = log.scope("read_console_output");

const readConsoleOutputSchema = z.object({
  filter: z
    .enum(["all", "errors", "warnings", "errors_and_warnings"])
    .optional()
    .default("errors_and_warnings")
    .describe(
      "Which messages to return. 'errors_and_warnings' is the default and most useful for debugging.",
    ),
  limit: z
    .number()
    .min(1)
    .max(100)
    .optional()
    .default(30)
    .describe("Max number of entries to return (default 30, max 100)."),
});

type ReadConsoleOutputArgs = z.infer<typeof readConsoleOutputSchema>;

// Error keywords that indicate real runtime/build errors worth reporting
const ERROR_PATTERNS = [
  /error/i,
  /exception/i,
  /failed/i,
  /cannot find/i,
  /is not defined/i,
  /cannot read/i,
  /TypeError/,
  /ReferenceError/,
  /SyntaxError/,
  /Uncaught/,
  /ENOENT/,
  /EACCES/,
  /EADDRINUSE/,
  /module not found/i,
  /import.*failed/i,
  /build.*failed/i,
];

// Noise patterns to suppress — vite HMR, normal dev-server chatter
const NOISE_PATTERNS = [
  /^\s*$/,
  /vite.*ready/i,
  /hmr\s+update/i,
  /page\s+reload/i,
  /local:\s+http/i,
  /network:\s+http/i,
  /press\s+h\s+to\s+show\s+help/i,
];

function looksLikeError(message: string): boolean {
  if (NOISE_PATTERNS.some((p) => p.test(message))) return false;
  return ERROR_PATTERNS.some((p) => p.test(message));
}

function looksLikeWarning(message: string): boolean {
  if (NOISE_PATTERNS.some((p) => p.test(message))) return false;
  return /warning|deprecated|warn\b/i.test(message);
}

export const readConsoleOutputTool: ToolDefinition<ReadConsoleOutputArgs> = {
  name: "read_console_output",
  description: `Read the running preview app's console output (stdout/stderr from the dev server).

Use this tool **after writing or changing code** to check if the app still runs correctly, and to catch:
- Runtime JavaScript errors (TypeError, ReferenceError, etc.)
- Build/compilation errors from the bundler (Vite, webpack)
- Server startup failures or crashes
- Missing module errors
- Unhandled promise rejections

### When to use
1. After writing or modifying files — verify no new errors appeared
2. When the user says "it's broken" or "it's not working" — read output first before guessing
3. After adding a new dependency or changing config — check startup succeeded

### When NOT to use
- To get type errors (use \`run_type_checks\` instead)
- To read application-level logs that the app itself writes (those appear here too but are better read with \`read_logs\`)

### Self-correction loop
If you see errors after writing code, fix them and re-read to confirm they're gone.`,

  inputSchema: readConsoleOutputSchema,
  defaultConsent: "always",

  getConsentPreview: (args) =>
    `Read console output (filter: ${args.filter ?? "errors_and_warnings"})`,

  buildXml: (_args, isComplete) => {
    if (isComplete) return undefined;
    return `<dyad-console-output>Reading…`;
  },

  execute: async (args, ctx: AgentContext) => {
    logger.log(
      `read_console_output: filter=${args.filter}, limit=${args.limit}`,
    );

    const chat = await db.query.chats.findFirst({
      where: eq(chats.id, ctx.chatId),
      with: { app: true },
    });

    if (!chat?.app) {
      throw new DyadError(
        "App not found for this chat.",
        DyadErrorKind.NotFound,
      );
    }

    const appId = chat.app.id;
    const allLogs = getLogs(appId);

    // Take recent window — last 2 minutes (dev server output is high volume)
    const cutoff = Date.now() - 2 * 60 * 1000;
    let recent = allLogs.filter((l) => l.timestamp >= cutoff);

    // Apply filter
    const filter = args.filter ?? "errors_and_warnings";
    if (filter === "errors") {
      recent = recent.filter(
        (l) => l.level === "error" || looksLikeError(l.message),
      );
    } else if (filter === "warnings") {
      recent = recent.filter(
        (l) => l.level === "warn" || looksLikeWarning(l.message),
      );
    } else if (filter === "errors_and_warnings") {
      recent = recent.filter(
        (l) =>
          l.level === "error" ||
          l.level === "warn" ||
          looksLikeError(l.message) ||
          looksLikeWarning(l.message),
      );
    }
    // "all" — no further filtering

    // Suppress pure noise
    recent = recent.filter(
      (l) => !NOISE_PATTERNS.some((p) => p.test(l.message)),
    );

    // Most recent first, then cap
    recent = recent.slice(-(args.limit ?? 30));

    let output: string;
    if (recent.length === 0) {
      output =
        filter === "all"
          ? "No console output in the last 2 minutes."
          : `No ${filter.replace(/_/g, " ")} found in the last 2 minutes. The app appears to be running cleanly.`;
    } else {
      const lines = recent.map((l) => {
        const ts = new Date(l.timestamp).toISOString().slice(11, 23);
        const lvl = l.level.toUpperCase().padEnd(5);
        const msg = l.message.trimEnd().slice(0, 2000);
        return `[${ts}] [${lvl}] ${msg}`;
      });
      output = `Console output (last 2 min, filter=${filter}, ${recent.length} entries):\n\n${lines.join("\n")}`;
    }

    ctx.onXmlComplete(
      `<dyad-console-output count="${recent.length}" filter="${filter}">${escapeXmlContent(output)}</dyad-console-output>`,
    );

    logger.log(`read_console_output done: ${recent.length} entries`);
    return output;
  },
};
