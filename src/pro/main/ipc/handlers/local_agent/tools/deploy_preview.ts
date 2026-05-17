import { Vercel } from "@vercel/sdk";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { z } from "zod";
import { db } from "@/db";
import { apps } from "@/db/schema";
import {
  OrianBuilderError,
  OrianBuilderErrorKind,
} from "@/errors/orianbuilder_error";
import { readSettings } from "@/main/settings";
import { findAvailablePort } from "@/ipc/utils/port_utils";
import { eq } from "drizzle-orm";
import {
  AgentContext,
  escapeXmlAttr,
  escapeXmlContent,
  ToolDefinition,
} from "./types";

const deployPreviewSchema = z.object({
  provider: z
    .enum(["vercel", "netlify_cli", "custom_command"])
    .optional()
    .default("vercel")
    .describe(
      "Deployment provider. Use vercel for linked Vercel projects, netlify_cli for Netlify CLI deployments, or custom_command for another provider.",
    ),
  target: z.enum(["preview", "production"]).optional().default("preview"),
  ref: z
    .string()
    .optional()
    .describe(
      "Git ref to deploy. Omit to use the app's configured GitHub branch, falling back to main.",
    ),
  wait_for_ready: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "Wait for Vercel to report READY, ERROR, or a timeout before returning. Default true.",
    ),
  timeout_seconds: z
    .number()
    .min(30)
    .max(1800)
    .optional()
    .default(600)
    .describe("Maximum seconds to wait for the Vercel deployment to finish."),
  poll_interval_seconds: z
    .number()
    .min(5)
    .max(60)
    .optional()
    .default(10)
    .describe("Seconds between Vercel deployment status polls."),
  capture_build_logs: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "Fetch a compact Vercel build-log excerpt after deployment finishes. Default true.",
    ),
  build_log_limit: z
    .number()
    .min(10)
    .max(200)
    .optional()
    .default(80)
    .describe(
      "Maximum Vercel deployment events to include in the log excerpt.",
    ),
  deploy_directory: z
    .string()
    .optional()
    .describe(
      "For Netlify CLI or managed local static deployments, the built directory to deploy, for example dist, build, or native-download-site.",
    ),
  site_id: z
    .string()
    .optional()
    .describe(
      "For Netlify CLI deployments, optional Netlify site id. Omit to use the linked local Netlify project.",
    ),
  build_command: z
    .string()
    .optional()
    .describe(
      "Optional build command to run before Netlify CLI or custom command deployments.",
    ),
  custom_command: z
    .string()
    .optional()
    .describe(
      "For custom_command provider, the command that creates the deployment and prints a URL. If omitted and deploy_directory is set, OrianBuilder serves that static directory locally and returns a localhost URL.",
    ),
  output_url_regex: z
    .string()
    .optional()
    .describe(
      "Optional regex used to extract a deployment URL from Netlify/custom command output. The first capture group is used when present.",
    ),
});

type DeployPreviewArgs = z.infer<typeof deployPreviewSchema>;

function createVercelClient(token: string): Vercel {
  return new Vercel({ bearerToken: token });
}

type DeploymentPollResult = {
  state: string;
  status: "ready" | "failed" | "timeout" | "created";
  url: string;
  readyAt: number | null;
  error: string | null;
};

type DeploymentBuildLogs = {
  status: "captured" | "failed" | "skipped";
  lines: string[];
  error: string | null;
};

