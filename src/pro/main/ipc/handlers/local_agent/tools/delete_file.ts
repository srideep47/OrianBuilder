import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import log from "electron-log";
import { ToolDefinition, AgentContext, escapeXmlAttr } from "./types";
import { safeJoin } from "@/ipc/utils/path_utils";
import { gitRemove } from "@/ipc/utils/git_utils";
import { deleteSupabaseFunction } from "../../../../../../supabase_admin/supabase_management_client";
import {
  isServerFunction,
  isSharedServerModule,
} from "../../../../../../supabase_admin/supabase_utils";
import {
  OrianBuilderError,
  OrianBuilderErrorKind,
} from "@/errors/orianbuilder_error";
import { queueCloudSandboxSnapshotSync } from "@/ipc/utils/cloud_sandbox_provider";
import { isPathLocked } from "@/pro/main/ipc/utils/chat_path_locks";

const logger = log.scope("delete_file");

function getFunctionNameFromPath(input: string): string {
  return path.basename(path.extname(input) ? path.dirname(input) : input);
}

const deleteFileSchema = z.object({
  path: z
    .string()
    .refine((value) => value.trim().length > 0, {
      message: "Path cannot be empty",
    })
    .describe("The file path to delete"),
});

export const deleteFileTool: ToolDefinition<z.infer<typeof deleteFileSchema>> =
  {
    name: "delete_file",
    description: "Delete a file from the codebase",
    inputSchema: deleteFileSchema,
    defaultConsent: "always",
    modifiesState: true,

    getConsentPreview: (args) => `Delete ${args.path}`,

    buildXml: (args, _isComplete) => {
      if (!args.path?.trim()) return undefined;
      return `<orianbuilder-delete path="${escapeXmlAttr(args.path)}"></orianbuilder-delete>`;
    },

    execute: async (args, ctx: AgentContext) => {
      const normalizedPath = path.posix.normalize(
        args.path.replace(/\\/g, "/"),
      );
      if (
        normalizedPath === "." ||
        normalizedPath === "./" ||
        normalizedPath === ""
      ) {
        throw new OrianBuilderError(
          `Refusing to delete project root for path: "${args.path}"`,
          OrianBuilderErrorKind.Validation,
        );
      }

      if (isPathLocked(args.path, ctx.runState.lockedPaths)) {
        throw new OrianBuilderError(
          `Refusing to delete: ${args.path} is locked by the user for this chat. ` +
            "Ask the user to unlock it before retrying.",
          OrianBuilderErrorKind.Validation,
        );
      }

      const fullFilePath = safeJoin(ctx.appPath, args.path);

      // Track if this is a shared module
      if (isSharedServerModule(args.path)) {
        ctx.isSharedModulesChanged = true;
      }

      if (fs.existsSync(fullFilePath)) {
        if (fs.lstatSync(fullFilePath).isDirectory()) {
          fs.rmdirSync(fullFilePath, { recursive: true });
        } else {
          fs.unlinkSync(fullFilePath);
        }
        logger.log(`Successfully deleted file: ${fullFilePath}`);
        // Any deletion invalidates the previous QA result.
        ctx.runState.lastBrowserQaStatus = null;
        ctx.runState.lastBrowserQaPlaceholderDetected = false;

        // Remove from git
        try {
          await gitRemove({ path: ctx.appPath, filepath: args.path });
        } catch (error) {
          logger.warn(`Failed to git remove deleted file ${args.path}:`, error);
        }

        // Delete Supabase function if applicable
        if (ctx.supabaseProjectId && isServerFunction(args.path)) {
          try {
            await deleteSupabaseFunction({
              supabaseProjectId: ctx.supabaseProjectId,
              functionName: getFunctionNameFromPath(args.path),
              organizationSlug: ctx.supabaseOrganizationSlug ?? null,
            });
          } catch (error) {
            return `File deleted, but failed to delete Supabase function: ${error}`;
          }
        }
      } else {
        logger.warn(`File to delete does not exist: ${fullFilePath}`);
      }

      queueCloudSandboxSnapshotSync({
        appId: ctx.appId,
        deletedPaths: [args.path],
      });

      return `Successfully deleted ${args.path}`;
    },
  };
