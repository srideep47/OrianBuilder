/**
 * The companion tier: Marta's exclusion from the single-resident rule.
 *
 * Numbers here are the real ones from the target machine — a 16 GB RTX 4080
 * SUPER — because the whole design turns on whether specific models fit
 * together, and abstract sizes would let a wrong constant pass.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AdmissionRefusedError,
  COMPANION_HEADROOM_MB,
  DEFAULT_RESIDENCY_POLICY,
  ModelGate,
  fitsAlongsideCompanion,
  _resetModelGateForTests,
  type CompanionHooks,
  type CompanionSlot,
  type ModelGateHooks,
  type ResidentSlot,
} from "./model_gate";

/** 16 GB, the card the design is tuned for. */
const BUDGET_MB = 16_384;

/** Qwen3.5-4B at 4-bit with a working KV cache. */
const MARTA_MB = 5_500;

/** A tier that fits beside her: 5,500 + 4,096 + 768 = 10,364 of 16,384. */
const IMAGE: ResidentSlot = { kind: "image", modelId: "sdxl", vramMb: 4_096 };

/** ACE-Step. 5,500 + 12,288 + 768 = 18,556 — over budget, so she must yield. */
const MUSIC: ResidentSlot = {
  kind: "music",
  modelId: "ace-step",
  vramMb: 12_288,
};

/** LTX-Video. 5,500 + 9,000 + 768 = 15,268 — tight, but it fits beside her. */
const VIDEO: ResidentSlot = { kind: "video", modelId: "ltx", vramMb: 9_000 };

function marta(vramMb = MARTA_MB) {
  return {
    modelId: "qwen3.5-4b",
    vramMb,
    preferredPlacement: "gpu" as const,
  };
}

interface Recorder {
  hooks: ModelGateHooks;
  companionHooks: CompanionHooks;
  events: string[];
}

function recordingHooks(
  overrides: {
    exclusive?: Partial<ModelGateHooks>;
    companion?: Partial<CompanionHooks> | null;
  } = {},
): Recorder {
  const events: string[] = [];
  return {
    events,
    hooks: {
      load: async (s) => void events.push(`load:${s.kind}:${s.modelId}`),
      unload: async (s) => void events.push(`unload:${s.kind}:${s.modelId}`),
      ...overrides.exclusive,
    },
    companionHooks: {
      load: async (s: CompanionSlot) =>
        void events.push(`companion-load:${s.modelId}@${s.placement}`),
      unload: async (s: CompanionSlot) =>
        void events.push(`companion-unload:${s.modelId}`),
      demote: async (s: CompanionSlot) =>
        void events.push(`demote:${s.modelId}`),
      restore: async (s: CompanionSlot) =>
        void events.push(`restore:${s.modelId}`),
      ...overrides.companion,
    },
  };
}

function gateWithMarta(overrides?: {
  exclusive?: Partial<ModelGateHooks>;
  companion?: Partial<CompanionHooks>;
}) {
  const gate = new ModelGate();
  const recorder = recordingHooks(overrides);
  gate.setHooks(recorder.hooks);
  gate.setCompanionHooks(recorder.companionHooks);
  gate.setVramBudgetMb(BUDGET_MB);
  return { gate, ...recorder };
}

beforeEach(() => _resetModelGateForTests());

describe("fitsAlongsideCompanion", () => {
  const companion: CompanionSlot = { ...marta(), placement: "gpu" };

  it("leaves headroom rather than filling the card exactly", () => {
    const exact: ResidentSlot = {
      kind: "image",
      modelId: "x",
      vramMb: BUDGET_MB - MARTA_MB,
    };
    expect(fitsAlongsideCompanion(exact, companion, BUDGET_MB)).toBe(false);

    const withHeadroom: ResidentSlot = {
      ...exact,
      vramMb: BUDGET_MB - MARTA_MB - COMPANION_HEADROOM_MB,
    };
    expect(fitsAlongsideCompanion(withHeadroom, companion, BUDGET_MB)).toBe(
      true,
    );
  });

  it("matches the real cases the design was drawn for", () => {
    // Only ACE-Step is actually big enough to cost her the card on 16GB.
    // Getting this wrong in the pessimistic direction would put her on the CPU
    // for ordinary image and video work, which is most of what users do.
    expect(fitsAlongsideCompanion(IMAGE, companion, BUDGET_MB)).toBe(true);
    expect(fitsAlongsideCompanion(VIDEO, companion, BUDGET_MB)).toBe(true);
    expect(fitsAlongsideCompanion(MUSIC, companion, BUDGET_MB)).toBe(false);
  });

  it("would cost her the card if she were the 9B rung instead of the 4B", () => {
    // Why the ladder caps at 4B on a 16GB card: 6,500 + 9,000 + 768 = 16,268
    // still fits, but the margin is gone and video becomes a coin flip.
    const nineB: CompanionSlot = { ...marta(6_500), placement: "gpu" };
    expect(fitsAlongsideCompanion(VIDEO, nineB, BUDGET_MB)).toBe(true);
    expect(
      fitsAlongsideCompanion({ ...VIDEO, vramMb: 9_200 }, nineB, BUDGET_MB),
    ).toBe(false);
  });
});

