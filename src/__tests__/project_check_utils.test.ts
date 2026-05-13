import { describe, expect, it } from "vitest";

import type { ProjectStackDetection } from "@/ipc/utils/project_stack_detector";
import {
  projectCheckLabel,
  resolveProjectCheckCommand,
} from "@/pro/main/ipc/handlers/local_agent/tools/project_check_utils";

function stack(
  overrides: Partial<ProjectStackDetection>,
): ProjectStackDetection {
  return {
    rootPath: "D:/app",
    packageManager: "npm",
    framework: "vite",
    kind: "frontend",
    language: "typescript",
    scripts: {},
    dependencies: [],
    devDependencies: [],
    configFiles: [],
    lockfiles: [],
    commands: {
      install: "npm install",
      dev: "npm run dev",
      start: "npm run start",
      build: null,
      test: null,
      lint: null,
      typecheck: null,
    },
    confidence: "medium",
    evidence: [],
    warnings: [],
    ...overrides,
  };
}

describe("project check utils", () => {
  it("uses detected commands for standard checks", () => {
    expect(
      resolveProjectCheckCommand({
        stack: stack({
          commands: {
            install: "pnpm install",
            dev: null,
            start: null,
            build: "pnpm build",
            test: null,
            lint: "pnpm lint",
            typecheck: "pnpm typecheck",
          },
        }),
        check: "build",
      }),
    ).toEqual({
      check: "build",
      command: "pnpm build",
      source: "detected",
    });
  });

  it("falls back to e2e scripts when the stack detector has no command slot", () => {
    expect(
      resolveProjectCheckCommand({
        stack: stack({
          packageManager: "pnpm",
          scripts: {
            "test:e2e": "playwright test",
          },
        }),
        check: "e2e_test",
      }),
    ).toEqual({
      check: "e2e_test",
      command: "pnpm test:e2e",
      source: "script",
    });
  });

  it("infers TypeScript checks when no script exists", () => {
    expect(
      resolveProjectCheckCommand({
        stack: stack({
          packageManager: "pnpm",
          scripts: {},
          commands: {
            install: "pnpm install",
            dev: "pnpm dev",
            start: null,
            build: "pnpm build",
            test: null,
            lint: null,
            typecheck: null,
          },
          configFiles: ["tsconfig.json"],
        }),
        check: "typecheck",
      }),
    ).toEqual({
      check: "typecheck",
      command: "pnpm exec tsc --noEmit",
      source: "inferred",
    });
  });

  it("reports missing checks without inventing risky commands", () => {
    expect(
      resolveProjectCheckCommand({
        stack: stack({ scripts: {}, language: "javascript" }),
        check: "typecheck",
      }),
    ).toEqual({
      check: "typecheck",
      command: null,
      source: "missing",
    });
  });

  it("labels checks for consent and summaries", () => {
    expect(projectCheckLabel("unit_test")).toBe("Unit tests");
    expect(projectCheckLabel("e2e_test")).toBe("E2E tests");
  });
});
