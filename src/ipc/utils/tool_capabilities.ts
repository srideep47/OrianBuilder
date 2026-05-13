import {
  getMcpToolCapability,
  isMcpToolKey,
  type McpToolTrustOverrideMap,
} from "./mcp_tool_capabilities";

export type ToolCapabilityRisk = "low" | "medium" | "high" | "critical";

export type ToolStateScope =
  | "read_only"
  | "workspace"
  | "runtime"
  | "external"
  | "host";

export type ToolIsolationRequirement =
  | "none"
  | "workspace"
  | "sandbox"
  | "host";

export type ToolCapability = {
  risk: ToolCapabilityRisk;
  stateScope: ToolStateScope;
  isolation: ToolIsolationRequirement;
  expectedArtifacts: string[];
};

export const TOOL_CAPABILITIES: Readonly<Record<string, ToolCapability>> = {
  read_file: {
    risk: "low",
    stateScope: "read_only",
    isolation: "none",
    expectedArtifacts: [],
  },
  list_files: {
    risk: "low",
    stateScope: "read_only",
    isolation: "none",
    expectedArtifacts: [],
  },
  grep: {
    risk: "low",
    stateScope: "read_only",
    isolation: "none",
    expectedArtifacts: [],
  },
  code_search: {
    risk: "low",
    stateScope: "read_only",
    isolation: "none",
    expectedArtifacts: [],
  },
  get_repo_map: {
    risk: "low",
    stateScope: "read_only",
    isolation: "none",
    expectedArtifacts: ["repo_map"],
  },
  detect_project_stack: {
    risk: "low",
    stateScope: "read_only",
    isolation: "none",
    expectedArtifacts: ["stack_detection"],
  },
  read_logs: {
    risk: "low",
    stateScope: "read_only",
    isolation: "none",
    expectedArtifacts: ["logs"],
  },
  read_console_output: {
    risk: "low",
    stateScope: "read_only",
    isolation: "none",
    expectedArtifacts: ["console_output"],
  },
  read_dev_server_output: {
    risk: "low",
    stateScope: "read_only",
    isolation: "none",
    expectedArtifacts: ["runtime_output"],
  },
  get_accessibility_tree: {
    risk: "low",
    stateScope: "read_only",
    isolation: "none",
    expectedArtifacts: ["accessibility_tree"],
  },
  get_database_table_schema: {
    risk: "low",
    stateScope: "read_only",
    isolation: "none",
    expectedArtifacts: ["database_schema"],
  },
  get_supabase_project_info: {
    risk: "low",
    stateScope: "read_only",
    isolation: "none",
    expectedArtifacts: ["project_info"],
  },
  get_neon_project_info: {
    risk: "low",
    stateScope: "read_only",
    isolation: "none",
    expectedArtifacts: ["project_info"],
  },
  web_search: {
    risk: "low",
    stateScope: "read_only",
    isolation: "none",
    expectedArtifacts: ["web_results"],
  },
  web_fetch: {
    risk: "low",
    stateScope: "read_only",
    isolation: "none",
    expectedArtifacts: ["web_page"],
  },
  web_crawl: {
    risk: "low",
    stateScope: "read_only",
    isolation: "none",
    expectedArtifacts: ["web_pages"],
  },
  read_guide: {
    risk: "low",
    stateScope: "read_only",
    isolation: "none",
    expectedArtifacts: ["guide"],
  },
  set_chat_summary: {
    risk: "low",
    stateScope: "read_only",
    isolation: "none",
    expectedArtifacts: [],
  },
  planning_questionnaire: {
    risk: "low",
    stateScope: "read_only",
    isolation: "none",
    expectedArtifacts: ["questionnaire"],
  },
  list_tool_capabilities: {
    risk: "low",
    stateScope: "read_only",
    isolation: "none",
    expectedArtifacts: ["tool_capabilities"],
  },

  write_file: {
    risk: "medium",
    stateScope: "workspace",
    isolation: "workspace",
    expectedArtifacts: ["file_change"],
  },
  search_replace: {
    risk: "medium",
    stateScope: "workspace",
    isolation: "workspace",
    expectedArtifacts: ["file_change"],
  },
  edit_ast: {
    risk: "medium",
    stateScope: "workspace",
    isolation: "workspace",
    expectedArtifacts: ["file_change"],
  },
  copy_file: {
    risk: "medium",
    stateScope: "workspace",
    isolation: "workspace",
    expectedArtifacts: ["file_change"],
  },
  rename_file: {
    risk: "medium",
    stateScope: "workspace",
    isolation: "workspace",
    expectedArtifacts: ["file_change"],
  },
  add_dependency: {
    risk: "medium",
    stateScope: "workspace",
    isolation: "workspace",
    expectedArtifacts: ["package_change"],
  },
  create_project: {
    risk: "medium",
    stateScope: "workspace",
    isolation: "workspace",
    expectedArtifacts: ["project_files"],
  },
  update_todos: {
    risk: "low",
    stateScope: "workspace",
    isolation: "workspace",
    expectedArtifacts: ["todo_state"],
  },
  write_plan: {
    risk: "low",
    stateScope: "workspace",
    isolation: "workspace",
    expectedArtifacts: ["plan"],
  },
  exit_plan: {
    risk: "low",
    stateScope: "workspace",
    isolation: "workspace",
    expectedArtifacts: ["plan"],
  },
  generate_image: {
    risk: "medium",
    stateScope: "workspace",
    isolation: "workspace",
    expectedArtifacts: ["image"],
  },
  generate_media_asset: {
    risk: "medium",
    stateScope: "workspace",
    isolation: "workspace",
    expectedArtifacts: ["image", "audio", "video"],
  },

  start_dev_server: {
    risk: "medium",
    stateScope: "runtime",
    isolation: "workspace",
    expectedArtifacts: ["runtime_session"],
  },
  stop_dev_server: {
    risk: "medium",
    stateScope: "runtime",
    isolation: "workspace",
    expectedArtifacts: ["runtime_session"],
  },
  verify_project: {
    risk: "medium",
    stateScope: "runtime",
    isolation: "workspace",
    expectedArtifacts: ["verification_report"],
  },
  run_type_checks: {
    risk: "medium",
    stateScope: "runtime",
    isolation: "workspace",
    expectedArtifacts: ["typecheck_report"],
  },
  run_project_check: {
    risk: "medium",
    stateScope: "runtime",
    isolation: "workspace",
    expectedArtifacts: ["project_check_report"],
  },
  take_screenshot: {
    risk: "medium",
    stateScope: "runtime",
    isolation: "workspace",
    expectedArtifacts: ["screenshot"],
  },
  browser_control: {
    risk: "medium",
    stateScope: "runtime",
    isolation: "workspace",
    expectedArtifacts: ["browser_snapshot", "screenshot"],
  },
  browser_qa_gate: {
    risk: "medium",
    stateScope: "runtime",
    isolation: "workspace",
    expectedArtifacts: [
      "runtime_session",
      "screenshot",
      "accessibility_tree",
      "console_output",
    ],
  },

  run_terminal_command: {
    risk: "medium",
    stateScope: "host",
    isolation: "sandbox",
    expectedArtifacts: ["terminal_output"],
  },
  execute_sql: {
    risk: "high",
    stateScope: "external",
    isolation: "sandbox",
    expectedArtifacts: ["database_change"],
  },
  add_integration: {
    risk: "high",
    stateScope: "external",
    isolation: "sandbox",
    expectedArtifacts: ["integration_change"],
  },
  manage_mcp_server: {
    risk: "medium",
    stateScope: "external",
    isolation: "sandbox",
    expectedArtifacts: ["mcp_state"],
  },
  deploy_preview: {
    risk: "high",
    stateScope: "external",
    isolation: "sandbox",
    expectedArtifacts: ["deployment"],
  },
  package_native_artifact: {
    risk: "high",
    stateScope: "host",
    isolation: "sandbox",
    expectedArtifacts: ["native_artifact", "download_site"],
  },
  delete_file: {
    risk: "high",
    stateScope: "workspace",
    isolation: "workspace",
    expectedArtifacts: ["file_change"],
  },
};

