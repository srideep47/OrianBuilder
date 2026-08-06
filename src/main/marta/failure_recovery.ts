export type FailureKind =
  | "permission"
  | "target"
  | "dependency"
  | "resource"
  | "process"
  | "verification"
  | "provider"
  | "cancelled"
  | "unknown";

export interface ClassifiedFailure {
  kind: FailureKind;
  retryable: boolean;
  publicSummary: string;
}

export type RecoveryDecision =
  | { action: "retry"; delayMs: number; reason: string }
  | { action: "replan"; reason: string }
  | { action: "ask-user"; reason: string }
  | { action: "fail"; reason: string };

/** Turn noisy worker errors into stable categories the executive can act on. */
export function classifyTaskFailure(message: string): ClassifiedFailure {
  const text = message.toLowerCase();
  if (/cancel(?:led|ed)|abort(?:ed)?/.test(text)) {
    return {
      kind: "cancelled",
      retryable: false,
      publicSummary: "The task was cancelled.",
    };
  }
  if (
    /permission|approval|denied|unauthori[sz]ed|sign[- ]?in|login/.test(text)
  ) {
    return {
      kind: "permission",
      retryable: false,
      publicSummary: "The task needs permission or account access.",
    };
  }
  if (
    /wrong (?:file|project|target)|entry ?point|outside (?:the )?project|orphan/.test(
      text,
    )
  ) {
    return {
      kind: "target",
      retryable: true,
      publicSummary: "The worker used the wrong project target.",
    };
  }
  if (
    /enoent|module not found|cannot find (?:module|package)|package\.json|dependency/.test(
      text,
    )
  ) {
    return {
      kind: "dependency",
      retryable: true,
      publicSummary: "A project dependency or required file is missing.",
    };
  }
  if (
    /out of memory|cuda|vram|allocation|resource busy|eaddrinuse|port .*in use/.test(
      text,
    )
  ) {
    return {
      kind: "resource",
      retryable: true,
      publicSummary:
        "The task could not acquire the required machine resources.",
    };
  }
  if (
    /timed? ?out|econn|connection|process (?:exited|failed)|spawn|crash/.test(
      text,
    )
  ) {
    return {
      kind: "process",
      retryable: true,
      publicSummary: "A worker process or connection failed.",
    };
  }
  if (
    /rate.?limit|429|503|provider|overloaded|service unavailable/.test(text)
  ) {
    return {
      kind: "provider",
      retryable: true,
      publicSummary: "The selected AI provider is temporarily unavailable.",
    };
  }
  if (
    /test failed|build failed|preview|verification|acceptance|no relevant files/.test(
      text,
    )
  ) {
    return {
      kind: "verification",
      retryable: true,
      publicSummary: "The produced result did not pass verification.",
    };
  }
  return {
    kind: "unknown",
    retryable: false,
    publicSummary: "The task failed for an unclassified reason.",
  };
}

export function chooseRecovery(input: {
  failure: ClassifiedFailure;
  attempt: number;
  maxAttempts: number;
  reversible: boolean;
}): RecoveryDecision {
  if (input.failure.kind === "permission") {
    return { action: "ask-user", reason: input.failure.publicSummary };
  }
  if (input.failure.kind === "cancelled") {
    return { action: "fail", reason: input.failure.publicSummary };
  }
  if (
    input.failure.kind === "target" ||
    input.failure.kind === "verification"
  ) {
    return input.attempt < input.maxAttempts && input.reversible
      ? { action: "replan", reason: input.failure.publicSummary }
      : { action: "fail", reason: input.failure.publicSummary };
  }
  if (
    input.failure.retryable &&
    input.reversible &&
    input.attempt < input.maxAttempts
  ) {
    return {
      action: "retry",
      delayMs: Math.min(30_000, 1_000 * 2 ** Math.max(0, input.attempt - 1)),
      reason: input.failure.publicSummary,
    };
  }
  return { action: "fail", reason: input.failure.publicSummary };
}
