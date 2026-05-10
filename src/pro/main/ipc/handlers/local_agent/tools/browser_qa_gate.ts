import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { runAppById } from "@/ipc/handlers/app_handlers";
import { ORIANBUILDER_MEDIA_DIR_NAME } from "@/ipc/utils/media_path_utils";
import {
  getManagedRuntimePreviewUrl,
  waitForManagedRuntimeReady,
} from "@/ipc/utils/runtime_readiness";
import { getLogs } from "@/lib/log_store";
import {
  AgentContext,
  escapeXmlAttr,
  escapeXmlContent,
  ToolDefinition,
} from "./types";

const browserQaGateSchema = z.object({
  start_runtime: z.boolean().optional().default(true),
  full_page: z.boolean().optional().default(false),
  runtime_timeout_seconds: z.number().min(5).max(180).optional().default(45),
});

type BrowserQaGateArgs = z.infer<typeof browserQaGateSchema>;

type GateStatus = "passed" | "failed";

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 390, height: 844 },
] as const;

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

const NOISE_PATTERNS = [
  /^\s*$/,
  /vite.*ready/i,
  /hmr\s+update/i,
  /page\s+reload/i,
  /local:\s+http/i,
  /network:\s+http/i,
  /press\s+h\s+to\s+show\s+help/i,
];

type BrowserQaResult = {
  status: GateStatus;
  runtimeStatus: GateStatus;
  runtimeUrl: string;
  runtimeError: string | null;
  desktopPath: string | null;
  mobilePath: string | null;
  screenshotStatus: GateStatus;
  accessibilityStatus: GateStatus;
  accessibilityText: string;
  consoleStatus: GateStatus;
  consoleOutput: string;
  browserError: string | null;
};

