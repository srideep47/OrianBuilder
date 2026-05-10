import type { MissionAutonomyProfile } from "@/ipc/types/mission";
import type { RuntimeMode2 } from "@/lib/schemas";
import {
  getToolCapability,
  isExternalStateTool,
  isReadOnlyTool,
  isWorkspaceScopedTool,
  type ToolCapabilityRisk,
} from "./tool_capabilities";
import {
  isMcpToolKey,
  shouldRequireExplicitMcpConsent,
  type McpToolTrustOverrideMap,
} from "./mcp_tool_capabilities";

export type AutonomyPolicyDecision = {
  decision: "auto_approve" | "ask" | "deny";
  reason: string;
  risk: ToolCapabilityRisk;
};

const DESTRUCTIVE_TOOL_NAMES = new Set(["delete_file", "execute_sql"]);
const ALWAYS_ASK_TOOLS = new Set(["deploy_preview"]);

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
  mcpToolTrustOverrides?: McpToolTrustOverrideMap;
}): ToolCapabilityRisk {
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
  return getToolCapability(params.toolName, {
    mcpToolTrustOverrides: params.mcpToolTrustOverrides,
  }).risk;
}

export function getAutonomyPolicyDecision(params: {
  profile: MissionAutonomyProfile;
  runtimeMode: RuntimeMode2;
  toolName: string;
  inputPreview?: string | null;
  mcpToolTrustOverrides?: McpToolTrustOverrideMap;
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

  const capabilityOptions = {
    mcpToolTrustOverrides: params.mcpToolTrustOverrides,
  };

  if (isReadOnlyTool(params.toolName, capabilityOptions)) {
    return {
      decision: "auto_approve",
      risk,
      reason: "Read-only tool is allowed by autonomy policy.",
    };
  }

  if (ALWAYS_ASK_TOOLS.has(params.toolName)) {
    return {
      decision: "ask",
      risk,
      reason:
        "This tool affects external deployment state and requires explicit consent.",
    };
  }

  if (
    isMcpToolKey(params.toolName) &&
    shouldRequireExplicitMcpConsent(
      params.toolName,
      params.mcpToolTrustOverrides,
    )
  ) {
    return {
      decision: "ask",
      risk,
      reason:
        "This MCP tool can affect an external or unknown system and requires explicit consent.",
    };
  }

  if (params.profile === "trusted-workspace") {
    if (
      risk === "high" ||
      isExternalStateTool(params.toolName, capabilityOptions) ||
      params.toolName === "delete_file"
    ) {
      return {
        decision: "ask",
        risk,
        reason:
          "Trusted workspace profile requires consent for high-risk or external-state actions.",
      };
    }
    if (isWorkspaceScopedTool(params.toolName, capabilityOptions)) {
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
