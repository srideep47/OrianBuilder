import { z } from "zod";
import { spawn } from "node:child_process";
import log from "electron-log";
import {
  ToolDefinition,
  AgentContext,
  escapeXmlAttr,
  escapeXmlContent,
} from "./types";
import { DyadError, DyadErrorKind } from "@/errors/dyad_error";
import { addLog } from "@/lib/log_store";

const logger = log.scope("run_terminal_command");

// Hard cap on total output to keep model context reasonable
const MAX_OUTPUT_CHARS = 20_000;
const DEFAULT_TIMEOUT_MS = 60_000;

// Commands that could cause irreversible damage — blocked unconditionally
const BLOCKED_COMMANDS = [
  /\brm\s+-rf\b/,
  /\brmdir\s+\/s\b/i,
  /\bdel\s+\/[sf]/i,
  /\bformat\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bpoweroff\b/i,
  /\bkill\b.*-9\b/,
  /\bchmod\s+777\b/,
  /\bcurl\s.*\|\s*(bash|sh)\b/,
  /\bwget\s.*\|\s*(bash|sh)\b/,
];

function isCommandBlocked(command: string): boolean {
  return BLOCKED_COMMANDS.some((re) => re.test(command));
}

function truncateOutput(raw: string): string {
  if (raw.length <= MAX_OUTPUT_CHARS) return raw;
  const half = Math.floor(MAX_OUTPUT_CHARS / 2);
  return (
    raw.slice(0, half) +
    "\n\n... [output truncated — too large] ...\n\n" +
    raw.slice(-half)
  );
}

const runTerminalCommandSchema = z.object({
  command: z
    .string()
    .describe(
      "The shell command to execute in the app's root directory. Use shell syntax appropriate for the platform (Windows: PowerShell/cmd, Linux/Mac: bash).",
    ),
  timeout_seconds: z
    .number()
    .min(1)
    .max(300)
    .optional()
    .default(60)
    .describe(
      "Maximum seconds to wait for the command to finish (default: 60, max: 300).",
    ),
  working_directory: z
    .string()
    .optional()
    .describe(
      "Subdirectory relative to the app root to run the command in. Omit to use app root.",
    ),
});

type RunTerminalCommandArgs = z.infer<typeof runTerminalCommandSchema>;

export const runTerminalCommandTool: ToolDefinition<RunTerminalCommandArgs> = {
  name: "run_terminal_command",
  description: `Execute a shell command in the app's directory and capture its output.

### When to use
- Run build checks: \`npm run build\`, \`npx tsc --noEmit\`
- Apply database migrations: \`npx prisma migrate dev\`, \`npx drizzle-kit push\`
- Install a specific package before using it: \`npm install <pkg>\`
- Run scripts: \`npm run generate\`, \`npx prisma generate\`
- Check if a binary or tool is available: \`node --version\`, \`npx prisma --version\`
- Run tests: \`npm test -- --run\`

### When NOT to use
- To start the dev server (it's already running)
- To install ALL dependencies (the dev server does this automatically)
- For long-running watch processes — only short-lived commands that exit

### Self-correction
After running a build command and seeing errors, fix the code and re-run to confirm success.`,

  inputSchema: runTerminalCommandSchema,
  defaultConsent: "ask",
  modifiesState: true,

  getConsentPreview: (args) => `Run: ${args.command}`,

  buildXml: (args, isComplete) => {
    if (!args.command) return undefined;
    if (isComplete) return undefined;
    return `<dyad-terminal-command cmd="${escapeXmlAttr(args.command ?? "")}">Running…`;
  },

  execute: async (args, ctx: AgentContext) => {
    const command = args.command.trim();
    logger.log(`run_terminal_command: ${command} (cwd: ${ctx.appPath})`);

    if (!command) {
      throw new DyadError(
        "Command must not be empty.",
        DyadErrorKind.Validation,
      );
    }

    if (isCommandBlocked(command)) {
      throw new DyadError(
        `Command blocked for safety: "${command}". Destructive or dangerous commands are not allowed.`,
        DyadErrorKind.Validation,
      );
    }

    const cwd = args.working_directory
      ? require("node:path").join(ctx.appPath, args.working_directory)
      : ctx.appPath;

    const timeoutMs = (args.timeout_seconds ?? 60) * 1000;

    ctx.onXmlStream(
      `<dyad-terminal-command cmd="${escapeXmlAttr(command)}">Running…`,
    );

    const result = await new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number;
    }>((resolve) => {
      let stdout = "";
      let stderr = "";

      const proc = spawn(command, [], {
        cwd,
        shell: true,
        stdio: "pipe",
        env: { ...process.env },
      });

      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve({
          stdout,
          stderr: stderr + `\n[Timed out after ${args.timeout_seconds ?? 60}s]`,
          exitCode: 124,
        });
      }, timeoutMs || DEFAULT_TIMEOUT_MS);

      proc.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        addLog({
          level: "info",
          type: "server",
          message: text,
          timestamp: Date.now(),
          appId: ctx.appId,
        });
      });

      proc.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;
        addLog({
          level: "error",
          type: "server",
          message: text,
          timestamp: Date.now(),
          appId: ctx.appId,
        });
      });

      proc.on("close", (code) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: code ?? 0 });
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        resolve({
          stdout,
          stderr: stderr + `\n[Spawn error: ${err.message}]`,
          exitCode: 1,
        });
      });
    });

    const combinedOutput =
      [
        result.stdout && `STDOUT:\n${result.stdout}`,
        result.stderr && `STDERR:\n${result.stderr}`,
      ]
        .filter(Boolean)
        .join("\n\n") || "(no output)";

    const truncated = truncateOutput(combinedOutput);
    const status =
      result.exitCode === 0 ? "success" : `exit code ${result.exitCode}`;

    const summary = `Command: ${command}\nStatus: ${status}\n\n${truncated}`;

    ctx.onXmlComplete(
      `<dyad-terminal-command cmd="${escapeXmlAttr(command)}" exit-code="${result.exitCode}">${escapeXmlContent(summary)}</dyad-terminal-command>`,
    );

    logger.log(`run_terminal_command done: exit=${result.exitCode}`);
    return summary;
  },
};
