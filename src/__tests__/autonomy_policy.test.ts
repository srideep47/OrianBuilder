import { describe, expect, it } from "vitest";

import {
  getAutonomyPolicyDecision,
  getToolRisk,
} from "@/ipc/utils/autonomy_policy";
import { getToolCapability } from "@/ipc/utils/tool_capabilities";

describe("autonomy policy", () => {
  it("blocks critical destructive commands before consent", () => {
    expect(
      getAutonomyPolicyDecision({
        profile: "full-autopilot-sandbox",
        runtimeMode: "cloud",
        toolName: "run_terminal_command",
        inputPreview: "Run: rm -rf /",
      }),
    ).toMatchObject({
      decision: "deny",
      risk: "critical",
    });
  });

  it("requires consent for high-risk host actions in full autopilot", () => {
    expect(
      getAutonomyPolicyDecision({
        profile: "full-autopilot-sandbox",
        runtimeMode: "host",
        toolName: "delete_file",
        inputPreview: "Delete src/App.tsx",
      }),
    ).toMatchObject({
      decision: "ask",
      risk: "high",
    });
  });

  it("allows scoped workspace tools in trusted workspace", () => {
    expect(
      getAutonomyPolicyDecision({
        profile: "trusted-workspace",
        runtimeMode: "host",
        toolName: "write_file",
        inputPreview: "Write src/App.tsx",
      }),
    ).toMatchObject({
      decision: "auto_approve",
      risk: "medium",
    });
  });

  it("classifies external shell commands as medium risk unless destructive", () => {
    expect(
      getToolRisk({
        toolName: "run_terminal_command",
        inputPreview: "Run: npm test",
      }),
    ).toBe("medium");
  });

  it("routes MCP runtime management through external-state consent", () => {
    expect(
      getAutonomyPolicyDecision({
        profile: "trusted-workspace",
        runtimeMode: "host",
        toolName: "manage_mcp_server",
        inputPreview: "reload MCP server 1",
      }),
    ).toMatchObject({
      decision: "ask",
      risk: "medium",
    });
  });

  it("allows browser control as a runtime tool in trusted workspace", () => {
    expect(
      getAutonomyPolicyDecision({
        profile: "trusted-workspace",
        runtimeMode: "host",
        toolName: "browser_control",
        inputPreview: "screenshot preview",
      }),
    ).toMatchObject({
      decision: "auto_approve",
      risk: "medium",
    });
  });

  it("allows browser QA gate as a runtime tool in trusted workspace", () => {
    expect(
      getAutonomyPolicyDecision({
        profile: "trusted-workspace",
        runtimeMode: "host",
        toolName: "browser_qa_gate",
        inputPreview: "run full browser QA",
      }),
    ).toMatchObject({
      decision: "auto_approve",
      risk: "medium",
    });
  });

  it("exposes explicit tool capabilities for project checks", () => {
    expect(getToolCapability("run_project_check")).toMatchObject({
      risk: "medium",
      stateScope: "runtime",
      isolation: "workspace",
      expectedArtifacts: ["project_check_report"],
    });
  });

  it("treats remote MCP write tool keys as consent-gated external tools", () => {
    expect(getToolCapability("github__create_issue")).toMatchObject({
      risk: "high",
      stateScope: "external",
      isolation: "sandbox",
      expectedArtifacts: ["mcp_tool_result"],
    });
    expect(
      getAutonomyPolicyDecision({
        profile: "trusted-workspace",
        runtimeMode: "host",
        toolName: "github__create_issue",
        inputPreview: "create issue",
      }),
    ).toMatchObject({
      decision: "ask",
      risk: "high",
    });
  });

  it("auto-approves known read-only MCP tools in autopilot", () => {
    expect(
      getAutonomyPolicyDecision({
        profile: "full-autopilot-sandbox",
        runtimeMode: "cloud",
        toolName: "github__list_issues",
        inputPreview: "list issues",
      }),
    ).toMatchObject({
      decision: "auto_approve",
      risk: "low",
    });
  });

  it("uses MCP trust overrides when deciding autonomy", () => {
    expect(
      getAutonomyPolicyDecision({
        profile: "trusted-workspace",
        runtimeMode: "cloud",
        toolName: "unknown-server__mutate",
        inputPreview: "workspace-safe custom MCP operation",
        mcpToolTrustOverrides: {
          "unknown-server__mutate": {
            risk: "medium",
            stateScope: "workspace",
            requiresExplicitConsent: false,
          },
        },
      }),
    ).toMatchObject({
      decision: "auto_approve",
      risk: "medium",
    });
  });

  it("requires consent for deploy preview because it touches external state", () => {
    expect(getToolCapability("deploy_preview")).toMatchObject({
      risk: "high",
      stateScope: "external",
      expectedArtifacts: ["deployment"],
    });
    expect(
      getAutonomyPolicyDecision({
        profile: "full-autopilot-sandbox",
        runtimeMode: "cloud",
        toolName: "deploy_preview",
        inputPreview: "Create preview deployment",
      }),
    ).toMatchObject({
      decision: "ask",
      risk: "high",
    });
  });
});
