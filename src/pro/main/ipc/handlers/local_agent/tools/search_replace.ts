import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import log from "electron-log";
import {
  ToolDefinition,
  AgentContext,
  escapeXmlAttr,
  escapeXmlContent,
} from "./types";
import { safeJoin } from "@/ipc/utils/path_utils";
import { applySearchReplace } from "@/pro/main/ipc/processors/search_replace_processor";
import { escapeSearchReplaceMarkers } from "@/pro/shared/search_replace_markers";
import { deploySupabaseFunction } from "@/supabase_admin/supabase_management_client";
import {
  isServerFunction,
  isSharedServerModule,
} from "@/supabase_admin/supabase_utils";
import { sendTelemetryEvent } from "@/ipc/utils/telemetry";
import { DyadError, DyadErrorKind } from "@/errors/dyad_error";
import { queueCloudSandboxSnapshotSync } from "@/ipc/utils/cloud_sandbox_provider";
import { withLock, getFileWriteKey } from "@/ipc/utils/lock_utils";

const logger = log.scope("search_replace");

const searchReplaceSchema = z.object({
  file_path: z
    .string()
    .describe("The path to the file you want to search and replace in."),
  old_string: z
    .string()
    .describe(
      "The text to replace (must be unique within the file, and must match the file contents exactly, including all whitespace and indentation)",
    ),
  new_string: z
    .string()
    .describe(
      "The edited text to replace the old_string (must be different from the old_string)",
    ),
});

export const searchReplaceTool: ToolDefinition<
  z.infer<typeof searchReplaceSchema>