const FAILED_DEPLOYMENT_STATES = new Set(["ERROR", "CANCELED"]);
const MAX_BUILD_LOG_CHARS = 16_000;
const MAX_COMMAND_OUTPUT_CHARS = 24_000;
const DEFAULT_URL_REGEX = /(https?:\/\/[^\s"'<>]+)/i;
const localStaticDeployments = new Map<string, http.Server>();
const NOOP_COMMAND_VALUES = new Set([
  "none",
  "null",
  "n/a",
  "na",
  "skip",
  "skipped",
  "false",
]);

type DeploymentProvider = "vercel" | "netlify_cli" | "custom_command";

type CliDeploymentResult = {
  provider: DeploymentProvider;
  status: "ready" | "failed" | "timeout";
  state: string;
  url: string | null;
  error: string | null;
  output: string;
};

function truncateCommandOutput(output: string): string {
  if (output.length <= MAX_COMMAND_OUTPUT_CHARS) {
    return output;
  }
  const half = Math.floor(MAX_COMMAND_OUTPUT_CHARS / 2);
  return `${output.slice(0, half)}\n\n... [deployment output truncated] ...\n\n${output.slice(-half)}`;
}

function extractDeploymentUrl(
  output: string,
  regexSource?: string,
): string | null {
  if (regexSource?.trim()) {
    try {
      const regex = new RegExp(regexSource, "i");
      const match = output.match(regex);
      const value = match?.[1] ?? match?.[0];
      return value && /^https?:\/\//i.test(value) ? value : null;
    } catch {
      return null;
    }
  }
  const match = output.match(DEFAULT_URL_REGEX);
  return match?.[1] ?? match?.[0] ?? null;
}

function normalizeOptionalCommand(command: string | undefined): string | null {
  const trimmed = command?.trim();
  if (!trimmed || NOOP_COMMAND_VALUES.has(trimmed.toLowerCase())) {
    return null;
  }
  return trimmed;
}

function getShellCommandForPlatform(command: string) {
  if (process.platform === "win32") {
    return { file: "cmd.exe", args: ["/d", "/s", "/c", command] };
  }
  return { file: "/bin/sh", args: ["-lc", command] };
}

function getMimeType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".js") return "text/javascript; charset=utf-8";
  if (extension === ".json") return "application/json; charset=utf-8";
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".svg") return "image/svg+xml";
  if (extension === ".apk") return "application/vnd.android.package-archive";
  return "application/octet-stream";
}

async function deployLocalStaticDirectory(input: {
  args: DeployPreviewArgs;
  appPath: string;
  ctx: AgentContext;
}): Promise<CliDeploymentResult> {
  const deployDir = input.args.deploy_directory?.trim();
  if (!deployDir) {
    throw new OrianBuilderError(
      "custom_command provider requires custom_command, or deploy_directory for a managed local static deployment.",
      OrianBuilderErrorKind.Validation,
    );
  }

  const appRoot = path.resolve(input.appPath);
  const siteRoot = path.resolve(appRoot, deployDir);
  if (siteRoot !== appRoot && !siteRoot.startsWith(`${appRoot}${path.sep}`)) {
    throw new OrianBuilderError(
      "deploy_directory must stay inside the current app.",
      OrianBuilderErrorKind.Validation,
    );
  }
  if (!fs.existsSync(path.join(siteRoot, "index.html"))) {
    throw new OrianBuilderError(
      `deploy_directory '${deployDir}' must contain index.html.`,
      OrianBuilderErrorKind.Validation,
    );
  }

  const deploymentKey = `${input.ctx.appId}:${siteRoot}`;
  localStaticDeployments.get(deploymentKey)?.close();

  const port = await findAvailablePort(45000, 59999);
  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url ?? "/", `http://localhost:${port}`);
    const decodedPath = decodeURIComponent(requestUrl.pathname);
    const requestedPath = path.resolve(
      siteRoot,
      decodedPath.replace(/^\/+/, ""),
    );
    if (
      requestedPath !== siteRoot &&
      !requestedPath.startsWith(`${siteRoot}${path.sep}`)
    ) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Forbidden");
      return;
    }

    let filePath = requestedPath;
    try {
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        filePath = path.join(filePath, "index.html");
      }
      const fileStat = fs.statSync(filePath);
      if (!fileStat.isFile()) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }
      res.writeHead(200, {
        "Content-Type": getMimeType(filePath),
        "Content-Length": fileStat.size,
      });
      fs.createReadStream(filePath).pipe(res);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  server.once("close", () => {
    if (localStaticDeployments.get(deploymentKey) === server) {
      localStaticDeployments.delete(deploymentKey);
    }
  });
  localStaticDeployments.set(deploymentKey, server);

  const url = `http://localhost:${port}/`;
  return {
    provider: "custom_command",
    status: "ready",
    state: "READY",
    url,
    error: null,
    output: `Managed local static deployment serving ${deployDir} at ${url}`,
  };
}

