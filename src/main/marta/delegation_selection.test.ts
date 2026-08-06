import { describe, expect, it } from "vitest";
import type { LocalModel } from "@/ipc/types";

import { inferDelegationSelectionFromUtterance } from "./delegation_selection";

const LOCAL_MODELS: LocalModel[] = [
  {
    provider: "marta",
    modelName: "unsloth/Qwen3.5-4B-GGUF",
    displayName: "Qwen3.5 4B companion",
  },
  {
    provider: "lmstudio",
    modelName: "qwen3.6-35b-a3b",
    displayName: "Qwen 3.6 35B A3B",
  },
];

describe("initial coding-worker selection", () => {
  it("extracts Claude, model, and effort from the original work request", () => {
    expect(
      inferDelegationSelectionFromUtterance(
        "Build a small website with Claude Haiku, low effort",
      ),
    ).toEqual({
      worker: "claude",
      model: "claude-haiku-4-5",
      effort: "low",
      remember: undefined,
    });
  });

  it("carries an explicit default preference in the same utterance", () => {
    expect(
      inferDelegationSelectionFromUtterance(
        "Always use Claude Haiku with medium effort from now on",
      ),
    ).toEqual({
      worker: "claude",
      model: "claude-haiku-4-5",
      effort: "medium",
      remember: true,
    });
  });

  it("supports Claude's account-default model when it is named explicitly", () => {
    expect(
      inferDelegationSelectionFromUtterance(
        "Use Claude's default model with low effort for this task",
      ),
    ).toEqual({
      worker: "claude",
      effort: "low",
      remember: undefined,
    });
  });

  it("resolves an installed local model by natural name", () => {
    expect(
      inferDelegationSelectionFromUtterance(
        "Use the local Qwen 3.6 35B model",
        LOCAL_MODELS,
      ),
    ).toEqual({
      worker: "local",
      model: "lmstudio:qwen3.6-35b-a3b",
      remember: undefined,
    });
  });

  it("does not guess from an incomplete or contradictory choice", () => {
    expect(
      inferDelegationSelectionFromUtterance("Use Claude for this"),
    ).toBeUndefined();
    expect(
      inferDelegationSelectionFromUtterance(
        "Use local Claude Haiku with low effort",
        LOCAL_MODELS,
      ),
    ).toBeUndefined();
  });
});
