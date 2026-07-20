import type { DetectedPackageManager } from "@/ipc/utils/project_stack_detector";

export type PackageManagerCommandNormalization = {
  command: string;
  rewritten: boolean;
  reason: string | null;
};

function hasPackageArgument(rawArgs: string): boolean {
  const valueOptions = new Set([
    "--prefix",
    "--workspace",
    "-w",
    "--registry",
    "--cache",
  ]);
  const tokens = rawArgs.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  let skipNext = false;
  for (const token of tokens) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (valueOptions.has(token)) {
      skipNext = true;
      continue;
    }
    if (!token.startsWith("-")) return true;
  }
  return false;
}

function normalizeInstallFlags(
  rawArgs: string,
  manager: Exclude<DetectedPackageManager, "npm" | "unknown">,
): string {
  let args = rawArgs
    .replace(/\s+--legacy-peer-deps\b/gi, "")
    .replace(/\s+--no-audit\b/gi, "")
    .replace(/\s+--no-fund\b/gi, "")
    .replace(/\s+--save(?:-prod)?(?=\s|$)/gi, "")
    .trim();

  if (manager === "yarn" || manager === "bun") {
    args = args.replace(/(^|\s)(?:--save-dev|-D)(?=\s|$)/gi, "$1--dev");
  }
  return args;
}

/**
 * Keep terminal installs aligned with the package manager declared by the
 * project. This protects autonomous runs from npm operating on a pnpm/yarn/
 * bun lockfile (the exact mismatch that caused npm's Arborist `matches`
 * exception in the failed Windows session).
 */
export function normalizePackageManagerCommand(
  requestedCommand: string,
  preferredManager: DetectedPackageManager,
): PackageManagerCommandNormalization {
  if (preferredManager === "npm" || preferredManager === "unknown") {
    return { command: requestedCommand, rewritten: false, reason: null };
  }

  let command = requestedCommand.replace(
    /\bnpm\s+cache\s+clean\s+--force\s*(?:&&|;)\s*/gi,
    "",
  );

  command = command.replace(
    /\bnpm\s+(?:install|i)\b([^&|;\r\n]*)/gi,
    (_match, rawArgs: string) => {
      const args = normalizeInstallFlags(rawArgs, preferredManager);
      const verb = hasPackageArgument(args) ? "add" : "install";
      return `${preferredManager} ${verb}${args ? ` ${args}` : ""}`;
    },
  );

  command = command.replace(/\bnpm\s+ci\b/gi, () => {
    if (preferredManager === "pnpm") {
      return "pnpm install --frozen-lockfile";
    }
    if (preferredManager === "yarn") {
      return "yarn install --immutable";
    }
    return "bun install --frozen-lockfile";
  });

  const rewritten = command !== requestedCommand;
  return {
    command,
    rewritten,
    reason: rewritten
      ? `Detected ${preferredManager} project metadata; translated npm dependency command to ${preferredManager}.`
      : null,
  };
}
