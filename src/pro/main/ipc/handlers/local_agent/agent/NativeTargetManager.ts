/**
 * Native target (Capacitor/Expo) autofinish sequence for local-agent.
 *
 * When the user asked for a native app and the agent loop ended without
 * producing all required artifacts (app/index.tsx customized, browser QA
 * passed, APK packaged, download page deployed), this module finishes the
 * remaining steps as best-effort post-stream calls.
 */

import type { LanguageModel } from "ai";
import log from "electron-log";

import { browserQaGateTool } from "../tools/browser_qa_gate";
import { packageNativeArtifactTool } from "../tools/package_native_artifact";
import { deployPreviewTool } from "../tools/deploy_preview";
import { autoImplementAppIndex } from "../auto_implement";
import { logMissionEvent } from "@/ipc/utils/mission_utils";
import type { NativeTargetIntent } from "../native_target_intent";
import type { AgentContext } from "../tools/types";

import { getErrorMessage } from "./AgentStepProcessor";

const logger = log.scope("local_agent_handler");

/**
 * Mutable flags tracking which native deliverables this run has produced.
 *
 * These get flipped by `ctx.onXmlComplete` callbacks as tool output XML is
 * parsed. Wrapping them in an object lets the same reference be shared
 * between the streaming loop (where the callbacks live) and the post-stream
 * autofinish sequence (where these flags drive whether each gate runs).
 */
export type NativeOutcomeState = {
  attemptedNativePackageArtifact: boolean;
  producedNativePackageArtifact: boolean;
  producedDeploymentUrl: boolean;
  producedBrowserQaScreenshotArtifact: boolean;
  passedBrowserQaGate: boolean;
};

export function createNativeOutcomeState(): NativeOutcomeState {
  return {
    attemptedNativePackageArtifact: false,
    producedNativePackageArtifact: false,
    producedDeploymentUrl: false,
    producedBrowserQaScreenshotArtifact: false,
    passedBrowserQaGate: false,
  };
}

type RunState = {
  lastBrowserQaStatus: "passed" | "failed" | null;
  lastBrowserQaPlaceholderDetected: boolean;
  filesWrittenSinceCreateProject: Set<string>;
  createdProjectThisTurn: boolean;
  lockedPaths: string[];
  placeholderRefusalCount: number;
};

type AutofinishToolDef =
  | typeof browserQaGateTool
  | typeof packageNativeArtifactTool
  | typeof deployPreviewTool;

async function executeNativeAutofinishTool(params: {
  tool: AutofinishToolDef;
  args: Record<string, unknown>;
  inputPreview: string;
  ctx: AgentContext;
  warningMessages: string[];
}): Promise<boolean> {
  const { tool, args, inputPreview, ctx, warningMessages } = params;
  const allowed = await ctx.requireConsent({
    toolName: tool.name,
    toolDescription: tool.description,
    inputPreview,
  });
  if (!allowed) {
    return false;
  }

  const modifiesState = tool.modifiesState === true;
  ctx.onToolExecutionStart?.({
    toolName: tool.name,
    inputPreview,
    modifiesState,
  });
  try {
    const output = await tool.execute(args as never, ctx);
    ctx.onToolExecutionComplete?.({
      toolName: tool.name,
      status: "completed",
      durationMs: 0,
      outputPreview: String(output).slice(0, 4000),
      error: null,
      modifiesState,
    });
    return true;
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    ctx.onToolExecutionComplete?.({
      toolName: tool.name,
      status: "failed",
      durationMs: 0,
      outputPreview: null,
      error: errorMessage,
      modifiesState,
    });
    warningMessages.push(`${tool.name} failed: ${errorMessage}`);
    return false;
  }
}

/**
 * Run the native-target post-stream autofinish sequence.
 *
 * Returns the number of tools actually executed (used for dead-run detection).
 *
 * The function mutates `outcome` indirectly: each tool's XML output flows
 * through `ctx.onXmlComplete`, which is the closure that flips the booleans
 * on the outcome object. Subsequent gates read those booleans to decide
 * whether to run.
 */
