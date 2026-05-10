import { parseMcpToolKey, MCP_TOOL_KEY_SEPARATOR } from "./mcp_tool_utils";
import type {
  ToolCapability,
  ToolCapabilityRisk,
  ToolStateScope,
} from "./tool_capabilities";

export type McpToolCapabilityDecision = ToolCapability & {
  serverName: string;
  toolName: string;
  requiresExplicitConsent: boolean;
  trust: "known" | "inferred" | "unknown";
  overrideApplied?: boolean;
};

export type McpToolTrustOverride = {
  risk?: ToolCapabilityRisk | null;
  stateScope?: ToolStateScope | null;
  requiresExplicitConsent?: boolean | null;
};

export type McpToolTrustOverrideMap = Record<string, McpToolTrustOverride>;

const READ_ONLY_TOOL_PATTERNS = [
  /^(get|list|read|search|find|fetch|query|inspect|describe|status|lookup)/i,
  /(get|list|read|search|find|fetch|query|inspect|describe|status|lookup)$/i,
];

const WRITE_TOOL_PATTERNS = [
  /^(create|add|write|update|edit|patch|send|post|publish|upload|invite|assign|comment|reply|move|copy|rename)/i,
  /(create|add|write|update|edit|patch|send|post|publish|upload|invite|assign|comment|reply|move|copy|rename)$/i,
];

const DESTRUCTIVE_TOOL_PATTERNS = [
  /^(delete|remove|destroy|drop|truncate|reset|revoke|archive|close|cancel|disable|force)/i,
  /(delete|remove|destroy|drop|truncate|reset|revoke|archive|close|cancel|disable|force)$/i,
];

const WORKSPACE_SERVER_PATTERNS = [
  /^fs$/i,
  /^file(system)?$/i,
  /filesystem/i,
  /workspace/i,
  /repo/i,
];

const BROWSER_SERVER_PATTERNS = [/browser/i, /playwright/i, /puppeteer/i];

const REMOTE_SERVICE_SERVER_PATTERNS = [
  /github/i,
  /gitlab/i,
  /linear/i,
  /jira/i,
  /slack/i,
  /gmail/i,
  /email/i,
  /calendar/i,
  /notion/i,
  /drive/i,
  /sheets/i,
  /docs/i,
  /vercel/i,
  /supabase/i,
  /stripe/i,
  /aws/i,
  /azure/i,
  /gcp/i,
];

function matchesAny(value: string, patterns: RegExp[]) {
  return patterns.some((pattern) => pattern.test(value));
}

export function isMcpToolKey(toolName: string): boolean {
  return toolName.includes(MCP_TOOL_KEY_SEPARATOR);
}

export function getMcpToolCapability(
  toolKey: string,
  overrides: McpToolTrustOverrideMap = {},
): McpToolCapabilityDecision | null {
  if (!isMcpToolKey(toolKey)) {
    return null;
  }

  const { serverName, toolName } = parseMcpToolKey(toolKey);
  if (!serverName || !toolName) {
    return applyMcpToolTrustOverride(toolKey, overrides, {
      serverName,
      toolName,
      trust: "unknown",
      requiresExplicitConsent: true,
      risk: "medium",
      stateScope: "external",
      isolation: "sandbox",
      expectedArtifacts: ["mcp_tool_result"],
    });
  }

  const combined = `${serverName} ${toolName}`;
  const isReadOnly = matchesAny(toolName, READ_ONLY_TOOL_PATTERNS);
  const isWrite = matchesAny(toolName, WRITE_TOOL_PATTERNS);
  const isDestructive = matchesAny(toolName, DESTRUCTIVE_TOOL_PATTERNS);
  const isWorkspaceServer = matchesAny(serverName, WORKSPACE_SERVER_PATTERNS);
  const isBrowserServer = matchesAny(serverName, BROWSER_SERVER_PATTERNS);
  const isRemoteService = matchesAny(
    serverName,
    REMOTE_SERVICE_SERVER_PATTERNS,
  );

  if (isBrowserServer) {
    return applyMcpToolTrustOverride(toolKey, overrides, {
      serverName,
      toolName,
      trust: "known",
      requiresExplicitConsent: false,
      risk: isDestructive ? "high" : "medium",
      stateScope: "runtime",
      isolation: "workspace",
      expectedArtifacts: ["mcp_tool_result", "browser_snapshot"],
    });
  }

  if (isWorkspaceServer) {
    return applyMcpToolTrustOverride(toolKey, overrides, {
      serverName,
      toolName,
      trust: "known",
      requiresExplicitConsent: false,
      risk: isDestructive ? "high" : isReadOnly ? "low" : "medium",
      stateScope: isReadOnly ? "read_only" : "workspace",
      isolation: "workspace",
      expectedArtifacts: ["mcp_tool_result"],
    });
  }

  if (isRemoteService) {
    return applyMcpToolTrustOverride(toolKey, overrides, {
      serverName,
      toolName,
      trust: "known",
      requiresExplicitConsent: !isReadOnly,
      risk: isDestructive || isWrite ? "high" : "low",
      stateScope: isReadOnly ? "read_only" : "external",
      isolation: "sandbox",
      expectedArtifacts: ["mcp_tool_result"],
    });
  }

  if (isReadOnly && !matchesAny(combined, DESTRUCTIVE_TOOL_PATTERNS)) {
    return applyMcpToolTrustOverride(toolKey, overrides, {
      serverName,
      toolName,
      trust: "inferred",
      requiresExplicitConsent: false,
      risk: "low",
      stateScope: "read_only",
      isolation: "none",
      expectedArtifacts: ["mcp_tool_result"],
    });
  }

  return applyMcpToolTrustOverride(toolKey, overrides, {
    serverName,
    toolName,
    trust: "unknown",
    requiresExplicitConsent: true,
    risk: isDestructive ? "high" : "medium",
    stateScope: "external",
    isolation: "sandbox",
    expectedArtifacts: ["mcp_tool_result"],
  });
}

function applyMcpToolTrustOverride(
  toolKey: string,
  overrides: McpToolTrustOverrideMap,
  base: McpToolCapabilityDecision,
): McpToolCapabilityDecision {
  const override = overrides[toolKey];
  if (!override) {
    return base;
  }

  return {
    ...base,
    risk: override.risk ?? base.risk,
    stateScope: override.stateScope ?? base.stateScope,
    requiresExplicitConsent:
      override.requiresExplicitConsent ?? base.requiresExplicitConsent,
    overrideApplied: true,
  };
}

export function shouldRequireExplicitMcpConsent(
  toolKey: string,
  overrides: McpToolTrustOverrideMap = {},
): boolean {
  return (
    getMcpToolCapability(toolKey, overrides)?.requiresExplicitConsent ?? false
  );
}
