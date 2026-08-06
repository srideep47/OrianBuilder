import { describe, expect, it } from "vitest";

import { chooseRecovery, classifyTaskFailure } from "./failure_recovery";

describe("failure recovery", () => {
  it("classifies actionable failures without exposing noisy internals", () => {
    expect(classifyTaskFailure("ENOENT package.json")).toMatchObject({
      kind: "dependency",
      retryable: true,
    });
    expect(classifyTaskFailure("CUDA out of memory").kind).toBe("resource");
    expect(classifyTaskFailure("wrong entry point; orphan file").kind).toBe(
      "target",
    );
    expect(classifyTaskFailure("login denied").kind).toBe("permission");
  });

  it("retries transient reversible work with a bounded backoff", () => {
    expect(
      chooseRecovery({
        failure: classifyTaskFailure("provider returned 503"),
        attempt: 2,
        maxAttempts: 3,
        reversible: true,
      }),
    ).toEqual({
      action: "retry",
      delayMs: 2_000,
      reason: "The selected AI provider is temporarily unavailable.",
    });
  });

  it("replans wrong-target output and never retries a permission decision", () => {
    expect(
      chooseRecovery({
        failure: classifyTaskFailure("wrong project target"),
        attempt: 1,
        maxAttempts: 2,
        reversible: true,
      }).action,
    ).toBe("replan");
    expect(
      chooseRecovery({
        failure: classifyTaskFailure("permission denied"),
        attempt: 1,
        maxAttempts: 9,
        reversible: true,
      }).action,
    ).toBe("ask-user");
  });
});