describe("companion residency", () => {
  it("starts on the GPU and is not the exclusive resident", async () => {
    const { gate, events } = gateWithMarta();
    await gate.enterCompanion(marta());

    expect(events).toEqual(["companion-load:qwen3.5-4b@gpu"]);
    expect(gate.getCompanion()?.placement).toBe("gpu");
    // The distinction the whole tier exists for: she holds VRAM but does not
    // hold the exclusive slot, so nothing sees her as the resident model.
    expect(gate.getResident()).toBeNull();
  });

  it("survives a heavy model that fits beside her", async () => {
    const { gate, events } = gateWithMarta();
    await gate.enterCompanion(marta());
    await gate.enter(IMAGE);

    expect(events).toEqual([
      "companion-load:qwen3.5-4b@gpu",
      "load:image:sdxl",
    ]);
    expect(gate.getCompanion()?.placement).toBe("gpu");
    expect(gate.getResident()?.modelId).toBe("sdxl");
  });

  it("is demoted, not unloaded, when a model needs the whole card", async () => {
    const { gate, events } = gateWithMarta();
    await gate.enterCompanion(marta());
    await gate.enter(MUSIC);

    expect(events).toEqual([
      "companion-load:qwen3.5-4b@gpu",
      "demote:qwen3.5-4b",
      "load:music:ace-step",
    ]);
    // Demoted, so she is still running and still has her conversation.
    expect(events).not.toContain("companion-unload:qwen3.5-4b");
    expect(gate.getCompanion()?.placement).toBe("cpu");
  });

  it("comes back to the GPU when the card goes idle", async () => {
    const { gate, events } = gateWithMarta();
    await gate.enterCompanion(marta());
    await gate.enter(MUSIC);
    await gate.exit();

    expect(events).toEqual([
      "companion-load:qwen3.5-4b@gpu",
      "demote:qwen3.5-4b",
      "load:music:ace-step",
      "unload:music:ace-step",
      "restore:qwen3.5-4b",
    ]);
    expect(gate.getCompanion()?.placement).toBe("gpu");
  });

  it("comes back when a big model is replaced by one she fits beside", async () => {
    const { gate, events } = gateWithMarta();
    await gate.enterCompanion(marta());
    await gate.enter(MUSIC);
    await gate.enter(IMAGE);

    expect(events.slice(-3)).toEqual([
      "unload:music:ace-step",
      "load:image:sdxl",
      "restore:qwen3.5-4b",
    ]);
    expect(gate.getCompanion()?.placement).toBe("gpu");
  });

  it("stays on the CPU when the caller asked for CPU", async () => {
    const { gate, events } = gateWithMarta();
    await gate.enterCompanion({ ...marta(), preferredPlacement: "cpu" });
    await gate.enter(IMAGE);
    await gate.exit();

    // An explicit preference is not the gate's to override, so no restore.
    expect(events).not.toContain("restore:qwen3.5-4b");
    expect(gate.getCompanion()?.placement).toBe("cpu");
  });

  it("does not demote a companion that is already on the CPU", async () => {
    const { gate, events } = gateWithMarta();
    await gate.enterCompanion({ ...marta(), preferredPlacement: "cpu" });
    await gate.enter(MUSIC);

    expect(events).not.toContain("demote:qwen3.5-4b");
  });

  it("starts on the CPU when the card is already full", async () => {
    const { gate, events } = gateWithMarta();
    await gate.enter(MUSIC);
    await gate.enterCompanion(marta());

    // Starting on the GPU and immediately demoting would cost two migrations.
    expect(events).toEqual([
      "load:music:ace-step",
      "companion-load:qwen3.5-4b@cpu",
    ]);
    expect(gate.getCompanion()?.placement).toBe("cpu");
  });

  it("keeps her out of the exclusive tier's swap accounting", async () => {
    const { gate } = gateWithMarta();
    await gate.enterCompanion(marta());
    await gate.enter(MUSIC);

    const kinds = gate.drainSwapTelemetry().map((e) => e.kind);
    // A migration is recorded as `demote`, not as an unload/load pair, so swap
    // telemetry does not read as though the orchestrator thrashed.
    expect(kinds).toEqual(["load", "demote", "load"]);
  });

  it("replaces the companion when the ladder rung changes", async () => {
    const { gate, events } = gateWithMarta();
    await gate.enterCompanion(marta());
    await gate.enterCompanion({
      modelId: "qwen3.5-0.8b",
      vramMb: 3_000,
      preferredPlacement: "gpu",
    });

    expect(events).toEqual([
      "companion-load:qwen3.5-4b@gpu",
      "companion-unload:qwen3.5-4b",
      "companion-load:qwen3.5-0.8b@gpu",
    ]);
  });

  it("is a no-op when re-entering the same companion", async () => {
    const { gate, events } = gateWithMarta();
    await gate.enterCompanion(marta());
    await gate.enterCompanion(marta());
    await gate.enterCompanion(marta());

    expect(events).toEqual(["companion-load:qwen3.5-4b@gpu"]);
  });

  it("exitCompanion stops her without touching the exclusive slot", async () => {
    const { gate } = gateWithMarta();
    await gate.enterCompanion(marta());
    await gate.enter(IMAGE);
    await gate.exitCompanion();

    expect(gate.getCompanion()).toBeNull();
    expect(gate.getResident()?.modelId).toBe("sdxl");
  });
});