export function getToolCapability(
  toolName: string,
  options: { mcpToolTrustOverrides?: McpToolTrustOverrideMap } = {},
): ToolCapability {
  if (TOOL_CAPABILITIES[toolName]) {
    return TOOL_CAPABILITIES[toolName];
  }
  if (isMcpToolKey(toolName)) {
    const mcpCapability = getMcpToolCapability(
      toolName,
      options.mcpToolTrustOverrides,
    );
    if (mcpCapability) {
      return {
        risk: mcpCapability.risk,
        stateScope: mcpCapability.stateScope,
        isolation: mcpCapability.isolation,
        expectedArtifacts: mcpCapability.expectedArtifacts,
      };
    }
  }
  return {
    risk: "medium",
    stateScope: "external",
    isolation: "sandbox",
    expectedArtifacts: [],
  };
}

export function isReadOnlyTool(
  toolName: string,
  options: { mcpToolTrustOverrides?: McpToolTrustOverrideMap } = {},
): boolean {
  return getToolCapability(toolName, options).stateScope === "read_only";
}

export function isWorkspaceScopedTool(
  toolName: string,
  options: { mcpToolTrustOverrides?: McpToolTrustOverrideMap } = {},
): boolean {
  const scope = getToolCapability(toolName, options).stateScope;
  return scope === "workspace" || scope === "runtime";
}

export function isExternalStateTool(
  toolName: string,
  options: { mcpToolTrustOverrides?: McpToolTrustOverrideMap } = {},
): boolean {
  const scope = getToolCapability(toolName, options).stateScope;
  return scope === "external" || scope === "host";
}
