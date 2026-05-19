import path from "node:path";
import { z } from "zod";
import {
  AgentContext,
  escapeXmlAttr,
  escapeXmlContent,
  ToolDefinition,
} from "./types";
import { ORIANBUILDER_MEDIA_DIR_NAME } from "@/ipc/utils/media_path_utils";
import { exportProjectZip } from "@/ipc/utils/zip_export";

const exportZipSchema = z.object({
  output_name: z
    .string()
    .optional()
    .describe(
      "Optional filename for the resulting zip. Defaults to <app-name>-<timestamp>.zip. Always written under .orianbuilder/media/.",
    ),
});

type ExportZipArgs = z.infer<typeof exportZipSchema>;

function sanitizeFileNameComponent(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 60) || "project";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let unit = -1;
  let value = bytes;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(1)} ${units[unit]}`;
}

export const exportZipTool: ToolDefinition<ExportZipArgs> = {
  name: "export_project_zip",
  description: `Export the current project as a downloadable .zip archive (excludes node_modules, .git, build outputs).

Use this when the user asks to download, export, or share the project, or when they want a portable copy for moving to another tool. The zip is written under .orianbuilder/media/ and can be served by the existing media URL handler.`,
  inputSchema: exportZipSchema,
  defaultConsent: "ask",
  modifiesState: true,

  getConsentPreview: (args) =>
    `Export project as ${args.output_name ?? "<app-name>-<timestamp>"}.zip`,

  buildXml: (_args, isComplete) => {
    if (isComplete) return undefined;
    return `<orianbuilder-export-zip status="running">Packaging project zip...`;
  },

  execute: async (args, ctx: AgentContext) => {
    const baseName = sanitizeFileNameComponent(
      args.output_name?.replace(/\.zip$/i, "") ??
        `${ctx.appName ?? "project"}-${Date.now()}`,
    );
    const fileName = `${baseName}.zip`;
    const relativePath = path.posix.join(ORIANBUILDER_MEDIA_DIR_NAME, fileName);
    const destinationPath = path.join(
      ctx.appPath,
      ORIANBUILDER_MEDIA_DIR_NAME,
      fileName,
    );

    const result = await exportProjectZip(ctx.appPath, destinationPath);

    const summary = `Wrote ${result.fileCount} files (${formatBytes(result.sizeBytes)}) to ${relativePath}.`;
    ctx.onXmlComplete(
      `<orianbuilder-export-zip status="completed" path="${escapeXmlAttr(relativePath)}" file-count="${result.fileCount}" size-bytes="${result.sizeBytes}">${escapeXmlContent(summary)}</orianbuilder-export-zip>`,
    );
    return summary;
  },
};