async function runDeploymentCommand(input: {
  command: string;
  cwd: string;
  timeoutMs: number;
  onOutput?: (output: string) => void;
}): Promise<{ exitCode: number; output: string; timedOut: boolean }> {
  const shell = getShellCommandForPlatform(input.command);
  return new Promise((resolve) => {
    let output = "";
    let completed = false;
    const proc = spawn(shell.file, shell.args, {
      cwd: input.cwd,
      stdio: "pipe",
      env: { ...process.env },
      windowsHide: true,
    });

    const append = (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      input.onOutput?.(truncateCommandOutput(output));
    };

    const timer = setTimeout(() => {
      if (completed) return;
      completed = true;
      proc.kill("SIGKILL");
      resolve({
        exitCode: 124,
        output: truncateCommandOutput(output),
        timedOut: true,
      });
    }, input.timeoutMs);

    proc.stdout?.on("data", append);
    proc.stderr?.on("data", append);
    proc.on("close", (code) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      resolve({
        exitCode: code ?? 0,
        output: truncateCommandOutput(output),
        timedOut: false,
      });
    });
    proc.on("error", (error) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      resolve({
        exitCode: 1,
        output: truncateCommandOutput(
          `${output}\n[spawn error] ${error.message}`,
        ),
        timedOut: false,
      });
    });
  });
}