export async function runNativeAutofinishSequence(params: {
  nativeTargetIntent: NativeTargetIntent | null;
  outcome: NativeOutcomeState;
  runState: RunState;
  ctx: AgentContext;
  req: { prompt?: string | null; chatId: number };
  appPath: string;
  missionId: number | null | undefined;
  missionRunId: number | null;
  model: LanguageModel;
  warningMessages: string[];
}): Promise<number> {
  const {
    nativeTargetIntent,
    outcome,
    runState,
    ctx,
    req,
    appPath,
    missionId,
    missionRunId,
    model,
    warningMessages,
  } = params;

  if (!nativeTargetIntent) {
    return 0;
  }

  let autofinishExecutedToolCount = 0;
  const runAutofinish = async (
    tool: AutofinishToolDef,
    args: Record<string, unknown>,
    inputPreview: string,
  ) => {
    const ran = await executeNativeAutofinishTool({
      tool,
      args,
      inputPreview,
      ctx,
      warningMessages,
    });
    if (ran) {
      autofinishExecutedToolCount += 1;
    }
    return ran;
  };

  if (
    runState.createdProjectThisTurn &&
    !runState.filesWrittenSinceCreateProject.has("app/index.tsx") &&
    typeof req.prompt === "string" &&
    req.prompt.trim().length > 0
  ) {
    logger.info(
      `Auto-implement: agent scaffolded but never customized app/index.tsx for chat ${req.chatId}; generating from user prompt`,
    );
    await logMissionEvent({
      missionId,
      eventType: "native_autofinish_triggered",
      summary: "Auto-implementing app/index.tsx from user prompt",
      metadata: {
        chatId: req.chatId,
        runId: missionRunId,
        target: nativeTargetIntent.target,
        reason: "agent_skipped_customization",
      },
    }).catch((err) => logger.warn("Failed to log auto-implement event:", err));
    const result = await autoImplementAppIndex({
      appPath,
      userPrompt: req.prompt,
      model,
    });
    if (result.wrote) {
      runState.filesWrittenSinceCreateProject.add("app/index.tsx");
      runState.lastBrowserQaStatus = null;
      runState.lastBrowserQaPlaceholderDetected = false;
      outcome.passedBrowserQaGate = false;
      warningMessages.push(
        `The agent scaffolded the Expo project but didn't customize app/index.tsx. The harness generated it from your prompt as a last resort (${result.bytes} bytes).`,
      );
    } else {
      warningMessages.push(
        `Auto-implement could not generate a valid app/index.tsx (${result.reason}). The APK will ship the baseline counter screen.`,
      );
    }
  }

  if (!outcome.passedBrowserQaGate) {
    await logMissionEvent({
      missionId,
      eventType: "native_autofinish_triggered",
      summary: "Auto-finishing browser QA gate",
      metadata: {
        chatId: req.chatId,
        runId: missionRunId,
        target: nativeTargetIntent.target,
        reason: "native_target_without_browser_qa_pass",
      },
    }).catch((err) =>
      logger.warn("Failed to log native autofinish browser QA event:", err),
    );
    await runAutofinish(
      browserQaGateTool,
      {
        start_runtime: true,
        full_page: false,
        runtime_timeout_seconds: 60,
      },
      "Run browser QA gate before native package build",
    );
  }

  if (
    outcome.passedBrowserQaGate &&
    !outcome.producedNativePackageArtifact &&
    !outcome.attemptedNativePackageArtifact
  ) {
    await logMissionEvent({
      missionId,
      eventType: "native_autofinish_triggered",
      summary: `Auto-finishing native package: ${nativeTargetIntent.label}`,
      metadata: {
        chatId: req.chatId,
        runId: missionRunId,
        target: nativeTargetIntent.target,
        reason: "browser_qa_passed_without_native_package",
      },
    }).catch((err) =>
      logger.warn("Failed to log native autofinish package event:", err),
    );
    await runAutofinish(
      packageNativeArtifactTool,
      {
        target: nativeTargetIntent.target,
        variant: "debug",
        create_download_site: true,
        initialize_capacitor_if_missing: true,
      },
      `Package native artifact: ${nativeTargetIntent.target} and create download site`,
    );
  }

  if (outcome.producedNativePackageArtifact && !outcome.producedDeploymentUrl) {
    await logMissionEvent({
      missionId,
      eventType: "native_autofinish_triggered",
      summary: "Auto-finishing native download page deployment",
      metadata: {
        chatId: req.chatId,
        runId: missionRunId,
        target: nativeTargetIntent.target,
        reason: "native_package_created_without_download_page_url",
      },
    }).catch((err) =>
      logger.warn("Failed to log native autofinish deploy event:", err),
    );
    await runAutofinish(
      deployPreviewTool,
      {
        provider: "custom_command",
        target: "production",
        deploy_directory: "native-download-site",
      },
      "Deploy native-download-site as a managed local static download page",
    );
  }

  return autofinishExecutedToolCount;
}

/**
 * Apply the outcome mutations driven by a tool's final XML output.
 * Called from `ctx.onXmlComplete` so the streaming loop and post-stream
 * gates share a single source of truth for native deliverables.
 */
export function applyNativeOutcomeFromXml(
  outcome: NativeOutcomeState,
  finalXml: string,
): void {
  if (finalXml.startsWith("<orianbuilder-native-package")) {
    outcome.attemptedNativePackageArtifact = true;
  }
  if (
    finalXml.startsWith("<orianbuilder-native-package") &&
    /\bstatus="passed"/.test(finalXml)
  ) {
    outcome.producedNativePackageArtifact = true;
  }
  const deploymentUrl = finalXml.startsWith("<orianbuilder-deploy-preview")
    ? finalXml.match(/\burl="([^"]+)"/)?.[1]
    : null;
  if (deploymentUrl) {
    outcome.producedDeploymentUrl = true;
  }
  if (
    (finalXml.startsWith("<orianbuilder-screenshot") ||
      finalXml.startsWith("<orianbuilder-browser-action")) &&
    /\bpath="[^"]+"/.test(finalXml)
  ) {
    outcome.producedBrowserQaScreenshotArtifact = true;
  }
  if (finalXml.startsWith("<orianbuilder-browser-qa")) {
    const hasDesktopScreenshot = /\bdesktop-path="[^"]+"/.test(finalXml);
    const hasMobileScreenshot = /\bmobile-path="[^"]+"/.test(finalXml);
    const screenshotGatePassed =
      /\bscreenshot-status="passed"/.test(finalXml) &&
      hasDesktopScreenshot &&
      hasMobileScreenshot;
    outcome.producedBrowserQaScreenshotArtifact =
      outcome.producedBrowserQaScreenshotArtifact || screenshotGatePassed;
    outcome.passedBrowserQaGate =
      /\bstatus="passed"/.test(finalXml) && screenshotGatePassed;
  }
}
