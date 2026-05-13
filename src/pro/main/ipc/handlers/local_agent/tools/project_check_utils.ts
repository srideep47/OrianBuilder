import type {
  ProjectStackCommands,
  ProjectStackDetection,
} from "@/ipc/utils/project_stack_detector";

export const PROJECT_CHECK_NAMES = [
  "install",
  "lint",
  "typecheck",
  "build",
  "unit_test",
  "e2e_test",
] as const;

export type ProjectCheckName = (typeof PROJECT_CHECK_NAMES)[number];

export type ProjectCheckResolution = {
  check: ProjectCheckName;
  command: string | null;
  source: "detected" | "script" | "inferred" | "missing";
};

function commandForScript(
  packageManager: ProjectStackDetection["packageManager"],
  script: string,
): string {
  if (packageManager === "pnpm") return `pnpm ${script}`;
  if (packageManager === "yarn") return `yarn ${script}`;
  if (packageManager === "bun") return `bun run ${script}`;
  return `npm run ${script}`;
}

function findFirstScript(
  scripts: Record<string, string>,
  candidates: string[],
): string | null {
  return candidates.find((script) => scripts[script]) ?? null;
}

function commandForTsc(
  packageManager: ProjectStackDetection["packageManager"],
): string {
  if (packageManager === "pnpm") return "pnpm exec tsc --noEmit";
  if (packageManager === "yarn") return "yarn tsc --noEmit";
  if (packageManager === "bun") return "bunx tsc --noEmit";
  return "npx tsc --noEmit";
}

function commandFromDetected(
  commands: ProjectStackCommands,
  check: ProjectCheckName,
): string | null {
  switch (check) {
    case "install":
      return commands.install;
    case "lint":
      return commands.lint;
    case "typecheck":
      return commands.typecheck;
    case "build":
      return commands.build;
    case "unit_test":
      return commands.test;
    case "e2e_test":
      return null;
  }
}

export function resolveProjectCheckCommand(params: {
  stack: ProjectStackDetection;
  check: ProjectCheckName;
}): ProjectCheckResolution {
  const detected = commandFromDetected(params.stack.commands, params.check);
  if (detected) {
    return {
      check: params.check,
      command: detected,
      source: "detected",
    };
  }

  const fallbackScript =
    params.check === "e2e_test"
      ? findFirstScript(params.stack.scripts, [
          "e2e",
          "test:e2e",
          "playwright",
          "test:playwright",
        ])
      : params.check === "unit_test"
        ? findFirstScript(params.stack.scripts, [
            "test:unit",
            "unit",
            "vitest",
            "jest",
          ])
        : null;

  if (fallbackScript) {
    return {
      check: params.check,
      command: commandForScript(params.stack.packageManager, fallbackScript),
      source: "script",
    };
  }

  if (
    params.check === "typecheck" &&
    (params.stack.language === "typescript" ||
      params.stack.language === "mixed" ||
      params.stack.configFiles.includes("tsconfig.json"))
  ) {
    return {
      check: params.check,
      command: commandForTsc(params.stack.packageManager),
      source: "inferred",
    };
  }

  return {
    check: params.check,
    command: null,
    source: "missing",
  };
}

export function projectCheckLabel(check: ProjectCheckName): string {
  switch (check) {
    case "install":
      return "Install";
    case "lint":
      return "Lint";
    case "typecheck":
      return "Type check";
    case "build":
      return "Build";
    case "unit_test":
      return "Unit tests";
    case "e2e_test":
      return "E2E tests";
  }
}