async function waitForDeploymentStatus(input: {
  vercel: Vercel;
  deploymentId: string;
  deploymentUrl: string;
  timeoutMs: number;
  intervalMs: number;
  onPoll?: (state: string) => void;
}): Promise<DeploymentPollResult> {
  const deadline = Date.now() + input.timeoutMs;
  let lastState = "QUEUED";
  let lastUrl = input.deploymentUrl;
  let lastError: string | null = null;

  while (Date.now() <= deadline) {
    try {
      const deployment = await input.vercel.deployments.getDeployment({
        idOrUrl: input.deploymentId,
      });
      lastState = deployment.readyState ?? lastState;
      lastUrl = deployment.url ? `https://${deployment.url}` : lastUrl;
      input.onPoll?.(lastState);

      if (lastState === "READY") {
        return {
          state: lastState,
          status: "ready",
          url: lastUrl,
          readyAt: Date.now(),
          error: null,
        };
      }
      if (FAILED_DEPLOYMENT_STATES.has(lastState)) {
        return {
          state: lastState,
          status: "failed",
          url: lastUrl,
          readyAt: null,
          error: `Vercel deployment ended with ${lastState}.`,
        };
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      input.onPoll?.(`poll_error: ${lastError}`);
    }

    await new Promise((resolve) => setTimeout(resolve, input.intervalMs));
  }

  return {
    state: lastState,
    status: "timeout",
    url: lastUrl,
    readyAt: null,
    error: lastError ?? `Timed out after ${input.timeoutMs / 1000}s.`,
  };
}

function getDeploymentEventText(event: unknown): string | null {
  if (!event || typeof event !== "object") {
    return null;
  }
  const record = event as Record<string, unknown>;
  const payload =
    record.payload && typeof record.payload === "object"
      ? (record.payload as Record<string, unknown>)
      : null;
  const text = typeof record.text === "string" ? record.text : payload?.text;
  if (typeof text !== "string" || !text.trim()) {
    return null;
  }
  const type = typeof record.type === "string" ? record.type : "event";
  const level =
    typeof record.level === "string"
      ? record.level
      : typeof payload?.level === "string"
        ? payload.level
        : null;
  const rawDate =
    typeof record.date === "number"
      ? record.date
      : typeof payload?.date === "number"
        ? payload.date
        : typeof record.created === "number"
          ? record.created
          : typeof payload?.created === "number"
            ? payload.created
            : null;
  const timestamp = rawDate
    ? new Date(rawDate).toISOString().slice(11, 23)
    : "--:--:--.---";
  return `[${timestamp}] [${type}${level ? `/${level}` : ""}] ${text.trimEnd()}`;
}

function normalizeDeploymentEventResponse(response: unknown): unknown[] {
  if (Array.isArray(response)) {
    return response.filter(Boolean);
  }
  return response ? [response] : [];
}

function truncateBuildLog(lines: string[]): string[] {
  const result: string[] = [];
  let total = 0;
  for (const line of lines) {
    total += line.length + 1;
    if (total > MAX_BUILD_LOG_CHARS) {
      result.push("... [deployment log truncated] ...");
      break;
    }
    result.push(line);
  }
  return result;
}

async function fetchDeploymentBuildLogs(input: {
  vercel: Vercel;
  deploymentId: string;
  limit: number;
}): Promise<DeploymentBuildLogs> {
  try {
    const response = await input.vercel.deployments.getDeploymentEvents({
      idOrUrl: input.deploymentId,
      direction: "backward",
      limit: input.limit,
      builds: 1,
    });
    const lines = normalizeDeploymentEventResponse(response)
      .map(getDeploymentEventText)
      .filter((line): line is string => Boolean(line))
      .reverse();
    return {
      status: "captured",
      lines: truncateBuildLog(lines),
      error: null,
    };
  } catch (error) {
    return {
      status: "failed",
      lines: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runOptionalBuildCommand(input: {
  command?: string;
  appPath: string;
  timeoutMs: number;
  ctx: AgentContext;
}) {
  const command = normalizeOptionalCommand(input.command);
  if (!command) {
    return "";
  }
  input.ctx.onXmlStream(
    `<orianbuilder-deploy-preview provider="custom_command" status="building">Running build command...`,
  );
  const result = await runDeploymentCommand({
    command,
    cwd: input.appPath,
    timeoutMs: input.timeoutMs,
  });
  if (result.exitCode !== 0) {
    throw new OrianBuilderError(
      `Deployment build command failed with exit code ${result.exitCode}.\n\n${result.output}`,
      OrianBuilderErrorKind.External,
    );
  }
  return result.output;
}

async function deployWithNetlifyCli(input: {
  args: DeployPreviewArgs;
  appPath: string;
  ctx: AgentContext;
}): Promise<CliDeploymentResult> {
  const target = input.args.target ?? "preview";
  const timeoutMs = (input.args.timeout_seconds ?? 600) * 1000;
  const buildOutput = await runOptionalBuildCommand({
    command: input.args.build_command,
    appPath: input.appPath,
    timeoutMs,
    ctx: input.ctx,
  });

  const deployDir = input.args.deploy_directory?.trim() || "dist";
  const siteArg = input.args.site_id?.trim()
    ? ` --site ${JSON.stringify(input.args.site_id.trim())}`
    : "";
  const prodArg = target === "production" ? " --prod" : "";
  const command = `npx netlify deploy --json --dir ${JSON.stringify(deployDir)}${siteArg}${prodArg}`;
  input.ctx.onXmlStream(
    `<orianbuilder-deploy-preview provider="netlify_cli" target="${escapeXmlAttr(target)}" status="running">Running Netlify deployment...`,
  );

  const result = await runDeploymentCommand({
    command,
    cwd: input.appPath,
    timeoutMs,
    onOutput: (output) => {
      input.ctx.onXmlStream(
        `<orianbuilder-deploy-preview provider="netlify_cli" target="${escapeXmlAttr(target)}" status="running">${escapeXmlContent(output)}`,
      );
    },
  });
  const output = [buildOutput, result.output].filter(Boolean).join("\n\n");
  let url = extractDeploymentUrl(output, input.args.output_url_regex);
  try {
    const parsed = JSON.parse(result.output.trim()) as Record<string, unknown>;
    const parsedUrl =
      typeof parsed.deploy_url === "string"
        ? parsed.deploy_url
        : typeof parsed.url === "string"
          ? parsed.url
          : typeof parsed.ssl_url === "string"
            ? parsed.ssl_url
            : null;
    url = parsedUrl ?? url;
  } catch {
    // Netlify can emit logs around JSON in some environments; URL regex handles that.
  }

  return {
    provider: "netlify_cli",
    status: result.timedOut
      ? "timeout"
      : result.exitCode === 0
        ? "ready"
        : "failed",
    state: result.timedOut
      ? "TIMEOUT"
      : result.exitCode === 0
        ? "READY"
        : "ERROR",
    url,
    error:
      result.exitCode === 0
        ? null
        : `Netlify CLI exited with code ${result.exitCode}.`,
    output,
  };
}

async function deployWithCustomCommand(input: {
  args: DeployPreviewArgs;
  appPath: string;
  ctx: AgentContext;
}): Promise<CliDeploymentResult> {
  const command = normalizeOptionalCommand(input.args.custom_command);
  if (!command) {
    return deployLocalStaticDirectory(input);
  }
  const target = input.args.target ?? "preview";
  const timeoutMs = (input.args.timeout_seconds ?? 600) * 1000;
  const buildOutput = await runOptionalBuildCommand({
    command: input.args.build_command,
    appPath: input.appPath,
    timeoutMs,
    ctx: input.ctx,
  });

  input.ctx.onXmlStream(
    `<orianbuilder-deploy-preview provider="custom_command" target="${escapeXmlAttr(target)}" status="running">Running custom deployment command...`,
  );
  const result = await runDeploymentCommand({
    command,
    cwd: input.appPath,
    timeoutMs,
    onOutput: (output) => {
      input.ctx.onXmlStream(
        `<orianbuilder-deploy-preview provider="custom_command" target="${escapeXmlAttr(target)}" status="running">${escapeXmlContent(output)}`,
      );
    },
  });
  const output = [buildOutput, result.output].filter(Boolean).join("\n\n");
  return {
    provider: "custom_command",
    status: result.timedOut
      ? "timeout"
      : result.exitCode === 0
        ? "ready"
        : "failed",
    state: result.timedOut
      ? "TIMEOUT"
      : result.exitCode === 0
        ? "READY"
        : "ERROR",
    url: extractDeploymentUrl(output, input.args.output_url_regex),
    error:
      result.exitCode === 0
        ? null
        : `Custom deployment command exited with code ${result.exitCode}.`,
    output,
  };
}

export const deployPreviewTool: ToolDefinition<DeployPreviewArgs> = {
  name: "deploy_preview",
  description: `Create a preview or production deployment for the app.

Supported providers:
- vercel: deploys the app's linked Vercel project and GitHub repository.
- netlify_cli: runs Netlify CLI in the app directory and captures the deployment URL.
- custom_command: runs a user-specified deployment command and extracts the first deployment URL from output. If no external provider is linked, pass deploy_directory without custom_command to serve that static directory as a managed local download page.

Vercel preconditions:
- Vercel access token is configured in Settings.
- The app is connected to a Vercel project.
- The app is connected to a GitHub repository.
- Local changes must already be committed and pushed to the selected branch; this deploys a Git ref, not unsaved local files.

Netlify/custom preconditions:
- Required CLIs or provider auth must already be available in the app environment.
- Run build/test/browser QA first. Use build_command when the deployment command expects built files.

Use this after build/test/browser QA passes when the user wants a preview or production deployment URL. The tool returns a durable deployment artifact with provider, URL, status, state, errors, and compact logs.`,
  inputSchema: deployPreviewSchema,
  defaultConsent: "ask",
  modifiesState: true,

  getConsentPreview: (args) =>
    `Create ${args.target ?? "preview"} ${args.provider ?? "vercel"} deployment${args.ref ? ` for ${args.ref}` : ""}`,

  buildXml: (args, isComplete) => {
    if (isComplete) return undefined;
    return `<orianbuilder-deploy-preview provider="${escapeXmlAttr(args.provider ?? "vercel")}" target="${escapeXmlAttr(args.target ?? "preview")}" status="running">Creating deployment...`;
  },

  execute: async (args, ctx: AgentContext) => {
    const app = await db.query.apps.findFirst({
      where: eq(apps.id, ctx.appId),
    });
    if (!app) {
      throw new OrianBuilderError(
        "App not found.",
        OrianBuilderErrorKind.NotFound,
      );
    }

    const provider = args.provider ?? "vercel";
    if (provider === "netlify_cli" || provider === "custom_command") {
      const cliResult =
        provider === "netlify_cli"
          ? await deployWithNetlifyCli({ args, appPath: ctx.appPath, ctx })
          : await deployWithCustomCommand({ args, appPath: ctx.appPath, ctx });
      const target = args.target ?? "preview";
      const summary = [
        `${provider} ${target} deployment ${cliResult.status}.`,
        cliResult.url ? `URL: ${cliResult.url}` : "URL: not found in output",
        `Final state: ${cliResult.state}`,
        cliResult.error ? `Error: ${cliResult.error}` : null,
        "",
        "Deployment output:",
        cliResult.output || "(no output)",
      ]
        .filter((line): line is string => line !== null)
        .join("\n");

      ctx.onXmlComplete(
        `<orianbuilder-deploy-preview provider="${escapeXmlAttr(provider)}" target="${escapeXmlAttr(target)}" status="${escapeXmlAttr(cliResult.status)}" url="${escapeXmlAttr(cliResult.url ?? "")}" state="${escapeXmlAttr(cliResult.state)}" initial-state="STARTED" error="${escapeXmlAttr(cliResult.error ?? "")}" build-log-status="captured" build-log-count="${cliResult.output ? cliResult.output.split(/\r?\n/).length : 0}">${escapeXmlContent(summary)}</orianbuilder-deploy-preview>`,
      );
      return summary;
    }

    const settings = readSettings();
    const accessToken = settings.vercelAccessToken?.value;
    if (!accessToken) {
      throw new OrianBuilderError(
        "Not authenticated with Vercel.",
        OrianBuilderErrorKind.Auth,
      );
    }

    if (!app.vercelProjectId || !app.vercelProjectName) {
      throw new OrianBuilderError(
        "App is not linked to a Vercel project.",
        OrianBuilderErrorKind.Precondition,
      );
    }
    if (!app.githubOrg || !app.githubRepo) {
      throw new OrianBuilderError(
        "App must be connected to a GitHub repository before deploying to Vercel.",
        OrianBuilderErrorKind.Precondition,
      );
    }

    const target = args.target ?? "preview";
    const ref = args.ref?.trim() || app.githubBranch || "main";
    ctx.onXmlStream(
      `<orianbuilder-deploy-preview provider="vercel" target="${escapeXmlAttr(target)}" ref="${escapeXmlAttr(ref)}" status="running">Creating Vercel deployment...`,
    );

    const vercel = createVercelClient(accessToken);
    const deployment = await vercel.deployments.createDeployment({
      requestBody: {
        name: app.vercelProjectName,
        project: app.vercelProjectId,
        target,
        gitSource: {
          type: "github",
          org: app.githubOrg,
          repo: app.githubRepo,
          ref,
        },
      },
    });

    const deploymentUrl = deployment.url ? `https://${deployment.url}` : null;
    if (!deploymentUrl) {
      throw new OrianBuilderError(
        "Vercel did not return a deployment URL.",
        OrianBuilderErrorKind.External,
      );
    }

    const initialState = deployment.readyState ?? "QUEUED";
    let final: DeploymentPollResult = {
      state: initialState,
      status: "created",
      url: deploymentUrl,
      readyAt: null,
      error: null,
    };

    if (args.wait_for_ready !== false) {
      final = await waitForDeploymentStatus({
        vercel,
        deploymentId: deployment.id,
        deploymentUrl,
        timeoutMs: (args.timeout_seconds ?? 600) * 1000,
        intervalMs: (args.poll_interval_seconds ?? 10) * 1000,
        onPoll: (state) => {
          ctx.onXmlStream(
            `<orianbuilder-deploy-preview provider="vercel" target="${escapeXmlAttr(target)}" ref="${escapeXmlAttr(ref)}" status="polling" url="${escapeXmlAttr(deploymentUrl)}" project-id="${escapeXmlAttr(app.vercelProjectId!)}" project-name="${escapeXmlAttr(app.vercelProjectName!)}" state="${escapeXmlAttr(state)}">Waiting for Vercel deployment: ${escapeXmlContent(state)}`,
          );
        },
      });
    }

    if (target === "production" && final.status === "ready") {
      await db
        .update(apps)
        .set({ vercelDeploymentUrl: final.url })
        .where(eq(apps.id, ctx.appId));
    }

    const buildLogs =
      args.capture_build_logs === false
        ? ({
            status: "skipped",
            lines: [],
            error: null,
          } satisfies DeploymentBuildLogs)
        : await fetchDeploymentBuildLogs({
            vercel,
            deploymentId: deployment.id,
            limit: args.build_log_limit ?? 80,
          });

    const summary = [
      `Vercel ${target} deployment ${final.status}.`,
      `URL: ${final.url}`,
      `Project: ${app.vercelProjectName}`,
      `GitHub: ${app.githubOrg}/${app.githubRepo}@${ref}`,
      `Initial state: ${initialState}`,
      `Final state: ${final.state}`,
      final.readyAt
        ? `Ready at: ${new Date(final.readyAt).toISOString()}`
        : null,
      final.error ? `Error: ${final.error}` : null,
      `Build logs: ${buildLogs.status}${buildLogs.error ? ` (${buildLogs.error})` : ""}`,
      buildLogs.lines.length > 0 ? "" : null,
      buildLogs.lines.length > 0 ? "Build log excerpt:" : null,
      ...buildLogs.lines,
    ]
      .filter((line): line is string => line !== null)
      .join("\n");

    ctx.onXmlComplete(
      `<orianbuilder-deploy-preview provider="vercel" target="${escapeXmlAttr(target)}" ref="${escapeXmlAttr(ref)}" status="${escapeXmlAttr(final.status)}" url="${escapeXmlAttr(final.url)}" project-id="${escapeXmlAttr(app.vercelProjectId)}" project-name="${escapeXmlAttr(app.vercelProjectName)}" state="${escapeXmlAttr(final.state)}" initial-state="${escapeXmlAttr(String(initialState))}" error="${escapeXmlAttr(final.error ?? "")}" build-log-status="${escapeXmlAttr(buildLogs.status)}" build-log-count="${buildLogs.lines.length}">${escapeXmlContent(summary)}</orianbuilder-deploy-preview>`,
    );

    return summary;
  },
};
