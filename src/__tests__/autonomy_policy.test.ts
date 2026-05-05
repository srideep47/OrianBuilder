import { describe, expect, it } from "vitest";

import {
  getAutonomyPolicyDecision,
  getToolRisk,
} from "@/ipc/utils/autonomy_policy";

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
      risk: "low",
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
});
