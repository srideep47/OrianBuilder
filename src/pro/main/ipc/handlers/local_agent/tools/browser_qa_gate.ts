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
  runtime_timeout_seconds: z
    .number()
    .min(5)
    .max(240)
    .optional()
    .describe(
      "Max seconds to wait for the runtime to be ready. Defaults to 45s for most projects and 120s for Expo (where expo export + serve startup is slow).",
    ),
});

async function isExpoProject(appPath: string): Promise<boolean> {
  try {
    await fs.access(path.join(appPath, "app.json"));
    return true;
  } catch {}
  try {
    await fs.access(path.join(appPath, "app", "index.tsx"));
    return true;
  } catch {}
  return false;
}

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

/**
 * Strings that indicate the app is still showing the Expo scaffold placeholder
 * and has not been implemented yet. Any match forces QA to fail.
 */
const PLACEHOLDER_PATTERNS = [
  /⚠\s*PLACEHOLDER/i,
  /scaffold starter screen/i,
  /Replace app\/index\.tsx/i,
  /Edit app\/index\.tsx to build/i,
] as const;

function isPlaceholderScreen(text: string): boolean {
  return PLACEHOLDER_PATTERNS.some((p) => p.test(text));
}

/**
 * Minimal but valid Expo Router screen used as the 3rd-strike auto-write.
 * Renders something visibly different from the yellow placeholder so QA
 * progresses to runtime/screenshot/console checks. The agent can then
 * customize it to match the actual user request.
 */
function buildDefaultExpoScreen(): string {
  return `import { StyleSheet, Text, View } from "react-native";

export default function Index() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>App is running</Text>
      <Text style={styles.subtitle}>
        This is a default screen written by the build harness because the
        agent failed to implement the requested UI after multiple attempts.
        Edit app/index.tsx to customize.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#0b0d12",
    padding: 24,
  },
  title: {
    color: "#f8fafc",
    fontSize: 28,
    fontWeight: "600",
    marginBottom: 12,
  },
  subtitle: {
    color: "#94a3b8",
    fontSize: 14,
    textAlign: "center",
  },
});
`;
}

/**
 * Skeleton the agent can adapt during a 2nd-strike refusal. Includes the
 * required imports + a StyleSheet so weak models have less to fabricate.
 */
function buildExpoScreenTemplate(): string {
  return `import { StyleSheet, Text, View } from "react-native";

export default function Index() {
  return (
    <View style={styles.container}>
      {/* TODO: replace with the user's requested UI */}
      <Text style={styles.text}>Hello</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#fff",
  },
  text: {
    fontSize: 18,
    color: "#111",
  },
});
`;
}