describe("placement as a user preference", () => {
  it("moves her to the CPU when the preference flips", async () => {
    const { gate, events } = gateWithMarta();
    await gate.enterCompanion(marta());
    await gate.enterCompanion({ ...marta(), preferredPlacement: "cpu" });

    expect(events).toEqual([
      "companion-load:qwen3.5-4b@gpu",
      "demote:qwen3.5-4b",
    ]);
    expect(gate.getCompanion()?.placement).toBe("cpu");
  });

  it("keeps her there even when the card is idle", async () => {
    // A user-initiated move is not the gate's to undo. Reconciling it away on
    // the next idle would make "get off my GPU" silently temporary.
    const { gate, events } = gateWithMarta();
    await gate.enterCompanion(marta());
    await gate.enterCompanion({ ...marta(), preferredPlacement: "cpu" });
    await gate.enter(IMAGE);
    await gate.exit();

    expect(events).not.toContain("restore:qwen3.5-4b");
    expect(gate.getCompanion()?.placement).toBe("cpu");
  });

  it("hands the decision back when the preference flips to gpu", async () => {
    const { gate } = gateWithMarta();
    await gate.enterCompanion({ ...marta(), preferredPlacement: "cpu" });
    await gate.enterCompanion({ ...marta(), preferredPlacement: "gpu" });
    expect(gate.getCompanion()?.placement).toBe("gpu");
  });
});

describe("unknown VRAM budget", () => {
  it("keeps her resident rather than demoting on every generation", async () => {
    const { gate, events } = gateWithMarta();
    gate.setVramBudgetMb(null);
    await gate.enterCompanion(marta());
    await gate.enter(MUSIC);

    expect(events).not.toContain("demote:qwen3.5-4b");
  });

  it("demotes and retries once when the optimistic load fails", async () => {
    // This is what makes an unknown budget safe: guessing wrong costs a retry
    // rather than a failed generation.
    const events: string[] = [];
    let attempts = 0;
    const gate = new ModelGate();
    gate.setVramBudgetMb(null);
    gate.setHooks({
      load: async (s) => {
        attempts += 1;
        events.push(`load-attempt-${attempts}:${s.modelId}`);
        if (attempts === 1) throw new Error("CUDA out of memory");
      },
      unload: async (s) => void events.push(`unload:${s.modelId}`),
    });
    gate.setCompanionHooks({
      load: async (s) =>
        void events.push(`companion-load:${s.modelId}@${s.placement}`),
      unload: async (s) => void events.push(`companion-unload:${s.modelId}`),
      demote: async (s) => void events.push(`demote:${s.modelId}`),
      restore: async (s) => void events.push(`restore:${s.modelId}`),
    });

    await gate.enterCompanion(marta());
    await gate.enter(MUSIC);

    expect(events).toEqual([
      "companion-load:qwen3.5-4b@gpu",
      "load-attempt-1:ace-step",
      "demote:qwen3.5-4b",
      "load-attempt-2:ace-step",
    ]);
    expect(gate.getResident()?.modelId).toBe("ace-step");
    expect(gate.getCompanion()?.placement).toBe("cpu");
  });

  it("gives up after one retry rather than looping", async () => {
    const gate = new ModelGate();
    gate.setVramBudgetMb(null);
    gate.setHooks({
      load: async () => {
        throw new Error("CUDA out of memory");
      },
      unload: async () => {},
    });
    gate.setCompanionHooks({
      load: async () => {},
      unload: async () => {},
      demote: async () => {},
    });

    await gate.enterCompanion(marta());
    await expect(gate.enter(MUSIC)).rejects.toThrow("CUDA out of memory");
    expect(gate.getResident()).toBeNull();
  });
});

