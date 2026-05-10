import { z } from "zod";
import {
  ToolDefinition,
  AgentContext,
  escapeXmlAttr,
  escapeXmlContent,
} from "./types";
import { getSupabaseTableSchema } from "../../../../../../supabase_admin/supabase_context";
import { getNeonTableSchema } from "../../../../../../neon_admin/neon_context";
import {
  OrianBuilderError,
  OrianBuilderErrorKind,
} from "@/errors/orianbuilder_error";

const getDatabaseTableSchemaSchema = z.object({
  tableName: z
    .string()
    .optional()
    .describe(
      "Optional table name to get schema for. If omitted, returns schema for all tables.",
    ),
});

export const getDatabaseTableSchemaTool: ToolDefinition<
  z.infer<typeof getDatabaseTableSchemaSchema>
> = {
  name: "get_database_table_schema",
  description:
    "Get database table schema. If tableName is provided, returns schema for that specific table (columns, policies/constraints, triggers/indexes). If omitted, returns schema for all tables.",
  inputSchema: getDatabaseTableSchemaSchema,
  defaultConsent: "always",
  isEnabled: (ctx) =>
    !!ctx.supabaseProjectId ||
    (!!ctx.neonProjectId && !!ctx.neonActiveBranchId),

  getConsentPreview: (args) =>
    args.tableName
      ? `Get schema for table "${args.tableName}"`
      : "Get schema for all tables",

  execute: async (args, ctx: AgentContext) => {
    const tableAttr = args.tableName
      ? ` table="${escapeXmlAttr(args.tableName)}"`
      : "";

    if (ctx.neonProjectId && ctx.neonActiveBranchId) {
      ctx.onXmlStream(
        `<orianbuilder-db-table-schema provider="Neon"${tableAttr}></orianbuilder-db-table-schema>`,
      );

      const schema = await getNeonTableSchema({
        projectId: ctx.neonProjectId,
        branchId: ctx.neonActiveBranchId,
        tableName: args.tableName,
      });

      ctx.onXmlComplete(
        `<orianbuilder-db-table-schema provider="Neon"${tableAttr}>\n${escapeXmlContent(schema)}\n</orianbuilder-db-table-schema>`,
      );

      return schema;
    }

    if (ctx.supabaseProjectId) {
      ctx.onXmlStream(
        `<orianbuilder-db-table-schema provider="Supabase"${tableAttr}></orianbuilder-db-table-schema>`,
      );

      const schema = await getSupabaseTableSchema({
        supabaseProjectId: ctx.supabaseProjectId,
        organizationSlug: ctx.supabaseOrganizationSlug ?? null,
        tableName: args.tableName,
      });

      ctx.onXmlComplete(
        `<orianbuilder-db-table-schema provider="Supabase"${tableAttr}>\n${escapeXmlContent(schema)}\n</orianbuilder-db-table-schema>`,
      );

      return schema;
    }

    throw new OrianBuilderError(
      "No database is connected to this app",
      OrianBuilderErrorKind.Precondition,
    );
  },
};
