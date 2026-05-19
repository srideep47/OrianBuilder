import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import log from "electron-log";
import { ToolDefinition, AgentContext, escapeXmlAttr } from "./types";
import { safeJoin } from "@/ipc/utils/path_utils";
import { deploySupabaseFunction } from "../../../../../../supabase_admin/supabase_management_client";
import {
  isServerFunction,
  isSharedServerModule,
} from "../../../../../../supabase_admin/supabase_utils";
import { queueCloudSandboxSnapshotSync } from "@/ipc/utils/cloud_sandbox_provider";
import { withLock, getFileWriteKey } from "@/ipc/utils/lock_utils";
import { isPathLocked } from "@/pro/main/ipc/utils/chat_path_locks";
const logger = log.scope("write_file");

const writeFileSchema = z.object({
  path: z.string().describe("The file path relative to the app root"),
  content: z.string().describe("The content to write to the file"),
  description: z
    .string()
    .optional()
    .describe("Brief description of the change"),
});

export const writeFileTool: ToolDefinition<z.infer<typeof writeFileSchema>> = {
  name: "write_file",
  description: "Create or completely overwrite a file in the codebase",
  inputSchema: writeFileSchema,
  defaultConsent: "always",
  modifiesState: true,

  getConsentPreview: (args) => `Write to ${args.path}`,

  buildXml: (args, isComplete) => {
    if (!args.path) return undefined;

    let xml = `<orianbuilder-write path="${escapeXmlAttr(args.path)}" description="${escapeXmlAttr(args.description ?? "")}">\n${args.content ?? ""}`;
    if (isComplete) {
      xml += "\n</orianbuilder-write>";
    }
    return xml;
  },

  execute: async (args, ctx: AgentContext) => {
    if (isPathLocked(args.path, ctx.runState.lockedPaths)) {
      throw new Error(
        `Refusing to write: ${args.path} is locked by the user for this chat. ` +
          "Ask the user to unlock it before retrying, or choose a different path.",
      );
    }

    const fullFilePath = safeJoin(ctx.appPath, args.path);

    // Track if this is a shared module
    if (isSharedServerModule(args.path)) {
      ctx.isSharedModulesChanged = true;
    }

    await withLock(getFileWriteKey(fullFilePath), async () => {
      // Ensure directory exists
      const dirPath = path.dirname(fullFilePath);
      fs.mkdirSync(dirPath, { recursive: true });

      // Write file content
      fs.writeFileSync(fullFilePath, args.content);
      logger.log(`Successfully wrote file: ${fullFilePath}`);
      queueCloudSandboxSnapshotSync({
        appId: ctx.appId,
        changedPaths: [args.path],
      });
    });

    ctx.runState.filesWrittenSinceCreateProject.add(
      args.path.replace(/\\/g, "/"),
    );
    // Any write invalidates the previous QA result — the agent must re-run
    // browser_qa_gate before claiming the app is ready to package.
    ctx.runState.lastBrowserQaStatus = null;
    ctx.runState.lastBrowserQaPlaceholderDetected = false;

    // Deploy Supabase function if applicable
    if (
      ctx.supabaseProjectId &&
      isServerFunction(args.path) &&
      !ctx.isSharedModulesChanged
    ) {
      try {
        await deploySupabaseFunction({
          supabaseProjectId: ctx.supabaseProjectId,
          functionName: path.basename(path.dirname(args.path)),
          appPath: ctx.appPath,
          organizationSlug: ctx.supabaseOrganizationSlug ?? null,
        });
      } catch (error) {
        return `File written, but failed to deploy Supabase function: ${error}`;
      }
    }

    return `Successfully wrote ${args.path}`;
  },
};
