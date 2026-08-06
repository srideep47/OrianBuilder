import path from "node:path";

import type {
  MartaCodingAcceptanceCheck,
  MartaCodingTaskAcceptanceDecision,
  MartaCodingTaskAcceptanceEvidence,
  MartaCodingTaskAcceptanceTarget,
  MartaCodingTaskCheckEvidence,
} from "@/ipc/types/marta";

export type CodingAcceptanceCheck = MartaCodingAcceptanceCheck;
export type CodingTaskAcceptanceTarget = MartaCodingTaskAcceptanceTarget;
export type CodingTaskCheckEvidence = MartaCodingTaskCheckEvidence;
export type CodingTaskAcceptanceEvidence = MartaCodingTaskAcceptanceEvidence;
export type CodingTaskAcceptanceDecision = MartaCodingTaskAcceptanceDecision;

/**
 * Does this request change something a person will look at?
 *
 * The list is long because the cost of being wrong is asymmetric. A false
 * negative skips the on-screen check entirely — which is exactly how
 * `rainbow-hello.html` passed. A false positive costs one preview start and one
 * offscreen render, and still produces a screenshot worth having.
 *
 * The words that motivated the additions: "Change the **homepage heading** text"
 * matched none of the original alternatives, because `\bpage\b` does not match
 * inside "homepage" and "heading" was not listed at all.
 */
const UI_GOAL = new RegExp(
  `\\b(?:${[
    // The surface itself. Compounds are spelled out because `\bpage\b` does not
    // match inside "homepage".
    "ui|ux|websites?|web ?pages?|home ?pages?|landing ?pages?|pages?|screens?",
    // The stack
    "frontend|front end|components?|layouts?|styles?|styling|css|html|tailwind|react|tsx|jsx|vue|svelte",
    // The things on it. Short words that are substrings of common unrelated
    // words — "form" in "perform", "card" in "discard" — are bounded, which is
    // why this is one anchored alternation rather than a bare `|` list.
    "headings?|headers?|footers?|titles?|buttons?|links?|navs?|navbar|navigation|menus?|sidebars?|modals?|dialogs?|forms?|hero|banners?|icons?|logos?",
    // How it looks
    "visuals?|colours?|colors?|themes?|fonts?|typography|spacing|dark mode|responsive",
    // Where it is checked
    "dashboards?|previews?",
  ].join("|")})\\b`,
  "i",
);
const TEST_GOAL = /\b(?:test|tests|testing|bug|fix|regression|refactor)\b/i;

/** Build a deterministic acceptance contract before a worker starts. */
export function deriveCodingTaskAcceptanceTarget(input: {
  goal: string;
  projectRoot?: string;
  targetPaths?: string[];
  readOnly?: boolean;
}): CodingTaskAcceptanceTarget {
  const readOnly = input.readOnly === true;
  const checks = new Set<CodingAcceptanceCheck>();
  if (!readOnly) checks.add("build");
  if (!readOnly && UI_GOAL.test(input.goal)) {
    checks.add("preview");
    // A healthy preview server only proves a server is answering. `visual`
    // renders the served route and reads its DOM, which is the only check that
    // can tell "the app changed" from "a file changed that the app never
    // loads" — the exact failure that shipped `rainbow-hello.html` as a success.
    checks.add("visual");
  }
  if (!readOnly && TEST_GOAL.test(input.goal)) checks.add("test");
  return {
    goal: input.goal,
    projectRoot: input.projectRoot,
    targetPaths: [...new Set((input.targetPaths ?? []).filter(Boolean))],
    readOnly,
    requireChangedFiles: !readOnly,
    requiredChecks: [...checks],
  };
}

/**
 * Render the contract into a worker prompt. The host still verifies every item;
 * this text merely tells the worker what evidence Orion will require.
 */
export function renderCodingTaskAcceptanceInstructions(
  target: CodingTaskAcceptanceTarget,
): string {
  if (target.readOnly) {
    return [
      "Orion acceptance contract:",
      "- This is read-only work. Do not modify project files or external state.",
      "- Inspect the real project and report concrete evidence for the conclusion.",
    ].join("\n");
  }

  const instructions = [
    "Orion acceptance contract:",
    "- Inspect the existing stack and active entry points before editing.",
    "- Change the live project implementation; an unused standalone demo file does not satisfy the task.",
    "- Keep all writes inside the current project workspace.",
    "- Report the exact changed files and verification commands at the end.",
  ];
  for (const check of target.requiredChecks) {
    switch (check) {
      case "build":
        instructions.push(
          "- Run the project's build and fix it until it passes.",
        );
        break;
      case "preview":
        instructions.push(
          "- Start or refresh the real app preview and verify the requested result is visible.",
        );
        break;
      case "test":
        instructions.push("- Run the relevant tests and fix failures.");
        break;
      case "typecheck":
        instructions.push("- Run the project's typecheck and fix failures.");
        break;
      case "visual":
        instructions.push(
          "- Capture and inspect visual verification evidence.",
        );
        break;
    }
  }
  return instructions.join("\n");
}

