import { describe, expect, it } from "vitest";

import type { GpuInfo, HardwareProfile } from "@/main/hardware/types";
import { MartaTierIdSchema } from "@/ipc/types/marta";
import {
  MARTA_CPU_TIER,
  MARTA_TIERS,
  findMartaTier,
  planMartaPlacement,
  type MartaTierId,
} from "./model_ladder";

function gpu(overrides: Partial<GpuInfo> = {}): GpuInfo {
  return {
    vendor: "nvidia",
    model: "RTX 4080 SUPER",
    vramMb: 16_384,
    isIntegrated: false,
    ...overrides,
  };
}

function profile(primaryGpu: GpuInfo | null): HardwareProfile {
  return {
    os: "windows",
    arch: "x64",
    cpu: {
      vendor: "amd",
      model: "Ryzen 9 9950X",
      cores: 16,
      logicalCores: 32,
    },
    gpus: primaryGpu ? [primaryGpu] : [],
    primaryGpu,
    totalRamMb: 63_000,
    availableBackends: primaryGpu ? ["cuda", "cpu"] : ["cpu"],
    bestLlmBackend: primaryGpu ? "cuda" : "cpu",
    bestMediaBackend: primaryGpu ? "cuda" : "cpu",
  };
}

describe("planMartaPlacement", () => {
  it("picks 4B on the 16GB target machine", () => {
    const plan = planMartaPlacement(profile(gpu()));
    expect(plan.tier.id).toBe("4b");
    expect(plan.placement).toBe("gpu");
    expect(plan.rationale).toContain("16GB");
  });

  it("steps down to 2B on an 8GB card", () => {
    const plan = planMartaPlacement(profile(gpu({ vramMb: 8_192 })));
    expect(plan.tier.id).toBe("2b");
    expect(plan.placement).toBe("gpu");
  });

  it("steps down to 0.8B on a 4GB card", () => {
    const plan = planMartaPlacement(profile(gpu({ vramMb: 4_096 })));
    expect(plan.tier.id).toBe("0.8b");
  });

  it("falls to CPU below the smallest rung", () => {
    const plan = planMartaPlacement(profile(gpu({ vramMb: 2_048 })));
    expect(plan.tier).toBe(MARTA_CPU_TIER);
    expect(plan.placement).toBe("cpu");
    expect(plan.rationale).toContain("too little");
  });

  it("reaches the omni rung only on a very large card", () => {
    // Unreachable in practice today, but the ladder must already be shaped for
    // it so a speech-native model is a config change and not a refactor.
    expect(planMartaPlacement(profile(gpu({ vramMb: 24_576 }))).tier.id).toBe(
      "4b",
    );
    expect(planMartaPlacement(profile(gpu({ vramMb: 49_152 }))).tier.id).toBe(
      "omni",
    );
  });

  it("runs on CPU when there is no discrete GPU", () => {
    const plan = planMartaPlacement(profile(null));
    expect(plan.placement).toBe("cpu");
    expect(plan.rationale).toContain("No discrete GPU");
  });

  it("runs on CPU on an integrated GPU regardless of its reported VRAM", () => {
    // Integrated "VRAM" is carved out of system RAM, so a large reported figure
    // is not headroom — putting a resident model there starves everything else.
    const plan = planMartaPlacement(
      profile(
        gpu({ isIntegrated: true, model: "Radeon Graphics", vramMb: 16_384 }),
      ),
    );
    expect(plan.placement).toBe("cpu");
    expect(plan.rationale).toContain("Integrated");
  });

  it("honours a ceiling that caps the tier below the hardware", () => {
    const plan = planMartaPlacement(profile(gpu()), { ceiling: "2b" });
    expect(plan.tier.id).toBe("2b");
  });

  it("never lets a ceiling raise the tier above the hardware", () => {
    const plan = planMartaPlacement(profile(gpu({ vramMb: 4_096 })), {
      ceiling: "omni",
    });
    expect(plan.tier.id).toBe("0.8b");
  });
});

describe("the ladder itself", () => {
  it("is ordered most to least capable", () => {
    const mins = MARTA_TIERS.map((t) => t.minVramMb);
    expect([...mins].sort((a, b) => b - a)).toEqual(mins);
  });

  it("never lists a tier that cannot fit in its own minimum", () => {
    for (const tier of MARTA_TIERS) {
      expect(tier.vramMb).toBeLessThan(tier.minVramMb);
    }
  });

  it("gives the CPU tier a zero VRAM cost", () => {
    // Load-bearing: it is what stops the gate demoting a CPU-placed Marta for
    // a heavy model she was never competing with.
    expect(MARTA_CPU_TIER.vramMb).toBe(0);
  });

  it("marks only the omni rung as speech-native", () => {
    // The Qwen3.5 small models are text+vision. Anything reading this flag to
    // decide whether to run the cascaded voice bus depends on it being honest.
    const speechNative = MARTA_TIERS.filter((t) => t.speechNative);
    expect(speechNative.map((t) => t.id)).toEqual(["omni"]);
    expect(MARTA_CPU_TIER.speechNative).toBe(false);
  });

  it("resolves every tier id, including the CPU fallback", () => {
    for (const tier of MARTA_TIERS) {
      expect(findMartaTier(tier.id)).toBe(tier);
    }
    expect(findMartaTier("cpu-only")).toBe(MARTA_CPU_TIER);
  });

  it("agrees with the IPC contract's tier enum", () => {
    // `MartaTierId` is declared twice — once as a TS union here (main process,
    // no Zod dependency wanted) and once as a Zod enum in `ipc/types/marta.ts`
    // (needed for runtime validation at the boundary). Nothing in the type
    // system connects them, so adding a rung to one and not the other would
    // compile fine and then fail Zod validation at runtime, in a handler, on
    // the user's machine. This is the guard.
    const fromLadder = [...MARTA_TIERS.map((t) => t.id), MARTA_CPU_TIER.id];
    expect([...fromLadder].sort()).toEqual(
      [...MartaTierIdSchema.options].sort(),
    );

    // And the contract's enum must be assignable to the ladder's union, which
    // catches a rename in either direction.
    const roundTrip: MartaTierId[] = [...MartaTierIdSchema.options];
    expect(roundTrip).toHaveLength(fromLadder.length);
  });
});