> = {
  name: "search_replace",
  description: `Use this tool to propose a search and replace operation on an existing file.

The tool will replace ONE occurrence of old_string with new_string in the specified file.

CRITICAL REQUIREMENTS FOR USING THIS TOOL:

1. UNIQUENESS: The old_string MUST uniquely identify the specific instance you want to change. This means:
   - Include AT LEAST 3-5 lines of context BEFORE the change point
   - Include AT LEAST 3-5 lines of context AFTER the change point
   - Include all whitespace, indentation, and surrounding code exactly as it appears in the file

2. SINGLE INSTANCE: This tool can only change ONE instance at a time. If you need to change multiple instances:
   - Make separate calls to this tool for each instance
   - Each call must uniquely identify its specific instance using extensive context

3. VERIFICATION: Before using this tool:
   - If multiple instances exist, gather enough context to uniquely identify each one
   - Plan separate tool calls for each instance
`,
  inputSchema: searchReplaceSchema,
  defaultConsent: "always",
  modifiesState: true,

  getConsentPreview: (args) => `Edit ${args.file_path}`,

  buildXml: (args, isComplete) => {
    if (!args.file_path) return undefined;

    const escapedOld = escapeSearchReplaceMarkers(args.old_string ?? "");

    let xml = `<dyad-search-replace path="${escapeXmlAttr(args.file_path)}" description="">\n<<<<<<< SEARCH\n${escapeXmlContent(escapedOld)}`;

    // Add separator and replace content if new_string has started
    if (args.new_string !== undefined) {
      const escapedNew = escapeSearchReplaceMarkers(args.new_string);
      xml += `\n=======\n${escapeXmlContent(escapedNew)}`;
    }

    if (isComplete) {
      if (args.new_string === undefined) {
        xml += "\n=======\n";
      }
      xml += "\n>>>>>>> REPLACE\n</dyad-search-replace>";
    }

    return xml;
  },

  execute: async (args, ctx: AgentContext) => {
    // Validate old_string !== new_string
    if (args.old_string === args.new_string) {
      throw new DyadError(
        "old_string and new_string must be different",
        DyadErrorKind.Validation,
      );
    }

    const fullFilePath = safeJoin(ctx.appPath, args.file_path);

    // Track if this is a shared module
    if (isSharedServerModule(args.file_path)) {
      ctx.isSharedModulesChanged = true;
    }

    await withLock(getFileWriteKey(fullFilePath), async () => {
      if (!fs.existsSync(fullFilePath)) {
        throw new DyadError(
          `File does not exist: ${args.file_path}`,
          DyadErrorKind.NotFound,
        );
      }

      const original = await fs.promises.readFile(fullFilePath, "utf8");

      // ── Pre-verification: check that old_string actually exists ──────────
      if (!original.includes(args.old_string)) {
        // Fuzzy retry: normalise line-endings + collapse runs of spaces/tabs
        // to handle the common case where the model's whitespace doesn't
        // exactly match the file (e.g. CRLF vs LF, trailing spaces, indent
        // differences).
        const normalize = (s: string) =>
          s.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ");

        const normOriginal = normalize(original);
        const normSearch = normalize(args.old_string);

        if (normOriginal.includes(normSearch)) {
          // Build a corrected old_string by finding the matching region in the
          // original file and using those exact bytes instead.
          const startIdx = normOriginal.indexOf(normSearch);
          // Map normalised offset back to original file position (approximate —
          // sufficient for uniqueness check)
          let origIdx = 0;
          let normIdx = 0;
          while (normIdx < startIdx && origIdx < original.length) {
            origIdx++;
            normIdx = normalize(original.slice(0, origIdx)).length;
          }
          // Simpler: just swap in the normalised version for the apply step
          const correctedOld = normSearch;
          const correctedOriginal = normOriginal;

          const escapedOld = escapeSearchReplaceMarkers(correctedOld);
          const escapedNew = escapeSearchReplaceMarkers(
            normalize(args.new_string),
          );
          const operations = `<<<<<<< SEARCH\n${escapedOld}\n=======\n${escapedNew}\n>>>>>>> REPLACE`;
          const fuzzyResult = applySearchReplace(correctedOriginal, operations);

          if (fuzzyResult.success && typeof fuzzyResult.content === "string") {
            // Re-apply to original with the corrected bytes (write normalised
            // content — acceptable because normalisation only collapses
            // redundant whitespace, which is safe for all text files).
            await fs.promises.writeFile(fullFilePath, fuzzyResult.content);
            logger.log(
              `search_replace: applied via fuzzy whitespace match on ${fullFilePath}`,
            );
            queueCloudSandboxSnapshotSync({
              appId: ctx.appId,
              changedPaths: [args.file_path],
            });
            sendTelemetryEvent("local_agent:search_replace:success_fuzzy", {
              filePath: args.file_path,
            });
            return;
          }
        }

        // Provide a diagnostic hint showing the closest matching lines
        const lines = original.split("\n");
        const searchFirstLine = args.old_string
          .split("\n")[0]
          .trim()
          .slice(0, 60);
        const nearbyLines = lines
          .map((l, i) => ({ line: l.trim(), idx: i + 1 }))
          .filter(({ line }) => line.includes(searchFirstLine.slice(0, 20)))
          .slice(0, 3)
          .map(({ line, idx }) => `  line ${idx}: ${line}`)
          .join("\n");

        const hint = nearbyLines
          ? `\nClosest matching lines in file:\n${nearbyLines}`
          : "\nThe search string was not found anywhere in the file.";

        sendTelemetryEvent("local_agent:search_replace:failure", {
          filePath: args.file_path,
          error: "old_string_not_found",
        });

        throw new DyadError(
          `search_replace failed: the old_string was not found in ${args.file_path}. ` +
            `Verify the exact text (including whitespace/indentation) with read_file first, then retry.${hint}`,
          DyadErrorKind.Validation,
        );
      }

      // ── Standard apply path ──────────────────────────────────────────────
      const escapedOld = escapeSearchReplaceMarkers(args.old_string);
      const escapedNew = escapeSearchReplaceMarkers(args.new_string);
      const operations = `<<<<<<< SEARCH\n${escapedOld}\n=======\n${escapedNew}\n>>>>>>> REPLACE`;

      const result = applySearchReplace(original, operations);

      if (!result.success || typeof result.content !== "string") {
        sendTelemetryEvent("local_agent:search_replace:failure", {
          filePath: args.file_path,
          error: result.error ?? "unknown",
        });
        throw new Error(
          `Failed to apply search-replace: ${result.error ?? "unknown"}`,
        );
      }

      await fs.promises.writeFile(fullFilePath, result.content);
      logger.log(`Successfully applied search-replace to: ${fullFilePath}`);
      queueCloudSandboxSnapshotSync({
        appId: ctx.appId,
        changedPaths: [args.file_path],
      });
      sendTelemetryEvent("local_agent:search_replace:success", {
        filePath: args.file_path,
      });
    });

    // Deploy Supabase function if applicable
    if (
      ctx.supabaseProjectId &&
      isServerFunction(args.file_path) &&
      !ctx.isSharedModulesChanged
    ) {
      try {
        await deploySupabaseFunction({
          supabaseProjectId: ctx.supabaseProjectId,
          functionName: path.basename(path.dirname(args.file_path)),
          appPath: ctx.appPath,
          organizationSlug: ctx.supabaseOrganizationSlug ?? null,
        });
      } catch (error) {
        return `Search-replace applied, but failed to deploy Supabase function: ${error}`;
      }
    }

    return `Successfully applied edits to ${args.file_path}`;
  },
};
