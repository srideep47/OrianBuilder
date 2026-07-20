import { spawn } from "node:child_process";
import { z } from "zod";
import { detectProjectStack } from "@/ipc/utils/project_stack_detector";
import { addLog } from "@/lib/log_store";
import {
  OrianBuilderError,
  OrianBuilderErrorKind,
} from "@/errors/orianbuilder_error";
import {
  AgentContext,
  escapeXmlAttr,
  escapeXmlContent,
  ToolDefinition,
} from "./types";
import {
  PROJECT_CHECK_NAMES,
  projectCheckLabel,
  resolveProjectCheckCommand,
  type ProjectCheckName,
} from "./project_check_utils";
import {
  buildNpmEtargetRecoveryMessage,
  detectNpmEtargetError,
  getNpmPackageVersions,
  selectNpmReplacementVersion,
} from "@/ipc/utils/npm_registry";
import { logMissionEvent } from "@/ipc/utils/mission_utils";

const MAX_OUTPUT_CHARS = 18_000;
const DEFAULT_TIMEOUT_SECONDS = 180;
const MAX_ETARGET_AUTO_RECOVERIES_PER_RUN = 2;

const BLOCKED_COMMAND_PATTERNS = [
  /\brm\s+-rf\b/i,
  /\brmdir\s+\/s\b/i,
  /\bdel\s+\/[sf]\b/i,
  /\bformat\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bpoweroff\b/i,
  /\bcurl\s.*\|\s*(bash|sh)\b/i,
  /\bwget\s.*\|\s*(bash|sh)\b/i,
];

const runProjectCheckSchema = z.object({
  check: z.enum(PROJECT_CHECK_NAMES).describe("The project check to run."),
  command: z
    .string()
    .optional()
    .describe(
      "Optional explicit command. Omit this to use the detected package-manager/script command.",
    ),
  timeout_seconds: z
    .number()
    .min(5)
    .max(900)
    .optional()
    .default(DEFAULT_TIMEOUT_SECONDS)
    .describe("Maximum seconds to wait for the check to finish."),
});

type RunProjectCheckArgs = z.infer<typeof runProjectCheckSchema>;

type ProjectCheckResult = {
  check: ProjectCheckName;
  command: string;
  status: "passed" | "failed";
  exitCode: number;
  output: string;
};

function truncateOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) return output;
  const half = Math.floor(MAX_OUTPUT_CHARS / 2);
  return `${output.slice(0, half)}\n\n... [output truncated] ...\n\n${output.slice(-half)}`;
}

function assertCommandAllowed(command: string): void {
  if (BLOCKED_COMMAND_PATTERNS.some((pattern) => pattern.test(command))) {
    throw new OrianBuilderError(
      `Command blocked for safety: "${command}". Destructive or dangerous commands are not allowed.`,
      OrianBuilderErrorKind.Validation,
    );
  }
}