describe("missing hooks", () => {
  it("falls back to unloading her when there is no migration path", async () => {
    const events: string[] = [];
    const gate = new ModelGate();
    gate.setVramBudgetMb(BUDGET_MB);
    gate.setHooks({
      load: async (s) => void events.push(`load:${s.modelId}`),
      unload: async (s) => void events.push(`unload:${s.modelId}`),
    });
    gate.setCompanionHooks({
      load: async (s) => void events.push(`companion-load:${s.modelId}`),
      unload: async (s) => void events.push(`companion-unload:${s.modelId}`),
      // No `demote`.
    });

    await gate.enterCompanion(marta());
    await gate.enter(MUSIC);

    expect(events).toContain("companion-unload:qwen3.5-4b");
    expect(gate.getCompanion()?.placement).toBe("cpu");
  });

  it("degrades to bookkeeping with no hooks at all", async () => {
    const gate = new ModelGate();
    gate.setVramBudgetMb(BUDGET_MB);
    await gate.enterCompanion(marta());
    expect(gate.getCompanion()?.placement).toBe("gpu");
    await gate.enter(MUSIC);
    expect(gate.getCompanion()?.placement).toBe("cpu");
    await gate.exit();
    expect(gate.getCompanion()?.placement).toBe("gpu");
  });
});

describe("residency policy", () => {
  it("uses the default policy until one is installed", async () => {
    const { gate } = gateWithMarta();
    const admit = vi.spyOn(DEFAULT_RESIDENCY_POLICY, "admit");
    await gate.enter(IMAGE);
    expect(admit).toHaveBeenCalled();
    admit.mockRestore();
  });

  it("lets the policy refuse a slot outright", async () => {
    const { gate } = gateWithMarta();
    gate.setResidencyPolicy({
      admit: () => ({
        admit: false,
        demoteCompanion: false,
        reason: "the user asked me to keep the GPU free",
      }),
    });

    await expect(gate.enter(MUSIC)).rejects.toBeInstanceOf(
      AdmissionRefusedError,
    );
    expect(gate.getResident()).toBeNull();
  });

  it("does not unload the current model when a request is refused", async () => {
    // Refusing must be inert. Evicting what was already loaded would make a
    // policy that says "no" strictly worse than one that says nothing.
    const { gate, events } = gateWithMarta();
    await gate.enter(IMAGE);
    gate.setResidencyPolicy({
      admit: () => ({ admit: false, demoteCompanion: false, reason: "busy" }),
    });

    await expect(gate.enter(MUSIC)).rejects.toBeInstanceOf(
      AdmissionRefusedError,
    );
    expect(gate.getResident()?.modelId).toBe("sdxl");
    expect(events).not.toContain("unload:image:sdxl");
  });

  it("lets the policy hold off a restore", async () => {
    const { gate, events } = gateWithMarta();
    gate.setResidencyPolicy({
      admit: DEFAULT_RESIDENCY_POLICY.admit,
      allowRestore: () => false,
    });
    await gate.enterCompanion(marta());
    await gate.enter(MUSIC);
    await gate.exit();

    expect(events).not.toContain("restore:qwen3.5-4b");
    expect(gate.getCompanion()?.placement).toBe("cpu");
  });

  it("setResidencyPolicy(null) restores the default", async () => {
    const { gate } = gateWithMarta();
    gate.setResidencyPolicy({
      admit: () => ({ admit: false, demoteCompanion: false, reason: "no" }),
    });
    gate.setResidencyPolicy(null);
    await expect(gate.enter(IMAGE)).resolves.toBeUndefined();
  });

  it("sees the companion by value, so a policy cannot mutate gate state", async () => {
    const { gate } = gateWithMarta();
    await gate.enterCompanion(marta());
    gate.setResidencyPolicy({
      admit: (request) => {
        if (request.companion) request.companion.placement = "cpu";
        return { admit: true, demoteCompanion: false };
      },
    });
    await gate.enter(IMAGE);
    expect(gate.getCompanion()?.placement).toBe("gpu");
  });
});

