import { z } from "zod";
import {
  AgentContext,
  escapeXmlAttr,
  escapeXmlContent,
  ToolDefinition,
} from "./types";
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
      `<orianbuilder-create-project created="${result.created}" name="${escapeXmlAttr(args.project_name)}" stack="${escapeXmlAttr(result.stack)}" package-manager="${escapeXmlAttr(result.packageManager)}" scaffold-method="${escapeXmlAttr(result.scaffoldMethod)}" scaffold-command="${escapeXmlAttr(result.scaffoldCommand ?? "")}" ${commandAttrs}>${escapeXmlContent(`${body}\n\nCommands:\n${commandSummary}${outputBlock}`)}</orianbuilder-create-project>`,
    );

    if (result.created) {
      if (result.commands.dev) {
        await db
          .update(apps)
          .set({
            installCommand: result.commands.install,
            startCommand: result.commands.dev,
          })
          .where(eq(apps.id, ctx.appId));
      }
      queueCloudSandboxSnapshotSync({
        appId: ctx.appId,
        changedPaths: result.files,
      });
    }

    return `${body}\n\nCommands:\n${commandSummary}${outputBlock}`;
  },
};