function looksLikeProblem(message: string): boolean {
  if (NOISE_PATTERNS.some((pattern) => pattern.test(message))) return false;
  return ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

async function saveScreenshot(appPath: string, buffer: Buffer, prefix: string) {
  const mediaDir = path.join(appPath, ORIANBUILDER_MEDIA_DIR_NAME);
  await fs.mkdir(mediaDir, { recursive: true });
  const hash = crypto.randomBytes(6).toString("hex");
  const fileName = `${prefix}-${Date.now()}-${hash}.png`;
  const filePath = path.join(mediaDir, fileName);
  const relativePath = path.join(ORIANBUILDER_MEDIA_DIR_NAME, fileName);
  await fs.writeFile(filePath, buffer);
  return relativePath;
}

function readRecentConsole(appId: number) {
  const cutoff = Date.now() - 2 * 60 * 1000;
  const entries = getLogs(appId)
    .filter((entry) => entry.timestamp >= cutoff)
    .filter((entry) => looksLikeProblem(entry.message))
    .slice(-30);

  if (entries.length === 0) {
    return {
      status: "passed" as const,
      output:
        "No console errors or warnings found in the last 2 minutes. The app appears to be running cleanly.",
    };
  }

  return {
    status: "failed" as const,
    output: entries
      .map((entry) => {
        const ts = new Date(entry.timestamp).toISOString().slice(11, 23);
        return `[${ts}] [${entry.level.toUpperCase()}] ${entry.message.trimEnd().slice(0, 2000)}`;
      })
      .join("\n"),
  };
}

async function runBrowserQa(
  args: BrowserQaGateArgs,
  ctx: AgentContext,
): Promise<BrowserQaResult> {
  if (args.start_runtime !== false) {
    await runAppById(ctx.event, ctx.appId);
  }

  const readiness = await waitForManagedRuntimeReady({
    appId: ctx.appId,
    timeoutMs: (args.runtime_timeout_seconds ?? 45) * 1000,
  });
  const runtimeUrl =
    readiness.previewUrl ?? getManagedRuntimePreviewUrl(ctx.appId);
  const runtimeStatus: GateStatus = readiness.ready ? "passed" : "failed";

  let desktopPath: string | null = null;
  let mobilePath: string | null = null;
  let accessibilityText = "";
  let screenshotStatus: GateStatus = "failed";
  let accessibilityStatus: GateStatus = "failed";
  let browserError: string | null = null;

  if (readiness.ready) {
    try {
      const { chromium } = await import("playwright");
      const browser = await chromium.launch({ headless: true });
      try {
        for (const viewport of VIEWPORTS) {
          const page = await browser.newPage({
            viewport: { width: viewport.width, height: viewport.height },
          });
          await page.goto(runtimeUrl, {
            waitUntil: "networkidle",
            timeout: 15_000,
          });
          const screenshot = (await page.screenshot({
            type: "png",
            fullPage: args.full_page ?? false,
          })) as Buffer;
          const saved = await saveScreenshot(
            ctx.appPath,
            screenshot,
            `browser-qa-${viewport.name}`,
          );
          if (viewport.name === "desktop") {
            desktopPath = saved;
          } else {
            mobilePath = saved;
          }
          ctx.appendUserMessage([
            {
              type: "text",
              text: `${viewport.name} browser QA screenshot of ${runtimeUrl}:`,
            },
            {
              type: "image-url",
              url: `data:image/png;base64,${screenshot.toString("base64")}`,
            },
          ]);
          await page.close();
        }
        screenshotStatus = desktopPath && mobilePath ? "passed" : "failed";

        const page = await browser.newPage({
          viewport: { width: 1280, height: 800 },
        });
        await page.goto(runtimeUrl, {
          waitUntil: "networkidle",
          timeout: 15_000,
        });
        accessibilityText =
          (await page.locator("body").ariaSnapshot({ ref: false } as any)) ??
          "(empty accessibility tree)";
        accessibilityStatus = accessibilityText.trim() ? "passed" : "failed";
        await page.close();
      } finally {
        await browser.close();
      }
    } catch (error) {
      browserError = error instanceof Error ? error.message : String(error);
      accessibilityText = browserError;
    }
  }

  const consoleResult = readRecentConsole(ctx.appId);
  const status: GateStatus =
    runtimeStatus === "passed" &&
    screenshotStatus === "passed" &&
    accessibilityStatus === "passed" &&
    consoleResult.status === "passed"
      ? "passed"
      : "failed";

  return {
    status,
    runtimeStatus,
    runtimeUrl,
    runtimeError: readiness.error,
    desktopPath,
    mobilePath,
    screenshotStatus,
    accessibilityStatus,
    accessibilityText,
    consoleStatus: consoleResult.status,
    consoleOutput: consoleResult.output,
    browserError,
  };
}

export const browserQaGateTool: ToolDefinition<BrowserQaGateArgs> = {
  name: "browser_qa_gate",
  description: `Run the required browser QA gate for UI missions.

This starts or reuses the managed preview, waits for runtime readiness, captures desktop and mobile screenshots, records an accessibility snapshot, and checks recent console errors. Use this before claiming UI work is complete.`,
  inputSchema: browserQaGateSchema,
  defaultConsent: "ask",
  modifiesState: true,

  getConsentPreview: () =>
    "Run browser QA gate with runtime, screenshots, accessibility, and console checks",

  buildXml: (_args, isComplete) => {
    if (isComplete) return undefined;
    return `<orianbuilder-browser-qa status="running">Running browser QA gate...`;
  },

  execute: async (args, ctx) => {
    ctx.onXmlStream(
      `<orianbuilder-browser-qa status="running">Running browser QA gate...`,
    );
    const result = await runBrowserQa(args, ctx);
    const report = [
      `Browser QA ${result.status}.`,
      `runtime: ${result.runtimeStatus} - ${result.runtimeUrl}`,
      `desktop screenshot: ${result.desktopPath ?? "missing"}`,
      `mobile screenshot: ${result.mobilePath ?? "missing"}`,
      `accessibility: ${result.accessibilityStatus}`,
      `console: ${result.consoleStatus}`,
      result.runtimeError ? `runtime error: ${result.runtimeError}` : null,
      result.browserError ? `browser error: ${result.browserError}` : null,
      "",
      "Accessibility snapshot:",
      result.accessibilityText.trim() || "(empty)",
      "",
      "Console check:",
      result.consoleOutput.trim() || "(empty)",
    ]
      .filter((line): line is string => line !== null)
      .join("\n");

    ctx.onXmlComplete(
      `<orianbuilder-browser-qa status="${result.status}" runtime-status="${result.runtimeStatus}" runtime-url="${escapeXmlAttr(result.runtimeUrl)}" runtime-error="${escapeXmlAttr(result.runtimeError ?? "")}" browser-error="${escapeXmlAttr(result.browserError ?? "")}" screenshot-status="${result.screenshotStatus}" desktop-path="${escapeXmlAttr(result.desktopPath ?? "")}" mobile-path="${escapeXmlAttr(result.mobilePath ?? "")}" accessibility-status="${result.accessibilityStatus}" console-status="${result.consoleStatus}">${escapeXmlContent(report)}</orianbuilder-browser-qa>`,
    );
    return report;
  },
};