describe("the two tiers are wired independently", () => {
  it("setHooks does not clobber the companion hooks", async () => {
    // The bug this split fixes: `configureModelGateHooks()` in
    // pipeline_wiring.ts calls setHooks with a fresh object, and it runs at an
    // unpredictable point relative to Marta's runtime coming up. With one
    // setter, whichever ran second silently erased the other's hooks — and the
    // symptom would have been Marta being unloaded instead of demoted, which
    // looks like her forgetting the conversation for no reason.
    const events: string[] = [];
    const gate = new ModelGate();
    gate.setVramBudgetMb(BUDGET_MB);
    gate.setCompanionHooks({
      load: async () => void events.push("companion-load"),
      unload: async () => void events.push("companion-unload"),
      demote: async () => void events.push("demote"),
    });
    await gate.enterCompanion(marta());

    gate.setHooks({
      load: async (s) => void events.push(`load:${s.modelId}`),
      unload: async () => {},
    });
    await gate.enter(MUSIC);

    expect(events).toEqual(["companion-load", "demote", "load:ace-step"]);
  });

  it("setCompanionHooks does not clobber the exclusive hooks", async () => {
    const events: string[] = [];
    const gate = new ModelGate();
    gate.setVramBudgetMb(BUDGET_MB);
    gate.setHooks({
      load: async (s) => void events.push(`load:${s.modelId}`),
      unload: async () => {},
    });
    gate.setCompanionHooks({
      load: async () => void events.push("companion-load"),
      unload: async () => {},
      demote: async () => void events.push("demote"),
    });

    await gate.enter(IMAGE);
    expect(events).toEqual(["load:sdxl"]);
  });

  it("setCompanionHooks(null) leaves the exclusive tier working", async () => {
    const events: string[] = [];
    const gate = new ModelGate();
    gate.setHooks({
      load: async (s) => void events.push(`load:${s.modelId}`),
      unload: async () => {},
    });
    gate.setCompanionHooks(null);
    await gate.enter(IMAGE);
    expect(events).toEqual(["load:sdxl"]);
  });
});

describe("serialisation across both tiers", () => {
  it("does not interleave a companion migration with an exclusive load", async () => {
    const events: string[] = [];
    const gate = new ModelGate();
    gate.setVramBudgetMb(BUDGET_MB);
    gate.setHooks({
      load: async (s) => {
        events.push(`load-start:${s.modelId}`);
        await new Promise((r) => setTimeout(r, 10));
        events.push(`load-end:${s.modelId}`);
      },
      unload: async () => {},
    });
    gate.setCompanionHooks({
      load: async (s) => {
        events.push(`companion-start:${s.modelId}`);
        await new Promise((r) => setTimeout(r, 5));
        events.push(`companion-end:${s.modelId}`);
      },
      unload: async () => {},
      demote: async () => {},
    });

    await Promise.all([gate.enter(IMAGE), gate.enterCompanion(marta())]);

    // Every operation completes before the next begins — a demote racing a
    // load is the exact bug the single queue exists to prevent.
    expect(events).toEqual([
      "load-start:sdxl",
      "load-end:sdxl",
      "companion-start:qwen3.5-4b",
      "companion-end:qwen3.5-4b",
    ]);
  });

  it("reserves an externally-owned big model without double-loading it", async () => {
    const { gate, events } = gateWithMarta();
    const brain: ResidentSlot = {
      kind: "llm",
      modelId: "qwen3.6-35b-a3b",
      vramMb: 24_000,
    };

    await gate.enterCompanion(marta());
    const answer = await gate.withExternal(brain, async () => {
      expect(gate.getResident()).toEqual(brain);
      expect(gate.getCompanion()?.placement).toBe("cpu");
      events.push("external-work");
      return "done";
    });

    expect(answer).toBe("done");
    expect(events).toEqual([
      "companion-load:qwen3.5-4b@gpu",
      "demote:qwen3.5-4b",
      "external-work",
      "restore:qwen3.5-4b",
    ]);
    expect(events.some((event) => event.startsWith("load:llm:"))).toBe(false);
    expect(events.some((event) => event.startsWith("unload:llm:"))).toBe(false);
    expect(gate.getResident()).toBeNull();
    expect(gate.getCompanion()?.placement).toBe("gpu");
  });

  it("restores Marta when externally-owned work fails", async () => {
    const { gate } = gateWithMarta();
    const brain: ResidentSlot = {
      kind: "llm",
      modelId: "qwen3.6-35b-a3b",
      vramMb: 24_000,
    };

    await gate.enterCompanion(marta());
    await expect(
      gate.withExternal(brain, async () => {
        throw new Error("brain failed");
      }),
    ).rejects.toThrow("brain failed");

    expect(gate.getResident()).toBeNull();
    expect(gate.getCompanion()?.placement).toBe("gpu");
  });
});
