import { z } from "zod";
import {
  AgentContext,
  escapeXmlAttr,
  escapeXmlContent,
  ToolDefinition,
} from "./types";
import { checkAndroidEnv, formatAndroidEnvStatus } from "./android_env";
import { queueCloudSandboxSnapshotSync } from "@/ipc/utils/cloud_sandbox_provider";
import {
  createGreenfieldProject,
  GREENFIELD_PROJECT_STACKS,
} from "@/ipc/utils/project_factory";
import { db } from "@/db";
import { apps } from "@/db/schema";
import { eq } from "drizzle-orm";

const createProjectSchema = z.object({
  project_name: z
    .string()
    .min(1)
    .describe("Human-readable project name to use in generated files."),
  stack: z
    .enum(GREENFIELD_PROJECT_STACKS)
    .describe(
      "Greenfield stack to scaffold. Use blank only when the requested project does not fit the known stacks.",
    ),
  package_manager: z
    .enum(["npm", "pnpm", "yarn", "bun"])
    .optional()
    .default("npm")
    .describe("Package manager to use in generated next-step commands."),
  scaffold_method: z
    .enum(["starter_files", "cli"])
    .optional()
    .default("starter_files")
    .describe(
      "Use starter_files for deterministic local scaffolding. Use cli only when the user explicitly asks for the upstream framework CLI.",
    ),
  force: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Overwrite existing files. Keep false unless the user explicitly asked to replace the current project.",
    ),
});

type CreateProjectArgs = z.infer<typeof createProjectSchema>;

export const createProjectTool: ToolDefinition<CreateProjectArgs> = {
  name: "create_project",
  description: `Initialize the current empty app as a greenfield project with coherent starter files, package scripts, and AI_RULES.md.

Use this only when the user asks to start a new project or the current app is empty. For existing projects, inspect with detect_project_stack and edit files directly.`,
  inputSchema: createProjectSchema,
  defaultConsent: "ask",
  modifiesState: true,

  getConsentPreview: (args) =>
    `Create ${args.stack} project "${args.project_name}" via ${args.scaffold_method ?? "starter_files"}${args.force ? " and overwrite existing files" : ""}`,

  buildXml: (args, isComplete) => {
    if (isComplete) return undefined;
    return `<orianbuilder-create-project name="${escapeXmlAttr(args.project_name ?? "")}" stack="${escapeXmlAttr(args.stack ?? "")}">Creating project...`;
  },

  execute: async (args, ctx: AgentContext) => {
    const result = await createGreenfieldProject({
      rootPath: ctx.appPath,
      projectName: args.project_name,
      stack: args.stack,
      packageManager: args.package_manager ?? "npm",
      scaffoldMethod: args.scaffold_method ?? "starter_files",
      force: args.force ?? false,
    });

    if (result.created) {
      ctx.runState.createdProjectThisTurn = true;
      ctx.runState.filesWrittenSinceCreateProject.clear();
      ctx.runState.lastBrowserQaStatus = null;
      ctx.runState.lastBrowserQaPlaceholderDetected = false;
    }

    let androidEnvBlock = "";
    if (result.created && args.stack === "expo") {
      const androidStatus = await checkAndroidEnv();
      androidEnvBlock = `\n\n${formatAndroidEnvStatus(androidStatus)}`;
      ctx.appendUserMessage([
        {
          type: "text",
          text:
            "Expo project scaffolded. The scaffold's app/index.tsx ships a working baseline " +
            "(welcome screen + counter) so the build pipeline works out of the box. " +
            "If the user's request needs specific UI (e.g., a list of numbers, a form, a custom layout), " +
            "edit app/index.tsx with write_file or search_replace to match it. " +
            "Then run browser_qa_gate to verify, then package_native_artifact to build the APK. " +
            "If the baseline already matches the user's request closely enough, you can proceed straight to QA + packaging." +
            (androidStatus.issues.length > 0
              ? "\n\nAndroid env warnings (will only block package_native_artifact, not preview):\n" +
                androidStatus.issues.map((line) => `- ${line}`).join("\n")
              : ""),
        },
      ]);
    }

    const fileList = result.files.map((file) => `- ${file}`).join("\n");
    const nextSteps = result.nextSteps.map((step) => `- ${step}`).join("\n");
    const commandSummary = [
      `install: ${result.commands.install}`,
      `typecheck: ${result.commands.typecheck ?? "(none)"}`,
      `build: ${result.commands.build ?? "(none)"}`,
      `dev: ${result.commands.dev ?? "(none)"}`,
    ].join("\n");
    const body = result.created
      ? `Created files:\n${fileList}\n\nNext steps:\n${nextSteps}`
      : `Project was not created.\nReason: ${result.reason}\n\nNext steps:\n${nextSteps || "(none)"}`;
    const outputBlock = result.output
      ? `\n\nScaffold output:\n${result.output}`
      : "";
    const requiredChecks = [
      "install",
      result.commands.typecheck ? "typecheck" : null,
      result.commands.build ? "build" : null,
      result.commands.dev ? "runtime" : null,
      result.commands.dev ? "console" : null,
      result.commands.dev ? "screenshot" : null,
      result.commands.dev ? "accessibility" : null,
    ].filter((check): check is string => Boolean(check));
    const commandAttrs = [
      `install-command="${escapeXmlAttr(result.commands.install)}"`,
      `typecheck-command="${escapeXmlAttr(result.commands.typecheck ?? "")}"`,
      `build-command="${escapeXmlAttr(result.commands.build ?? "")}"`,
      `dev-command="${escapeXmlAttr(result.commands.dev ?? "")}"`,
      `required-checks="${escapeXmlAttr(requiredChecks.join(","))}"`,
    ].join(" ");

    ctx.onXmlComplete(
      `<orianbuilder-create-project created="${result.created}" name="${escapeXmlAttr(args.project_name)}" stack="${escapeXmlAttr(result.stack)}" package-manager="${escapeXmlAttr(result.packageManager)}" scaffold-method="${escapeXmlAttr(result.scaffoldMethod)}" scaffold-command="${escapeXmlAttr(result.scaffoldCommand ?? "")}" ${commandAttrs}>${escapeXmlContent(`${body}\n\nCommands:\n${commandSummary}${outputBlock}${androidEnvBlock}`)}</orianbuilder-create-project>`,
    );

    if (result.created) {
      // Keep DB's apps.name in sync with the human-readable project name
      // the agent just scaffolded. Without this, later tool calls that
      // (incorrectly) echo the new name back as app_name fail to match
      // ctx.appName and fall through to "Unknown app_name". Update is
      // best-effort; failure here doesn't block the scaffold result.
      await db
        .update(apps)
        .set({
          name: args.project_name,
          ...(result.commands.dev
            ? {
                installCommand: result.commands.install,
                startCommand: result.commands.dev,
              }
            : {}),
        })
        .where(eq(apps.id, ctx.appId))
        .catch(() => {});
      // Also keep the in-memory ctx in sync so resolveTargetAppPath matches
      // immediately, before any future turn reloads the DB row.
      ctx.appName = args.project_name;
      queueCloudSandboxSnapshotSync({
        appId: ctx.appId,
        changedPaths: result.files,
      });
    }

    return `${body}\n\nCommands:\n${commandSummary}${outputBlock}${androidEnvBlock}`;
  },
};
