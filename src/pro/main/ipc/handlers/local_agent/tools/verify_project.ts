import { spawn } from "node:child_process";
import { z } from "zod";
import {
  AgentContext,
  escapeXmlAttr,
  escapeXmlContent,
  ToolDefinition,
} from "./types";
import { runAppById } from "@/ipc/handlers/app_handlers";
import { detectProjectStack } from "@/ipc/utils/project_stack_detector";
import { waitForManagedRuntimeReady } from "@/ipc/utils/runtime_readiness";
import { addLog } from "@/lib/log_store";

const MAX_OUTPUT_CHARS = 16_000;

const verifyProjectSchema = z.object({
  install: z.boolean().optional().default(true),
  typecheck: z.boolean().optional().default(true),
  build: z.boolean().optional().default(true),
  start_runtime: z.boolean().optional().default(true),
  timeout_seconds: z
    .number()
    .min(10)
    .max(600)
    .optional()
    .default(180)
    .describe("Maximum seconds for each install/typecheck/build command."),
  runtime_timeout_seconds: z
    .number()
    .min(5)
    .max(120)
    .optional()
    .default(45)
    .describe("Maximum seconds to wait for the managed runtime to be ready."),
});

type VerifyProjectArgs = z.infer<typeof verifyProjectSchema>;

type CommandCheckName = "install" | "typecheck" | "build";

type CommandResult = {
  check: CommandCheckName;
  command: string;
  status: "passed" | "failed" | "skipped";
  exitCode: number | null;
  output: string;
};

function truncateOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) return output;
  const half = Math.floor(MAX_OUTPUT_CHARS / 2);
  return `${output.slice(0, half)}\n\n... [output truncated] ...\n\n${output.slice(-half)}`;
}

async function runCommand(params: {
  appId: number;
  appPath: string;
  check: CommandCheckName;
  command: string;
  timeoutMs: number;
}): Promise<CommandResult> {
  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const proc = spawn(params.command, [], {
      cwd: params.appPath,
      shell: true,
      stdio: "pipe",
      env: { ...process.env },
    });

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve({
        check: params.check,
        command: params.command,
        status: "failed",
        exitCode: 124,
        output: truncateOutput(
          `${stdout}${stderr}\n[Timed out after ${params.timeoutMs / 1000}s]`,
        ),
      });
    }, params.timeoutMs);

    proc.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      addLog({
        appId: params.appId,
        level: "info",
        type: "server",
        message: text,
        timestamp: Date.now(),
      });
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      addLog({
        appId: params.appId,
        level: "error",
        type: "server",
        message: text,
        timestamp: Date.now(),
      });
    });
    proc.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        check: params.check,
        command: params.command,
        status: "failed",
        exitCode: 1,
        output: truncateOutput(
          `${stdout}${stderr}\n[Spawn error: ${error.message}]`,
        ),
      });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      const exitCode = code ?? 0;
      resolve({
        check: params.check,
        command: params.command,
        status: exitCode === 0 ? "passed" : "failed",
        exitCode,
        output: truncateOutput(`${stdout}${stderr}`),
      });
    });
  });
}

function commandAttrs(result: CommandResult): string {
  return [
    `${result.check}-command="${escapeXmlAttr(result.command)}"`,
    `${result.check}-status="${result.status}"`,
    `${result.check}-exit-code="${result.exitCode ?? ""}"`,
  ].join(" ");
}

export const verifyProjectTool: ToolDefinition<VerifyProjectArgs> = {
  name: "verify_project",
  description: `Run the current project's post-create verification loop: install dependencies, typecheck, build, and start the managed runtime.

Use this immediately after create_project and before claiming a greenfield app is ready. UI work still needs separate screenshot and accessibility checks after runtime is ready.`,
  inputSchema: verifyProjectSchema,
  defaultConsent: "ask",
  modifiesState: true,

  getConsentPreview: () => "Run project verification gate",

  buildXml: (_args, isComplete) => {
    if (isComplete) return undefined;
    return `<orianbuilder-project-verification status="running">Running project verification...`;
  },

  execute: async (args, ctx: AgentContext) => {
    const stack = await detectProjectStack(ctx.appPath);
    const timeoutMs = (args.timeout_seconds ?? 180) * 1000;
    const checks: CommandResult[] = [];

    ctx.onXmlStream(
      `<orianbuilder-project-verification status="running">Running project verification...`,
    );

    if (args.install !== false && stack.commands.install) {
      checks.push(
        await runCommand({
          appId: ctx.appId,
          appPath: ctx.appPath,
          check: "install",
          command: stack.commands.install,
          timeoutMs,
        }),
      );
    }

    if (args.typecheck !== false && stack.commands.typecheck) {
      checks.push(
        await runCommand({
          appId: ctx.appId,
          appPath: ctx.appPath,
          check: "typecheck",
          command: stack.commands.typecheck,
          timeoutMs,
        }),
      );
    }

    if (args.build !== false && stack.commands.build) {
      checks.push(
        await runCommand({
          appId: ctx.appId,
          appPath: ctx.appPath,
          check: "build",
          command: stack.commands.build,
          timeoutMs,
        }),
      );
    }

    let runtimeReady = false;
    let runtimeUrl: string | null = null;
    let runtimeError: string | null = null;
    if (args.start_runtime !== false && stack.commands.dev) {
      await runAppById(ctx.event, ctx.appId);
      const readiness = await waitForManagedRuntimeReady({
        appId: ctx.appId,
        timeoutMs: (args.runtime_timeout_seconds ?? 45) * 1000,
      });
      runtimeReady = readiness.ready;
      runtimeUrl = readiness.previewUrl;
      runtimeError = readiness.error;
    }

    const failed = checks.filter((check) => check.status === "failed");
    const status =
      failed.length === 0 && (!stack.commands.dev || runtimeReady)
        ? "passed"
        : "failed";
    const output = checks
      .map(
        (check) =>
          `[${check.status.toUpperCase()}] ${check.command}\n${check.output.trim() || "(no output)"}`,
      )
      .join("\n\n");

    const attrs = checks.map(commandAttrs).join(" ");
    ctx.onXmlComplete(
      `<orianbuilder-project-verification status="${status}" framework="${escapeXmlAttr(stack.framework)}" package-manager="${escapeXmlAttr(stack.packageManager)}" runtime-status="${runtimeReady ? "passed" : stack.commands.dev ? "failed" : "skipped"}" runtime-url="${escapeXmlAttr(runtimeUrl ?? "")}" runtime-error="${escapeXmlAttr(runtimeError ?? "")}" ${attrs}>${escapeXmlContent(output)}</orianbuilder-project-verification>`,
    );

    return [
      `Project verification ${status}.`,
      `Framework: ${stack.framework}`,
      `Package manager: ${stack.packageManager}`,
      ...checks.map(
        (check) =>
          `${check.check}: ${check.status}${check.exitCode === null ? "" : ` (exit ${check.exitCode})`} - ${check.command}`,
      ),
      stack.commands.dev
        ? `runtime: ${runtimeReady ? "passed" : "failed"}${runtimeUrl ? ` - ${runtimeUrl}` : ""}${runtimeError ? ` (${runtimeError})` : ""}`
        : "runtime: skipped",
    ].join("\n");
  },
};
