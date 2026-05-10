import { z } from "zod";
import {
  getToolCapability,
  TOOL_CAPABILITIES,
} from "@/ipc/utils/tool_capabilities";
import { ToolDefinition } from "./types";

const listToolCapabilitiesSchema = z.object({
  tool_names: z
    .array(z.string())
    .optional()
    .describe(
      "Optional tool names to inspect. Omit to list all known built-in tool capabilities.",
    ),
});

type ListToolCapabilitiesArgs = z.infer<typeof listToolCapabilitiesSchema>;

export const listToolCapabilitiesTool: ToolDefinition<ListToolCapabilitiesArgs> =
  {
    name: "list_tool_capabilities",
    description: `Inspect local-agent tool capabilities: risk, state scope, isolation requirement, and expected artifacts.

Use this before choosing tools for autonomous work, especially when deciding whether a tool is read-only, workspace-scoped, runtime-scoped, or external-state.`,
    inputSchema: listToolCapabilitiesSchema,
    defaultConsent: "always",

    getConsentPreview: (args) =>
      args.tool_names?.length
        ? `Inspect capabilities for ${args.tool_names.join(", ")}`
        : "Inspect all local-agent tool capabilities",

    execute: async (args) => {
      const names = args.tool_names?.length
        ? args.tool_names
        : Object.keys(TOOL_CAPABILITIES).sort();
      const capabilities = names.map((toolName) => ({
        toolName,
        ...getToolCapability(toolName),
      }));
      return JSON.stringify({ capabilities }, null, 2);
    },
  };
