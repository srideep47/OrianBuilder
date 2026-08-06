import { beforeEach, describe, expect, it } from "vitest";

import { ModelGate, type ResidentSlot } from "@/main/flow/model_gate";
import {
  MartaResidencyController,
  THRASH_COOLDOWN_MS,
  THRASH_THRESHOLD,
  THRASH_WINDOW_MS,
  _resetMartaResidencyForTests,
  whenMartaResidencyReady,
} from "./residency";

const BUDGET_MB = 16_384;
const MARTA_MB = 5_500;

const IMAGE: ResidentSlot = { kind: "image", modelId: "sdxl", vramMb: 4_096 };
const MUSIC: ResidentSlot = {
  kind: "music",
  modelId: "ace-step",
  vramMb: 12_288,
};

function companion(placement: "gpu" | "cpu" = "gpu") {
  return {
    modelId: "qwen3.5-4b",
    vramMb: MARTA_MB,
    preferredPlacement: "gpu" as const,
    placement,
  };
}

/** A controller on a clock the test drives by hand. */
function controllerAt(start = 1_000_000) {
  let now = start;
  const controller = new MartaResidencyController(() => now);
  return {
    controller,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

beforeEach(() => _resetMartaResidencyForTests());

describe("admission", () => {
  it("keeps her resident when the heavy model fits beside her", () => {
    const { controller } = controllerAt();
    expect(
      controller.admit({
        slot: IMAGE,
        resident: null,
        companion: companion(),
        budgetMb: BUDGET_MB,
      }),
    ).toMatchObject({ admit: true, demoteCompanion: false });
  });

  it("yields the card rather than refusing the work", () => {
    // The orchestrator protecting its own placement over the user's actual
    // request would be exactly the wrong instinct, so this is asserted, not
    // assumed.
    const { controller } = controllerAt();
    const decision = controller.admit({
      slot: MUSIC,
      resident: null,
      companion: companion(),
      budgetMb: BUDGET_MB,
    });
    expect(decision.admit).toBe(true);
    expect(decision.demoteCompanion).toBe(true);
    expect(decision.reason).toContain("ace-step");
  });

  it("never refuses, whatever is asked for", () => {
    const { controller } = controllerAt();
    for (const vramMb of [1, 4_096, 12_288, 64_000]) {
      const decision = controller.admit({
        slot: { kind: "video", modelId: "x", vramMb },
        resident: null,
        companion: companion(),
        budgetMb: BUDGET_MB,
      });
      expect(decision.admit).toBe(true);
    }
  });

  it("stays optimistic when the budget is unknown", () => {
    const { controller } = controllerAt();
    expect(
      controller.admit({
        slot: MUSIC,
        resident: null,
        companion: companion(),
        budgetMb: null,
      }).demoteCompanion,
    ).toBe(false);
  });

  it("has nothing to do when she is already on the CPU", () => {
    const { controller } = controllerAt();
    expect(
      controller.admit({
        slot: MUSIC,
        resident: null,
        companion: companion("cpu"),
        budgetMb: BUDGET_MB,
      }).demoteCompanion,
    ).toBe(false);
    // A CPU-placed companion is not a migration, so it must not count toward
    // the thrash latch.
    expect(controller.getStatus().recentDemotions).toBe(0);
  });
});

describe("thrash hysteresis", () => {
  function demoteOnce(controller: MartaResidencyController) {
    controller.admit({
      slot: MUSIC,
      resident: null,
      companion: companion(),
      budgetMb: BUDGET_MB,
    });
  }

  it("allows restores below the threshold", () => {
    const { controller } = controllerAt();
    for (let i = 0; i < THRASH_THRESHOLD - 1; i++) demoteOnce(controller);

    expect(controller.getStatus().thrashLatched).toBe(false);
    expect(
      controller.allowRestore({
        companion: companion("cpu"),
        resident: IMAGE,
        budgetMb: BUDGET_MB,
      }),
    ).toBe(true);
  });

  it("stops trying to reclaim the card once it starts thrashing", () => {
    const { controller } = controllerAt();
    for (let i = 0; i < THRASH_THRESHOLD; i++) demoteOnce(controller);

    expect(controller.getStatus().thrashLatched).toBe(true);
    expect(
      controller.allowRestore({
        companion: companion("cpu"),
        resident: IMAGE,
        budgetMb: BUDGET_MB,
      }),
    ).toBe(false);
  });

  it("still comes back the moment the card goes idle", () => {
    // The latch exists to avoid migrating mid-batch. An idle card means the
    // batch is over, so holding her off would just be slow for no reason.
    const { controller } = controllerAt();
    for (let i = 0; i < THRASH_THRESHOLD; i++) demoteOnce(controller);

    expect(
      controller.allowRestore({
        companion: companion("cpu"),
        resident: null,
        budgetMb: BUDGET_MB,
      }),
    ).toBe(true);
    // And going idle clears the history, so the next batch starts fresh.
    expect(controller.getStatus().thrashLatched).toBe(false);
    expect(controller.getStatus().recentDemotions).toBe(0);
  });

  it("releases the latch after the cooldown", () => {
    const { controller, advance } = controllerAt();
    for (let i = 0; i < THRASH_THRESHOLD; i++) demoteOnce(controller);
    expect(controller.getStatus().thrashLatched).toBe(true);

    advance(THRASH_COOLDOWN_MS + 1);
    expect(controller.getStatus().thrashLatched).toBe(false);
    expect(
      controller.allowRestore({
        companion: companion("cpu"),
        resident: IMAGE,
        budgetMb: BUDGET_MB,
      }),
    ).toBe(true);
  });

  it("does not latch on demotions spread out over time", () => {
    // Three migrations across an afternoon is normal use, not thrashing.
    const { controller, advance } = controllerAt();
    for (let i = 0; i < THRASH_THRESHOLD + 2; i++) {
      demoteOnce(controller);
      advance(THRASH_WINDOW_MS + 1);
    }
    expect(controller.getStatus().thrashLatched).toBe(false);
    expect(controller.getStatus().recentDemotions).toBe(0);
  });

  it("forgets demotions that fall out of the window", () => {
    const { controller, advance } = controllerAt();
    demoteOnce(controller);
    demoteOnce(controller);
    expect(controller.getStatus().recentDemotions).toBe(2);

    advance(THRASH_WINDOW_MS + 1);
    expect(controller.getStatus().recentDemotions).toBe(0);
  });
});

describe("driving a real gate", () => {
  it("keeps her on the CPU through an alternating batch, then brings her back", async () => {
    // The scenario the hysteresis exists for: image → music → image → music
    // would otherwise migrate her four times.
    const { controller } = controllerAt();
    const events: string[] = [];
    const gate = new ModelGate();
    gate.setVramBudgetMb(BUDGET_MB);
    gate.setResidencyPolicy(controller.policy());
    gate.setHooks({
      load: async (s) => void events.push(`load:${s.modelId}`),
      unload: async (s) => void events.push(`unload:${s.modelId}`),
    });
    gate.setCompanionHooks({
      load: async () => {},
      unload: async () => {},
      demote: async () => void events.push("demote"),
      restore: async () => void events.push("restore"),
    });

    await gate.enterCompanion({
      modelId: "qwen3.5-4b",
      vramMb: MARTA_MB,
      preferredPlacement: "gpu",
    });

    for (let round = 0; round < 3; round++) {
      await gate.enter(IMAGE);
      await gate.enter(MUSIC);
    }

    const migrations = events.filter(
      (e) => e === "demote" || e === "restore",
    ).length;
    // Without the latch this is six demotes and five restores. With it, she
    // gives up after the third demotion and stops bouncing.
    expect(migrations).toBeLessThan(8);
    expect(gate.getCompanion()?.placement).toBe("cpu");

    await gate.exit();
    expect(gate.getCompanion()?.placement).toBe("gpu");
  });

  it("leaves her alone across a batch she fits beside", async () => {
    const { controller } = controllerAt();
    const events: string[] = [];
    const gate = new ModelGate();
    gate.setVramBudgetMb(BUDGET_MB);
    gate.setResidencyPolicy(controller.policy());
    gate.setHooks({
      load: async () => {},
      unload: async () => {},
    });
    gate.setCompanionHooks({
      load: async () => {},
      unload: async () => {},
      demote: async () => void events.push("demote"),
      restore: async () => void events.push("restore"),
    });

    await gate.enterCompanion({
      modelId: "qwen3.5-4b",
      vramMb: MARTA_MB,
      preferredPlacement: "gpu",
    });
    for (let i = 0; i < 10; i++) await gate.enter(IMAGE);

    expect(events).toEqual([]);
    expect(gate.getCompanion()?.placement).toBe("gpu");
  });
});

describe("startup readiness", () => {
  it("resolves immediately when init was never started", async () => {
    // A caller must not be able to deadlock on a subsystem that is switched
    // off. This is why `whenMartaResidencyReady` does not itself trigger init.
    await expect(whenMartaResidencyReady()).resolves.toBeUndefined();
  });
});
