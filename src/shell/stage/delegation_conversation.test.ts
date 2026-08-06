import { describe, expect, it } from "vitest";
import type { LocalModel } from "@/ipc/types";

import {
  describeDelegationOptions,
  resolveDelegationReply,
} from "./delegation_conversation";

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

describe("conversational coding delegation", () => {
  it("describes the installed and Claude options only when asked", () => {
    const result = resolveDelegationReply("What are my options?", LOCAL_MODELS);

    expect(result.kind).toBe("reply");
    if (result.kind !== "reply") return;
    expect(result.response).toContain("Qwen3.5 4B companion");
    expect(result.response).toContain("Claude Haiku 4.5");
    expect(result.response).toContain("effort");
  });

  it("selects an installed local model from a natural spoken phrase", () => {
    expect(
      resolveDelegationReply("Use local Qwen 4B for this", LOCAL_MODELS),
    ).toEqual({
      kind: "select",
      selection: {
        worker: "local",
        model: "marta:unsloth/Qwen3.5-4B-GGUF",
        remember: undefined,
      },
    });
  });

  it("accepts Claude model, effort, and persistence in one reply", () => {
    expect(
      resolveDelegationReply(
        "Always use Claude Haiku with low effort",
        LOCAL_MODELS,
      ),
    ).toEqual({
      kind: "select",
      selection: {
        worker: "claude",
        model: "claude-haiku-4-5",
        effort: "low",
        remember: true,
      },
    });
  });

  it("supports a multi-turn Claude choice", () => {
    const worker = resolveDelegationReply("Claude", LOCAL_MODELS);
    expect(worker.kind).toBe("reply");
    if (worker.kind !== "reply") return;
    expect(worker.context.worker).toBe("claude");

    const model = resolveDelegationReply("Haiku", LOCAL_MODELS, worker.context);
    expect(model.kind).toBe("reply");
    if (model.kind !== "reply") return;
    expect(model.context.model).toBe("claude-haiku-4-5");

    expect(
      resolveDelegationReply("low effort", LOCAL_MODELS, model.context),
    ).toEqual({
      kind: "select",
      selection: {
        worker: "claude",
        model: "claude-haiku-4-5",
        effort: "low",
        remember: undefined,
      },
    });
  });

  it("keeps waiting when a local worker has multiple models", () => {
    const result = resolveDelegationReply("Use local", LOCAL_MODELS);
    expect(result.kind).toBe("reply");
    if (result.kind !== "reply") return;
    expect(result.context.worker).toBe("local");
    expect(result.response).toContain("Qwen3.5 4B companion");

    expect(
      resolveDelegationReply("the 35B model", LOCAL_MODELS, result.context),
    ).toEqual({
      kind: "select",
      selection: {
        worker: "local",
        model: "lmstudio:qwen3.6-35b-a3b",
        remember: undefined,
      },
    });
  });

  it("can cancel without starting a worker", () => {
    expect(resolveDelegationReply("Never mind", LOCAL_MODELS)).toEqual({
      kind: "cancel",
      response: "Okay. I won't start that coding task.",
    });
  });

  it("explains when local inference is unavailable", () => {
    expect(describeDelegationOptions([])).toContain(
      "No local coding model is available",
    );
  });
});
