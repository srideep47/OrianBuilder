import { describe, expect, it } from "vitest";

import {
  getMcpToolCapability,
  shouldRequireExplicitMcpConsent,
} from "@/ipc/utils/mcp_tool_capabilities";
import { getToolCapability } from "@/ipc/utils/tool_capabilities";

describe("mcp tool capabilities", () => {
  it("classifies known remote read tools as low-risk read-only", () => {
    expect(getMcpToolCapability("github__list_issues")).toMatchObject({
      serverName: "github",
      toolName: "list_issues",
      trust: "known",
      requiresExplicitConsent: false,
      risk: "low",
      stateScope: "read_only",
      isolation: "sandbox",
    });
  });

  it("requires explicit consent for remote write tools", () => {
    expect(getMcpToolCapability("github__create_issue")).toMatchObject({
      trust: "known",
      requiresExplicitConsent: true,
      risk: "high",
      stateScope: "external",
    });
    expect(shouldRequireExplicitMcpConsent("github__create_issue")).toBe(true);
  });

  it("maps filesystem MCP tools into workspace scope", () => {
    expect(getMcpToolCapability("filesystem__read_file")).toMatchObject({
      trust: "known",
      risk: "low",
      stateScope: "read_only",
      requiresExplicitConsent: false,
    });
    expect(getMcpToolCapability("filesystem__write_file")).toMatchObject({
      trust: "known",
      risk: "medium",
      stateScope: "workspace",
      requiresExplicitConsent: false,
    });
  });

  it("maps browser MCP tools into runtime scope", () => {
    expect(getMcpToolCapability("playwright__screenshot")).toMatchObject({
      trust: "known",
      risk: "medium",
      stateScope: "runtime",
      expectedArtifacts: ["mcp_tool_result", "browser_snapshot"],
    });
  });

  it("keeps unknown MCP tools sandboxed and consent-gated", () => {
    expect(getToolCapability("unknown-server__mutate")).toMatchObject({
      risk: "medium",
      stateScope: "external",
      isolation: "sandbox",
      expectedArtifacts: ["mcp_tool_result"],
    });
    expect(shouldRequireExplicitMcpConsent("unknown-server__mutate")).toBe(
      true,
    );
  });

  it("applies user trust overrides to MCP capability decisions", () => {
    expect(
      getMcpToolCapability("unknown-server__mutate", {
        "unknown-server__mutate": {
          risk: "low",
          stateScope: "workspace",
          requiresExplicitConsent: false,
        },
      }),
    ).toMatchObject({
      risk: "low",
      stateScope: "workspace",
      requiresExplicitConsent: false,
      overrideApplied: true,
    });
    expect(
      shouldRequireExplicitMcpConsent("unknown-server__mutate", {
        "unknown-server__mutate": {
          requiresExplicitConsent: false,
        },
      }),
    ).toBe(false);
  });
});