async function runCommand(params: {
  appId: number;
  appPath: string;
  check: ProjectCheckName;
  command: string;
  timeoutMs: number;
}): Promise<ProjectCheckResult> {
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

async function maybeQueueInstallEtargetRecovery(params: {
  ctx: AgentContext;
  check: ProjectCheckName;
  command: string;
  output: string;
  packageManager: string;
}) {
  if (params.check !== "install") return;
  const recoveryCount = params.ctx.installEtargetRecoveryCount ?? 0;
  if (recoveryCount >= MAX_ETARGET_AUTO_RECOVERIES_PER_RUN) {
    return;
  }

  const failure = detectNpmEtargetError(params.output);
  if (!failure) return;

  const versions = await getNpmPackageVersions(failure.packageName);
  const replacementVersion = selectNpmReplacementVersion({
    requestedVersion: failure.requestedVersion,
    latest: versions.latest,
    stableVersions: versions.stableVersions,
  });
  if (!replacementVersion || replacementVersion === failure.requestedVersion) {
    return;
  }

  params.ctx.installEtargetRecoveryCount = recoveryCount + 1;
  const recoveryMessage = buildNpmEtargetRecoveryMessage({
    packageName: failure.packageName,
    requestedVersion: failure.requestedVersion,
    replacementVersion,
    distTagLatest: versions.latest,
  });
  params.ctx.appendUserMessage([{ type: "text", text: recoveryMessage }]);
  await logMissionEvent({
    missionId: params.ctx.missionId,
    eventType: "install_etarget_auto_recovery",
    summary: `Install ETARGET auto-recovery queued for ${failure.packageName}@${failure.requestedVersion}`,
    metadata: {
      packageName: failure.packageName,
      requestedVersion: failure.requestedVersion,
      latestVersion: replacementVersion,
      distTagLatest: versions.latest,
      command: params.command,
      packageManager: params.packageManager,
      recoveryCount: params.ctx.installEtargetRecoveryCount,
      maxRecoveries: MAX_ETARGET_AUTO_RECOVERIES_PER_RUN,
    },
  }).catch(() => {});
}

export const runProjectCheckTool: ToolDefinition<RunProjectCheckArgs> = {
  name: "run_project_check",
  description: `Run a single first-class project check using the detected package manager and scripts.

Use this instead of run_terminal_command for install, lint, typecheck, build, unit test, and e2e test checks. It records structured verification XML so missions can audit pass/fail status and artifacts.`,
  inputSchema: runProjectCheckSchema,
  defaultConsent: "ask",
  modifiesState: true,

  getConsentPreview: (args) =>
    args.command
      ? `Run ${projectCheckLabel(args.check)}: ${args.command}`
      : `Run ${projectCheckLabel(args.check)} with detected project command`,

  buildXml: (args, isComplete) => {
    if (!args.check || isComplete) return undefined;
    return `<orianbuilder-project-check check="${escapeXmlAttr(args.check)}" status="running">Running ${escapeXmlContent(projectCheckLabel(args.check))}...`;
  },

  execute: async (args, ctx: AgentContext) => {
    const stack = await detectProjectStack(ctx.appPath);
    const resolved = resolveProjectCheckCommand({
      stack,
      check: args.check,
    });
    const command = (args.command ?? resolved.command ?? "").trim();
    if (!command) {
      throw new OrianBuilderError(
        `No command could be detected for ${projectCheckLabel(args.check)}. Add a package.json script or pass an explicit command.`,
        OrianBuilderErrorKind.Validation,
      );
    }

    assertCommandAllowed(command);

    const label = projectCheckLabel(args.check);
    ctx.onXmlStream(
      `<orianbuilder-project-check check="${escapeXmlAttr(args.check)}" command="${escapeXmlAttr(command)}" source="${escapeXmlAttr(args.command ? "explicit" : resolved.source)}" status="running">Running ${escapeXmlContent(label)}...`,
    );

    const result = await runCommand({
      appId: ctx.appId,
      appPath: ctx.appPath,
      check: args.check,
      command,
      timeoutMs: (args.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
    });

    if (result.status === "failed") {
      ctx.runState.unresolvedCommandFailure = {
        command,
        exitCode: result.exitCode,
        output: result.output.slice(0, 4000),
      };
      await maybeQueueInstallEtargetRecovery({
        ctx,
        check: result.check,
        command,
        output: result.output,
        packageManager: stack.packageManager,
      });
    } else {
      ctx.runState.unresolvedCommandFailure = null;
    }

    const output = result.output.trim() || "(no output)";
    const summary = `${label} ${result.status} (exit ${result.exitCode})\nCommand: ${command}\n\n${output}`;
    ctx.onXmlComplete(
      `<orianbuilder-project-check check="${escapeXmlAttr(result.check)}" command="${escapeXmlAttr(command)}" source="${escapeXmlAttr(args.command ? "explicit" : resolved.source)}" status="${result.status}" exit-code="${result.exitCode}" framework="${escapeXmlAttr(stack.framework)}" package-manager="${escapeXmlAttr(stack.packageManager)}">${escapeXmlContent(summary)}</orianbuilder-project-check>`,
    );

    return summary;
  },
};
