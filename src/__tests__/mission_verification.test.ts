import { describe, expect, it } from "vitest";

import {
  getMissionEventSummaryForXml,
  getMissionVerificationEventForXml,
} from "@/ipc/utils/mission_verification";

describe("mission verification event classification", () => {
  it("classifies successful type checks", () => {
    expect(
      getMissionVerificationEventForXml(
        '<orianbuilder-status title="Type checking all files">\nNo type errors found.\n</orianbuilder-status>',
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
        '<orianbuilder-status title="Type checking: src/App.tsx">\nFound 2 type error(s):\n</orianbuilder-status>',
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
        '<orianbuilder-terminal-command cmd="pnpm install" exit-code="0">ok</orianbuilder-terminal-command>',
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
        '<orianbuilder-terminal-command cmd="npm run build" exit-code="0">ok</orianbuilder-terminal-command>',
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
        '<orianbuilder-terminal-command cmd="npm test" exit-code="1">fail</orianbuilder-terminal-command>',
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
        '<orianbuilder-terminal-command cmd="ls" exit-code="0">files</orianbuilder-terminal-command>',
      ),
    ).toBeNull();
  });

  it("classifies structured project check XML", () => {
    expect(
      getMissionVerificationEventForXml(
        '<orianbuilder-project-check check="build" command="npm run build" status="failed" exit-code="1">failed</orianbuilder-project-check>',
      ),
    ).toMatchObject({
      eventType: "verification_build",
      status: "failed",
      check: "build",
      command: "npm run build",
      exitCode: 1,
    });

    expect(
      getMissionVerificationEventForXml(
        '<orianbuilder-project-check check="e2e_test" command="npm run test:e2e" status="passed" exit-code="0">ok</orianbuilder-project-check>',
      ),
    ).toMatchObject({
      eventType: "verification_test",
      status: "passed",
      check: "test",
      command: "npm run test:e2e",
      exitCode: 0,
    });
  });

  it("summarizes arbitrary agent XML", () => {
    expect(
      getMissionEventSummaryForXml(
        "<orianbuilder-write>code</orianbuilder-write>",
      ),
    ).toBe("Agent output: orianbuilder-write");
    expect(getMissionEventSummaryForXml("plain text")).toBe("Agent output");
  });
});
