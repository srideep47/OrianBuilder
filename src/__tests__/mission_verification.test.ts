import { describe, expect, it } from "vitest";

import {
  getMissionEventSummaryForXml,
  getMissionVerificationEventForXml,
} from "@/ipc/utils/mission_verification";

describe("mission verification event classification", () => {
  it("classifies successful type checks", () => {
    expect(
      getMissionVerificationEventForXml(
        '<dyad-status title="Type checking all files">\nNo type errors found.\n</dyad-status>',
      ),
    ).toMatchObject({
      eventType: "verification_typecheck",
      status: "passed",
      check: "typecheck",
      problemCount: 0,
    });
  });

  it("classifies failed type checks", () => {
    expect(
      getMissionVerificationEventForXml(
        '<dyad-status title="Type checking: src/App.tsx">\nFound 2 type error(s):\n</dyad-status>',
      ),
    ).toMatchObject({
      eventType: "verification_typecheck",
      status: "failed",
      check: "typecheck",
      problemCount: 2,
    });
  });

  it("classifies install, build, and test terminal commands", () => {
    expect(
      getMissionVerificationEventForXml(
        '<dyad-terminal-command cmd="pnpm install" exit-code="0">ok</dyad-terminal-command>',
      ),
    ).toMatchObject({
      eventType: "verification_install",
      status: "passed",
      check: "install",
      command: "pnpm install",
      exitCode: 0,
    });

    expect(
      getMissionVerificationEventForXml(
        '<dyad-terminal-command cmd="npm run build" exit-code="0">ok</dyad-terminal-command>',
      ),
    ).toMatchObject({
      eventType: "verification_build",
      status: "passed",
      check: "build",
      command: "npm run build",
      exitCode: 0,
    });

    expect(
      getMissionVerificationEventForXml(
        '<dyad-terminal-command cmd="npm test" exit-code="1">fail</dyad-terminal-command>',
      ),
    ).toMatchObject({
      eventType: "verification_test",
      status: "failed",
      check: "test",
      command: "npm test",
      exitCode: 1,
    });
  });

  it("ignores non-verification terminal commands", () => {
    expect(
      getMissionVerificationEventForXml(
        '<dyad-terminal-command cmd="ls" exit-code="0">files</dyad-terminal-command>',
      ),
    ).toBeNull();
  });

  it("summarizes arbitrary agent XML", () => {
    expect(getMissionEventSummaryForXml("<dyad-write>code</dyad-write>")).toBe(
      "Agent output: dyad-write",
    );
    expect(getMissionEventSummaryForXml("plain text")).toBe("Agent output");
  });
});