const NOISE_PATTERNS = [
  /^\s*$/,
  /vite.*ready/i,
  /hmr\s+update/i,
  /page\s+reload/i,
  /local:\s+http/i,
  /network:\s+http/i,
  /press\s+h\s+to\s+show\s+help/i,
  /useLayoutEffect does nothing on the server/i,
  /props\.pointerEvents is deprecated/i,
  /"shadow\*" style props are deprecated/i,
  /Image: style\.resizeMode is deprecated/i,
  /style\.resizeMode is deprecated/i,
  /setNativeProps is deprecated/i,
  /react-native-web.*deprecat/i,
  /deprecat.*react-native-web/i,
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
  placeholderDetected: boolean;
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

  const expoDefault = (await isExpoProject(ctx.appPath)) ? 120 : 45;
  const effectiveTimeoutSeconds = args.runtime_timeout_seconds ?? expoDefault;
  const readiness = await waitForManagedRuntimeReady({
    appId: ctx.appId,
    timeoutMs: effectiveTimeoutSeconds * 1000,
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
  const placeholderDetected = isPlaceholderScreen(accessibilityText);

  const status: GateStatus =
    runtimeStatus === "passed" &&
    screenshotStatus === "passed" &&
    accessibilityStatus === "passed" &&
    consoleResult.status === "passed" &&
    !placeholderDetected
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
    placeholderDetected,
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
    const unresolvedFailure = ctx.runState.unresolvedCommandFailure;
    if (unresolvedFailure) {
      ctx.runState.lastBrowserQaStatus = "failed";
      const reason =
        `Browser QA deferred because a required command is still failing: ` +
        `\`${unresolvedFailure.command}\` exited with ${unresolvedFailure.exitCode}. ` +
        `Fix or retry that command successfully before running Browser QA.\n\n` +
        unresolvedFailure.output;
      ctx.appendUserMessage([
        {
          type: "text",
          text:
            `[execution gate] Do not run browser_qa_gate or package_native_artifact yet. ` +
            `The command \`${unresolvedFailure.command}\` failed with exit code ${unresolvedFailure.exitCode}. ` +
            `Diagnose it, use the project's detected package manager, retry it, and continue automatically after it passes.`,
        },
      ]);
      ctx.onXmlComplete(
        `<orianbuilder-browser-qa status="failed" runtime-status="skipped" runtime-url="" runtime-error="${escapeXmlAttr(`unresolved command failure: ${unresolvedFailure.command}`)}" browser-error="" screenshot-status="failed" desktop-path="" mobile-path="" accessibility-status="failed" console-status="failed">${escapeXmlContent(reason)}</orianbuilder-browser-qa>`,
      );
      return reason;
    }

    const indexPath = path.join(ctx.appPath, "app", "index.tsx");
    let indexExists = false;
    let indexSource = "";
    try {
      indexSource = await fs.readFile(indexPath, "utf-8");
      indexExists = true;
    } catch {
      // app/index.tsx doesn't exist (non-Expo project) — fall through to normal QA.
    }

    if (indexExists) {
      const isPlaceholder = PLACEHOLDER_PATTERNS.some((pattern) =>
        pattern.test(indexSource),
      );

      // The scaffold now ships a working baseline counter app, so we only
      // refuse when the file *literally still matches the old yellow
      // placeholder text* (e.g., a project scaffolded before this update, or
      // an agent that reverted the baseline). Skipped-implementation is no
      // longer a refusal: an unmodified baseline is a valid (if generic) app.
      if (isPlaceholder) {
        ctx.runState.lastBrowserQaStatus = "failed";
        ctx.runState.lastBrowserQaPlaceholderDetected = true;
        ctx.runState.placeholderRefusalCount += 1;
        const refusalCount = ctx.runState.placeholderRefusalCount;
        const reason =
          "app/index.tsx still contains the legacy unimplemented scaffold placeholder.";

        // Third strike: auto-write a sensible default so weak local models
        // cannot dead-end the turn. The user can still iterate further; this
        // just unblocks the pipeline so packaging can succeed.
        if (refusalCount >= 3) {
          const defaultContent = buildDefaultExpoScreen();
          await fs.writeFile(indexPath, defaultContent, "utf-8");
          ctx.runState.filesWrittenSinceCreateProject.add("app/index.tsx");
          const autoMessage =
            `browser_qa_gate auto-wrote app/index.tsx with a sensible default after ${refusalCount} placeholder refusals. ` +
            `The model failed to implement the requested UI after multiple directives. ` +
            `A minimal valid Expo screen is now in place. You can re-run browser_qa_gate to verify, ` +
            `or write_file again to customise the UI to match the user's request.`;
          ctx.appendUserMessage([
            {
              type: "text",
              text:
                `[gate] After ${refusalCount} placeholder refusals, the harness auto-wrote a default app/index.tsx so the pipeline can proceed. ` +
                `Now: (1) re-run browser_qa_gate to verify, (2) then customize app/index.tsx with write_file to match the user's actual request, ` +
                `(3) re-run browser_qa_gate, (4) then call package_native_artifact.`,
            },
          ]);
          ctx.onXmlComplete(
            `<orianbuilder-browser-qa status="failed" runtime-status="failed" runtime-url="" runtime-error="${escapeXmlAttr(`auto-wrote default after ${refusalCount} refusals`)}" browser-error="" screenshot-status="failed" desktop-path="" mobile-path="" accessibility-status="failed" console-status="failed">${escapeXmlContent(autoMessage)}</orianbuilder-browser-qa>`,
          );
          return autoMessage;
        }

        // Second strike: push the file content + a template the agent can
        // copy-modify, so it doesn't need to call read_file separately.
        const escalatedBody =
          refusalCount >= 2
            ? "\n\nCurrent app/index.tsx content (USE write_file to REPLACE this with real UI):\n```tsx\n" +
              indexSource.slice(0, 4000) +
              "\n```\n\nTEMPLATE you can adapt (replace the body of the View with the user's requested UI):\n```tsx\n" +
              buildExpoScreenTemplate() +
              "\n```"
            : "";

        const message =
          `browser_qa_gate refused (attempt ${refusalCount}/3): ${reason} ` +
          "REQUIRED NEXT STEPS (in order): " +
          "(1) write_file on app/index.tsx with the implemented UI using React Native components and StyleSheet " +
          "(2) re-run browser_qa_gate. " +
          "Do NOT call package_native_artifact until QA reports status=passed." +
          escalatedBody;
        ctx.appendUserMessage([
          {
            type: "text",
            text:
              `[gate refusal ${refusalCount}/3] ${reason} ` +
              "Your VERY NEXT tool call MUST be write_file({path: 'app/index.tsx', content: '...real UI here...'}). " +
              "Use React Native components (View, Text, StyleSheet). " +
              "Then call browser_qa_gate again. Do not call package_native_artifact yet." +
              (refusalCount >= 2
                ? " The current file content is provided below — replace it with real UI."
                : ""),
          },
        ]);
        ctx.onXmlComplete(
          `<orianbuilder-browser-qa status="failed" runtime-status="failed" runtime-url="" runtime-error="${escapeXmlAttr(reason)}" browser-error="" screenshot-status="failed" desktop-path="" mobile-path="" accessibility-status="failed" console-status="failed">${escapeXmlContent(message)}</orianbuilder-browser-qa>`,
        );
        return message;
      }
    }

    ctx.onXmlStream(
      `<orianbuilder-browser-qa status="running">Running browser QA gate...`,
    );
    ctx.emitProgress?.({
      id: "browser_qa",
      label: "Running browser QA",
      status: "in-progress",
    });
    const result = await runBrowserQa(args, ctx);
    ctx.emitProgress?.({
      id: "browser_qa",
      label:
        result.status === "passed" ? "Browser QA passed" : "Browser QA failed",
      status: result.status === "passed" ? "completed" : "failed",
    });
    ctx.runState.lastBrowserQaStatus = result.status;
    ctx.runState.lastBrowserQaPlaceholderDetected = result.placeholderDetected;
    const report = [
      `Browser QA ${result.status}.`,
      `runtime: ${result.runtimeStatus} - ${result.runtimeUrl}`,
      `desktop screenshot: ${result.desktopPath ?? "missing"}`,
      `mobile screenshot: ${result.mobilePath ?? "missing"}`,
      `accessibility: ${result.accessibilityStatus}`,
      `console: ${result.consoleStatus}`,
      result.runtimeError ? `runtime error: ${result.runtimeError}` : null,
      result.browserError ? `browser error: ${result.browserError}` : null,
      result.placeholderDetected
        ? "\n⛔ IMPLEMENTATION REQUIRED: The app is showing the unimplemented scaffold placeholder screen. You MUST write the actual app content to app/index.tsx now and re-run QA. Do NOT call package_native_artifact until QA passes without this error."
        : null,
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
