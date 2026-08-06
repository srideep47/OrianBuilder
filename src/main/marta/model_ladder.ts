/**
 * Which Marta to run on this machine.
 *
 * She is always on, so her cost is paid on every generation the user does. The
 * ladder trades her intelligence against the VRAM she takes away from the heavy
 * models she exists to orchestrate — on a 16 GB card, every gigabyte she holds
 * is a gigabyte the image pipeline cannot use.
 *
 * Sizes are the measured 4-bit working-set figures (weights plus a working KV
 * cache), not weights-only. Weights-only numbers under-report by roughly half
 * and would make the fit arithmetic in `model_gate.ts` optimistic in exactly
 * the situation where being wrong hurts most.
 *
 * The models are Qwen3.5 Small (Apache 2.0, 262K context, text + vision). They
 * are **not** omni: no audio in, no speech out. That is why the voice bus is
 * cascaded rather than speech-native — see the `omni` rung below, which is
 * where a speech-native model plugs in when one with open weights exists.
 */

import type { HardwareProfile } from "@/main/hardware/types";

export type MartaTierId = "omni" | "4b" | "2b" | "0.8b" | "cpu-only";

export interface MartaTier {
  id: MartaTierId;
  /** HuggingFace repo id for the GGUF build. */
  modelId: string;
  label: string;
  /** Working-set VRAM in MB at 4-bit, including a usable KV cache. */
  vramMb: number;
  /** Minimum total VRAM before this tier is considered. */
  minVramMb: number;
  /** True when this rung can accept audio and emit speech directly. */
  speechNative: boolean;
}

/**
 * Ordered most to least capable. Selection walks this list and takes the first
 * rung the machine clears.
 */
export const MARTA_TIERS: ReadonlyArray<MartaTier> = [
  {
    // Reserved rung, not yet reachable: there is no small open-weight omni
    // model. Qwen3.5-Omni is hosted-API-only and the only Apache-2.0 local omni
    // is the previous generation's 30B-A3B, which cannot sit resident on a
    // consumer card. Kept so the ladder — and the voice bus that reads
    // `speechNative` — is already shaped for the drop-in.
    id: "omni",
    modelId: "Qwen/Qwen3-Omni-30B-A3B-Instruct",
    label: "Qwen3-Omni 30B-A3B",
    vramMb: 21_000,
    minVramMb: 32_768,
    speechNative: true,
  },
  {
    id: "4b",
    modelId: "unsloth/Qwen3.5-4B-GGUF",
    label: "Qwen3.5 4B",
    vramMb: 5_500,
    minVramMb: 12_288,
    speechNative: false,
  },
  {
    id: "2b",
    modelId: "unsloth/Qwen3.5-2B-GGUF",
    label: "Qwen3.5 2B",
    vramMb: 3_500,
    minVramMb: 6_144,
    speechNative: false,
  },
  {
    id: "0.8b",
    modelId: "unsloth/Qwen3.5-0.8B-GGUF",
    label: "Qwen3.5 0.8B",
    vramMb: 3_000,
    minVramMb: 3_072,
    speechNative: false,
  },
];

/**
 * The fallback when no GPU rung is reachable: the smallest model, on the CPU.
 *
 * `vramMb: 0` is load-bearing rather than cosmetic — it is what makes the
 * gate's fit arithmetic treat a CPU-placed Marta as free, so she is never
 * demoted for a heavy model she was not competing with.
 */
export const MARTA_CPU_TIER: MartaTier = {
  id: "cpu-only",
  modelId: "unsloth/Qwen3.5-0.8B-GGUF",
  label: "Qwen3.5 0.8B (CPU)",
  vramMb: 0,
  minVramMb: 0,
  speechNative: false,
};

export interface MartaPlacementPlan {
  tier: MartaTier;
  placement: "gpu" | "cpu";
  /** Why this rung, in one line. Surfaced in settings and diagnostics. */
  rationale: string;
}

/**
 * Pick Marta's tier and placement for a machine.
 *
 * `ceiling` caps the ladder for a user who would rather keep VRAM free than
 * have a smarter orchestrator; it never raises the tier above what the hardware
 * supports.
 */
export function planMartaPlacement(
  profile: HardwareProfile,
  options: { ceiling?: MartaTierId } = {},
): MartaPlacementPlan {
  const gpu = profile.primaryGpu;

  // An integrated GPU shares system RAM and has no bandwidth to spare for a
  // resident model. Marta runs on the CPU cores instead, which on such machines
  // is both faster and less disruptive.
  if (!gpu || gpu.isIntegrated) {
    return {
      tier: MARTA_CPU_TIER,
      placement: "cpu",
      rationale: gpu
        ? "Integrated GPU — running on CPU to leave shared memory alone."
        : "No discrete GPU detected — running on CPU.",
    };
  }

  const ceilingIndex = options.ceiling
    ? MARTA_TIERS.findIndex((t) => t.id === options.ceiling)
    : 0;
  const candidates =
    ceilingIndex >= 0 ? MARTA_TIERS.slice(ceilingIndex) : MARTA_TIERS;

  const tier = candidates.find((t) => gpu.vramMb >= t.minVramMb);
  if (!tier) {
    return {
      tier: MARTA_CPU_TIER,
      placement: "cpu",
      rationale: `Only ${Math.round(gpu.vramMb / 1024)}GB of VRAM — too little to hold a resident orchestrator.`,
    };
  }

  return {
    tier,
    placement: "gpu",
    rationale: `${Math.round(gpu.vramMb / 1024)}GB of VRAM on ${gpu.model} — ${tier.label} fits alongside a heavy model.`,
  };
}

export function findMartaTier(id: MartaTierId): MartaTier | null {
  if (id === "cpu-only") return MARTA_CPU_TIER;
  return MARTA_TIERS.find((t) => t.id === id) ?? null;
}
