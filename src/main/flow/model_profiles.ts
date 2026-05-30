import type { AssetType } from "@/ipc/types/manifest";

// =============================================================================
// Orion Orchestrated Pipeline — Hardware / Model Profiles
// =============================================================================
//
// Maps detected hardware (by GPU VRAM) to the concrete model each pipeline stage
// should use. Selection is automatic by VRAM; `rtx-4080s-16gb` is the first
// concrete entry and others slot in later. Because the orchestrator keeps ONE
// model resident at a time, each stage's `vramMb` is a single-slot footprint,
// not a co-residency budget.
//
// Pure config + selection. No node/Electron imports so it stays unit-testable.
// See plans/orion-orchestrated-pipeline.md.
// =============================================================================

/** A concrete model assignment for one pipeline stage. */
export interface PipelineModelConfig {
  /** Backend model / tier id (e.g. "z-image-turbo", "ltx-video"). */
  modelId: string;
  /** Human-readable label. */
  label: string;
  /** Single-slot VRAM footprint in MB (informs eviction + fit checks). */
  vramMb: number;
  /** Default pipeline settings merged under per-asset manifest settings. */
  defaultSettings?: Record<string, unknown>;
}

/** How the LLM stage is sourced. */
export interface LlmStageConfig {
  /** "last-loaded" = reuse the engine's last-loaded model + its settings. */
  strategy: "last-loaded";
  /** The orchestrated pipeline requires a multimodal LLM (vision verify). */
  requireMultimodal: boolean;
}

/**
 * Full per-hardware model assignment. `threeDRef` is the image model used to
 * produce a 3D reference image; `threeD` is the mesh model (TripoSR) that
 * consumes it — that is why a 3D asset can trigger two loads within its stage.
 */
export interface HardwareModelProfile {
  id: string;
  label: string;
  /** Inclusive lower bound of detected GPU VRAM (MB) this profile targets. */
  minVramMb: number;
  /** Exclusive upper bound (MB); omit for the top profile. */
  maxVramMb?: number;
  llm: LlmStageConfig;
  image: PipelineModelConfig;
  threeDRef: PipelineModelConfig;
  threeD: PipelineModelConfig;
  video: PipelineModelConfig;
  music: PipelineModelConfig;
  /**
   * Asset/media modalities explicitly disabled for this flow. TTS speech and
   * transcription are not part of the autonomous build pipeline by decision.
   */
  disabledModalities: ("tts" | "transcribe")[];
}

// ─── Concrete profiles (ordered high → low VRAM) ─────────────────────────────

const RTX_4080S_16GB: HardwareModelProfile = {
  id: "rtx-4080s-16gb",
  label: "RTX 4080 Super (16 GB)",
  minVramMb: 15000,
  llm: { strategy: "last-loaded", requireMultimodal: true },
  image: {
    modelId: "z-image-turbo",
    label: "Z Image Turbo",
    vramMb: 8000,
    defaultSettings: { steps: 6, guidance: 4.0, width: 1024, height: 1024 },
  },
  threeDRef: {
    // 3D reference image is produced by the same image model.
    modelId: "z-image-turbo",
    label: "Z Image Turbo (3D reference)",
    vramMb: 8000,
    defaultSettings: { steps: 6, guidance: 4.0, width: 768, height: 768 },
  },
  threeD: {
    modelId: "triposr",
    label: "TripoSR",
    vramMb: 4000,
    defaultSettings: {},
  },
  video: {
    modelId: "ltx-video",
    label: "LTX Video",
    vramMb: 12000,
    defaultSettings: { seconds: 5 },
  },
  music: {
    modelId: "ace-step-1.5-xl-turbo",
    label: "ACE-Step 1.5 XL Turbo",
    vramMb: 12000,
    defaultSettings: { seconds: 30 },
  },
  disabledModalities: ["tts", "transcribe"],
};

/** All known profiles, ordered highest VRAM floor → lowest. */
export const HARDWARE_MODEL_PROFILES: readonly HardwareModelProfile[] = [
  RTX_4080S_16GB,
] as const;

// ─── Selection ───────────────────────────────────────────────────────────────

/**
 * Choose the best profile for the given GPU VRAM. Returns the first profile
 * (highest floor) whose [minVramMb, maxVramMb) window contains `vramMb`. Falls
 * back to the lowest-floor profile so a small/unknown GPU still gets a config.
 *
 * Pure function — exported for unit tests.
 */
export function selectProfileForVram(vramMb: number): HardwareModelProfile {
  const sorted = [...HARDWARE_MODEL_PROFILES].sort(
    (a, b) => b.minVramMb - a.minVramMb,
  );
  for (const profile of sorted) {
    const aboveFloor = vramMb >= profile.minVramMb;
    const belowCeil = profile.maxVramMb == null || vramMb < profile.maxVramMb;
    if (aboveFloor && belowCeil) return profile;
  }
  // Nothing matched (VRAM below every floor) → use the lowest-floor profile.
  return sorted[sorted.length - 1];
}

/** Look up a profile by its id, or undefined if unknown. */
export function getProfileById(id: string): HardwareModelProfile | undefined {
  return HARDWARE_MODEL_PROFILES.find((p) => p.id === id);
}

/**
 * Resolve the model config for a given asset modality within a profile. For
 * "3d" this returns the mesh model (TripoSR); use `profile.threeDRef` for the
 * reference-image sub-step.
 *
 * Pure function — exported for unit tests.
 */
export function modelConfigForAsset(
  profile: HardwareModelProfile,
  type: AssetType,
): PipelineModelConfig {
  switch (type) {
    case "image":
      return profile.image;
    case "video":
      return profile.video;
    case "music":
      return profile.music;
    case "3d":
      return profile.threeD;
  }
}
