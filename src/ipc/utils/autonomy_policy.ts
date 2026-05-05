import type { MissionAutonomyProfile } from "@/ipc/types/mission";
import type { RuntimeMode2 } from "@/lib/schemas";

export type AutonomyPolicyDecision = {
  decision: "auto_approve" | "ask" | "deny";
  reason: string;
  risk: "low" | "medium" | "high" | "critical";
};

const READ_ONLY_TOOLS = new Set([
  "read_file",
  "list_files",
  "grep",
  "code_search",
  "get_repo_map",
  "detect_project_stack",
  "read_logs",
  "read_console_output",
  "read_dev_server_output",
  "get_accessibility_tree",
  "get_database_table_schema",
  "get_supabase_project_info",
  "get_neon_project_info",
  "web_search",
  "web_fetch",
  "web_crawl",
  "read_guide",
  "set_chat_summary",
]);

const WORKSPACE_WRITE_TOOLS = new Set([
  "write_file",
  "search_replace",
  "edit_ast",
  "copy_file",
  "rename_file",
  "add_dependency",
  "create_project",
  "update_todos",
  "write_plan",
  "exit_plan",
]);

const RUNTIME_TOOLS = new Set([
  "start_dev_server",
  "stop_dev_server",
  "verify_project",
  "run_type_checks",
  "take_screenshot",
  "browser_control",
  "generate_image",
]);

const EXTERNAL_STATE_TOOLS = new Set([
  "run_terminal_command",
  "execute_sql",
  "add_integration",
  "manage_mcp_server",
]);

const DESTRUCTIVE_TOOL_NAMES = new Set(["delete_file", "execute_sql"]);

const CRITICAL_PATTERNS = [
  /\brm\s+-rf\b/i,
  /\brmdir\s+\/s\b/i,
  /\bdel\s+\/[sf]\b/i,
  /\bformat\b/i,
  /\bdrop\s+(database|schema|table)\b/i,
  /\btruncate\s+table\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bpoweroff\b/i,
  /\bcurl\s.*\|\s*(bash|sh)\b/i,
  /\bwget\s.*\|\s*(bash|sh)\b/i,
];

const HIGH_RISK_PATTERNS = [
  /\b(delete|remove|destroy|drop|truncate|reset|force|overwrite)\b/i,
  /\bgit\s+(reset|clean|checkout)\b/i,
  /\bnpm\s+(publish|unpublish)\b/i,
  /\b(pnpm|yarn|bun)\s+(publish|remove)\b/i,
  /\bdocker\s+(rm|rmi|system\s+prune|volume\s+rm)\b/i,
];

export function getToolRisk(params: {
  toolName: string;
  inputPreview?: string | null;
}): AutonomyPolicyDecision["risk"] {
  const haystack = `${params.toolName}\n${params.inputPreview ?? ""}`;
  if (CRITICAL_PATTERNS.some((pattern) => pattern.test(haystack))) {
    return "critical";
  }
  if (
    DESTRUCTIVE_TOOL_NAMES.has(params.toolName) ||
    HIGH_RISK_PATTERNS.some((pattern) => pattern.test(haystack))
  ) {
    return "high";
  }
  if (
    EXTERNAL_STATE_TOOLS.has(params.toolName) ||
    RUNTIME_TOOLS.has(params.toolName)
  ) {
    return "medium";
  }
  return "low";
}

export function getAutonomyPolicyDecision(params: {
  profile: MissionAutonomyProfile;
  runtimeMode: RuntimeMode2;
  toolName: string;
  inputPreview?: string | null;
}): AutonomyPolicyDecision {
  const risk = getToolRisk(params);
  if (risk === "critical") {
    return {
      decision: "deny",
      risk,
      reason: "Critical destructive action is blocked by autonomy policy.",
    };
  }

  if (params.profile === "supervised") {
    return {
      decision: "ask",
      risk,
      reason: "Supervised missions require consent for state-changing tools.",
    };
  }

  if (READ_ONLY_TOOLS.has(params.toolName)) {
    return {
      decision: "auto_approve",
      risk,
      reason: "Read-only tool is allowed by autonomy policy.",
    };
  }

  if (params.profile === "trusted-workspace") {
    if (
      risk === "high" ||
      EXTERNAL_STATE_TOOLS.has(params.toolName) ||
      params.toolName === "delete_file"
    ) {
      return {
        decision: "ask",
        risk,
        reason:
          "Trusted workspace profile requires consent for high-risk or external-state actions.",
      };
    }
    if (
      WORKSPACE_WRITE_TOOLS.has(params.toolName) ||
      RUNTIME_TOOLS.has(params.toolName)
    ) {
      return {
        decision: "auto_approve",
        risk,
        reason:
          "Trusted workspace profile allows scoped workspace and runtime tools.",
      };
    }
  }

  if (params.profile === "full-autopilot-sandbox") {
    if (risk === "high" && params.runtimeMode === "host") {
      return {
        decision: "ask",
        risk,
        reason:
          "High-risk host action requires consent until Docker/cloud isolation is active.",
      };
    }
    return {
      decision: "auto_approve",
      risk,
      reason: "Full autopilot sandbox profile allows this non-critical tool.",
    };
  }

  return {
    decision: "ask",
    risk,
    reason: "Tool is outside the scoped autonomy policy.",
  };
}
