import { z } from "zod";
import log from "electron-log";
import {
  AgentContext,
  escapeXmlAttr,
  escapeXmlContent,
  ToolDefinition,
} from "./types";
import { runAppById, stopAppById } from "@/ipc/handlers/app_handlers";
import {
  getManagedRuntimeStatus,
  waitForManagedRuntimeReady,
} from "@/ipc/utils/runtime_readiness";

const logger = log.scope("start_dev_server");

const startDevServerSchema = z.object({
  restart: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Stop and restart the dev server even if one is already running.",
    ),
  timeout_seconds: z
    .number()
    .min(5)
    .max(120)
    .optional()
    .default(45)
    .describe("How long to wait for the preview URL to become reachable."),
});

type StartDevServerArgs = z.infer<typeof startDevServerSchema>;
const stopDevServerSchema = z.object({});
type StopDevServerArgs = z.infer<typeof stopDevServerSchema>;
const readDevServerOutputSchema = z.object({
  limit: z.number().min(1).max(100).optional().default(30),
});
type ReadDevServerOutputArgs = z.infer<typeof readDevServerOutputSchema>;

export const startDevServerTool: ToolDefinition<StartDevServerArgs> = {
  name: "start_dev_server",
  description: `Start or reuse the managed app preview runtime and wait until it is reachable.

Use this before visual QA, screenshots, accessibility checks, or console checks. This tool uses Orian Builder's managed app runtime instead of a short-lived terminal command, so it can safely track the process, proxy URL, logs, and readiness.`,
  inputSchema: startDevServerSchema,
  defaultConsent: "ask",
  modifiesState: true,

  getConsentPreview: (args) =>
    args.restart ? "Restart managed dev server" : "Start managed dev server",

  buildXml: (_args, isComplete) => {
    if (isComplete) return undefined;
    return `<orianbuilder-runtime-session status="starting">Starting dev server...`;
  },

  execute: async (args, ctx: AgentContext) => {
    logger.log(`start_dev_server: appId=${ctx.appId}`);
    ctx.onXmlStream(
      `<orianbuilder-runtime-session status="starting">Starting dev server...`,
    );

    if (args.restart) {
      await stopAppById(ctx.appId);
    }

    await runAppById(ctx.event, ctx.appId);

    const readiness = await waitForManagedRuntimeReady({
      appId: ctx.appId,
      timeoutMs: (args.timeout_seconds ?? 45) * 1000,
    });
    const status = readiness.ready ? "running" : "failed";
    const output = readiness.recentOutput.slice(-10).join("\n");

    ctx.onXmlComplete(
      `<orianbuilder-runtime-session status="${status}" ready="${readiness.ready ? "true" : "false"}" url="${escapeXmlAttr(readiness.previewUrl ?? "")}" mode="${escapeXmlAttr(readiness.mode ?? "")}" process-id="${readiness.processId ?? ""}" pid="${readiness.pid ?? ""}" status-code="${readiness.statusCode ?? ""}" error="${escapeXmlAttr(readiness.error ?? "")}">${escapeXmlContent(output)}</orianbuilder-runtime-session>`,
    );

    if (!readiness.ready) {
      return `Managed dev server did not become ready at ${readiness.previewUrl ?? "the preview URL"}: ${readiness.error ?? "unknown error"}. Recent output:\n${output || "(no output)"}`;
    }

    return `Managed dev server is ready at ${readiness.previewUrl}.`;
  },
};

export const stopDevServerTool: ToolDefinition<StopDevServerArgs> = {
  name: "stop_dev_server",
  description:
    "Stop the managed app preview runtime for the current app. Use only when the mission no longer needs the running preview.",
  inputSchema: stopDevServerSchema,
  defaultConsent: "ask",
  modifiesState: true,

  getConsentPreview: () => "Stop managed dev server",

  buildXml: (_args, isComplete) => {
    if (isComplete) return undefined;
    return `<orianbuilder-runtime-session status="stopping">Stopping dev server...`;
  },

  execute: async (_args, ctx: AgentContext) => {
    await stopAppById(ctx.appId);
    ctx.onXmlComplete(
      `<orianbuilder-runtime-session status="stopped" ready="false"></orianbuilder-runtime-session>`,
    );
    return "Managed dev server stopped.";
  },
};

export const readDevServerOutputTool: ToolDefinition<ReadDevServerOutputArgs> =
  {
    name: "read_dev_server_output",
    description:
      "Read recent managed dev-server status and output for the current app.",
    inputSchema: readDevServerOutputSchema,
    defaultConsent: "always",

    getConsentPreview: () => "Read managed dev-server output",

    buildXml: (_args, isComplete) => {
      if (isComplete) return undefined;
      return `<orianbuilder-runtime-output>Reading dev-server output...`;
    },

    execute: async (args, ctx: AgentContext) => {
      const status = getManagedRuntimeStatus(ctx.appId);
      const output = status.recentOutput.slice(-(args.limit ?? 30)).join("\n");
      ctx.onXmlComplete(
        `<orianbuilder-runtime-output status="${status.status}" url="${escapeXmlAttr(status.previewUrl ?? "")}" mode="${escapeXmlAttr(status.mode ?? "")}" process-id="${status.processId ?? ""}" pid="${status.pid ?? ""}">${escapeXmlContent(output)}</orianbuilder-runtime-output>`,
      );
      return `Runtime status: ${status.status}\nPreview URL: ${status.previewUrl ?? "(not available)"}\n\n${output || "(no recent output)"}`;
    },
  };