/** Add the acceptance contract once while preserving the user's exact goal. */
export function appendCodingTaskAcceptanceInstructions(
  prompt: string,
  target: CodingTaskAcceptanceTarget,
): string {
  if (/^Orion acceptance contract:/m.test(prompt)) return prompt;
  return `${prompt.trim()}\n\n${renderCodingTaskAcceptanceInstructions(target)}`;
}

function slash(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
}

function isAbsolute(value: string): boolean {
  return /^[a-z]:\//i.test(value) || value.startsWith("/");
}

function portableResolve(value: string): string {
  return slash(
    /^[a-z]:\//i.test(slash(value))
      ? path.win32.resolve(value)
      : path.resolve(value),
  );
}

/**
 * Convert evidence to a safe project-relative path. Returns null for traversal
 * and for absolute paths outside the delegated workspace.
 */
export function projectRelativeEvidencePath(
  filePath: string,
  projectRoot?: string,
): string | null {
  const candidate = slash(filePath.trim());
  if (!candidate) return null;

  if (projectRoot) {
    const root = portableResolve(projectRoot).replace(/\/$/, "");
    if (isAbsolute(candidate)) {
      const absolute = portableResolve(candidate);
      const caseInsensitive = /^[a-z]:\//i.test(root);
      const comparableRoot = caseInsensitive ? root.toLowerCase() : root;
      const comparableAbsolute = caseInsensitive
        ? absolute.toLowerCase()
        : absolute;
      if (
        comparableAbsolute !== comparableRoot &&
        !comparableAbsolute.startsWith(`${comparableRoot}/`)
      ) {
        return null;
      }
      return absolute.slice(root.length).replace(/^\//, "") || null;
    }
  } else if (isAbsolute(candidate)) {
    // Without a trusted root there is no safe way to prove workspace scope.
    return null;
  }

  const relative = slash(path.posix.normalize(candidate)).replace(/^\.\//, "");
  if (!relative || relative === ".." || relative.startsWith("../")) return null;
  return relative;
}

function isTargetRelevant(file: string, targetPaths: string[]): boolean {
  if (targetPaths.length === 0) return true;
  const comparable = file.toLowerCase();
  return targetPaths.some((targetPath) => {
    const target = slash(targetPath)
      .replace(/^\.\//, "")
      .replace(/\/$/, "")
      .toLowerCase();
    return comparable === target || comparable.startsWith(`${target}/`);
  });
}

/**
 * Decide whether a terminal worker signal is actually acceptable.
 *
 * A worker's `done` event is necessary, but never sufficient for mutating code
 * work. Files are taken from a host-observed diff and checks must be recorded by
 * Orion's runners. This prevents a one-second success report (or a new orphan
 * HTML file outside the live entry point) from turning the task green.
 */
export function evaluateCodingTaskAcceptance(
  target: CodingTaskAcceptanceTarget,
  evidence: CodingTaskAcceptanceEvidence,
): CodingTaskAcceptanceDecision {
  const changedFiles = evidence.observedChangedFiles
    .map((file) => projectRelativeEvidencePath(file, target.projectRoot))
    .filter((file): file is string => file !== null);
  const relevantChangedFiles = [...new Set(changedFiles)].filter((file) =>
    isTargetRelevant(file, target.targetPaths),
  );

  const trustedChecks = evidence.checks.filter(
    (check) => check.source === "orion",
  );
  const failedChecks = [
    ...new Set(
      trustedChecks
        .filter((check) => check.status === "failed")
        .map((check) => check.check),
    ),
  ];
  const missingEvidence: string[] = [];

  if (!evidence.workerReportedSuccess)
    missingEvidence.push("worker completion");
  if (target.requireChangedFiles && relevantChangedFiles.length === 0) {
    missingEvidence.push(
      target.targetPaths.length > 0
        ? "a relevant workspace change"
        : "a workspace change",
    );
  }
  for (const required of target.requiredChecks) {
    const passed = trustedChecks.some(
      (check) => check.check === required && check.status === "passed",
    );
    if (!passed) missingEvidence.push(`${required} verification`);
  }

  const status =
    failedChecks.length > 0
      ? "failed"
      : missingEvidence.length > 0
        ? "pending-evidence"
        : "accepted";
  return {
    accepted: status === "accepted",
    status,
    relevantChangedFiles,
    missingEvidence,
    failedChecks,
  };
}
