import path from "node:path";
import { z } from "zod";
import {
  AgentContext,
  escapeXmlAttr,
  escapeXmlContent,
  ToolDefinition,
} from "./types";
import { resolveDirectoryWithinAppPath } from "./path_safety";
import {
  assertOrianBuilderInternalAccessAllowed,
  resolveTargetAppPath,
} from "./resolve_app_context";
import { detectProjectStack } from "@/ipc/utils/project_stack_detector";

const detectProjectStackSchema = z.object({
  directory: z
    .string()
    .optional()
    .describe(
      "Optional subdirectory inside the app to inspect. Omit to inspect the app root.",
    ),
  app_name: z
    .string()
    .optional()
    .describe(
      "Optional. Name of a referenced app (from `@app:Name` mentions in the user's prompt) to inspect instead of the current app. Omit to inspect the current app.",
    ),
});

type DetectProjectStackArgs = z.infer<typeof detectProjectStackSchema>;

function getTargetPath(
  ctx: AgentContext,
  args: DetectProjectStackArgs,
): string {
  const targetAppPath = resolveTargetAppPath(ctx, args.app_name);
  if (!args.directory) {
    return targetAppPath;
  }

  const relativeDirectory = resolveDirectoryWithinAppPath({
    appPath: targetAppPath,
    directory: args.directory,
  });
  const targetPath = path.join(targetAppPath, relativeDirectory);
  assertOrianBuilderInternalAccessAllowed({
    targetAppPath,
    fullFilePath: targetPath,
    appName: args.app_name,
  });
  return targetPath;
}

function buildSummary(
  detection: Awaited<ReturnType<typeof detectProjectStack>>,
) {
  return [
    `Framework: ${detection.framework}`,
    `Kind: ${detection.kind}`,
    `Language: ${detection.language}`,
    `Package manager: ${detection.packageManager}`,
    `Confidence: ${detection.confidence}`,
    "",
    "Commands:",
    `- install: ${detection.commands.install ?? "(unknown)"}`,
    `- dev: ${detection.commands.dev ?? "(missing)"}`,
    `- build: ${detection.commands.build ?? "(missing)"}`,
    `- test: ${detection.commands.test ?? "(missing)"}`,
    `- lint: ${detection.commands.lint ?? "(missing)"}`,
    `- typecheck: ${detection.commands.typecheck ?? "(missing)"}`,
    "",
    `Config files: ${detection.configFiles.join(", ") || "(none)"}`,
    `Lockfiles: ${detection.lockfiles.join(", ") || "(none)"}`,
    `Evidence: ${detection.evidence.join("; ") || "(none)"}`,
    `Warnings: ${detection.warnings.join("; ") || "(none)"}`,
  ].join("\n");
}

export const detectProjectStackTool: ToolDefinition<DetectProjectStackArgs> = {
  name: "detect_project_stack",
  description: `Detect the current project's stack, package manager, scripts, config files, lockfiles, and recommended install/dev/build/test/lint/typecheck commands.

Use this before working in an unfamiliar app, before greenfield setup decisions, and before running commands. It helps choose the right tooling instead of guessing from templates.`,
  inputSchema: detectProjectStackSchema,
  defaultConsent: "always",

  getConsentPreview: (args) => {
    const target = args.directory ?? "app root";
    const appSuffix = args.app_name ? ` (app: ${args.app_name})` : "";
    return `Detect project stack for ${target}${appSuffix}`;
  },

  buildXml: (args, isComplete) => {
    if (isComplete) return undefined;
    const directoryAttr = args.directory
      ? ` directory="${escapeXmlAttr(args.directory)}"`
      : "";
    const appNameAttr = args.app_name
      ? ` app_name="${escapeXmlAttr(args.app_name)}"`
      : "";
    return `<orianbuilder-project-stack${directoryAttr}${appNameAttr}>Detecting project stack...`;
  },

  execute: async (args, ctx: AgentContext) => {
    const targetPath = getTargetPath(ctx, args);
    const detection = await detectProjectStack(targetPath);
    const summary = buildSummary(detection);

    ctx.onXmlComplete(
      `<orianbuilder-project-stack framework="${escapeXmlAttr(detection.framework)}" kind="${escapeXmlAttr(detection.kind)}" package-manager="${escapeXmlAttr(detection.packageManager)}" confidence="${escapeXmlAttr(detection.confidence)}">${escapeXmlContent(summary)}</orianbuilder-project-stack>`,
    );

    return JSON.stringify(detection, null, 2);
  },
};
