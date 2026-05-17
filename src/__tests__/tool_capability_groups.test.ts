import { describe, expect, it } from "vitest";

import {
  getGroupedToolCapabilities,
  getToolCapabilityGroupCounts,
} from "@/ipc/utils/tool_capability_groups";

describe("tool capability groups", () => {
  it("groups built-in tools by state scope", () => {
    const groups = getGroupedToolCapabilities();

    expect(groups.map((group) => group.key)).toEqual([
      "read_only",
      "workspace",
      "runtime",
      "external",
    ]);
    expect(groups.find((group) => group.key === "runtime")?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolName: "browser_qa_gate",
          stateScope: "runtime",
        }),
        expect.objectContaining({
          toolName: "run_project_check",
          stateScope: "runtime",
        }),
      ]),
    );
  });

  it("marks deployment as always ask external state", () => {
    const external = getGroupedToolCapabilities().find(
      (group) => group.key === "external",
    );

    expect(external?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolName: "deploy_preview",
          risk: "high",
          stateScope: "external",
          alwaysAsk: true,
        }),
      ]),
    );
  });

  it("returns stable group counts", () => {
    const counts = getToolCapabilityGroupCounts();

    expect(counts.read_only).toBeGreaterThan(0);
    expect(counts.workspace).toBeGreaterThan(0);
    expect(counts.runtime).toBeGreaterThan(0);
    expect(counts.external).toBeGreaterThan(0);
  });
});
