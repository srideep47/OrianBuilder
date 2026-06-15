import type { AssetType } from "@/ipc/types/manifest";
import { AUTO_TIER_ID } from "@/shared/orion_media_catalog";

// =============================================================================
// Orion Orchestrated Pipeline — Hardware / Model Profiles
// =============================================================================
//
// Maps detected hardware (by GPU VRAM) to the concrete model each pipeline stage
// should use. Selection is automatic by VRAM. Three concrete profiles cover the
// hardware OrianBuilder targets:
//
//   rtx-4080s-16gb   TOP   — ≥15 GB VRAM  (RTX 4080 Super, 64 GB RAM class)
//   rtx-3060-6gb     MID   — ≥5 GB VRAM   (RTX 3060 Laptop 6 GB, 16 GB RAM class)
//   gtx-1650ti-4gb   SMALL — <5 GB VRAM   (GTX 1650 Ti 4 GB, iGPU, CPU-only)
//
// Because the orchestrator keeps ONE model resident at a time, each stage's
// `vramMb` is a single-slot footprint, not a co-residency budget.
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
  speech: PipelineModelConfig;
  /**
   * Asset/media modalities explicitly disabled for this flow. Transcription is
   * not part of the autonomous build pipeline; speech (TTS) IS supported.
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
    // Must match the backend THREED_TIERS id (models/threed.py).
    modelId: "triposr-6gb",
    label: "TripoSR",
    vramMb: 4000,
    defaultSettings: {},
  },
  video: {
    // Auto: video tier choice is VRAM+RAM gated (LTX-2 trades VRAM for
    // system RAM), which a VRAM-only profile can't express — defer to the
    // dispatcher/backend selection so AV-capable machines get LTX-2.
    modelId: AUTO_TIER_ID,
    label: "Auto (best for this device)",
    vramMb: 12000,
    defaultSettings: {},
  },
  music: {
    // Must match the backend MUSIC_TIERS id (models/music.py).
    modelId: "ace-step-xl-turbo-12gb",
    label: "ACE-Step 1.5 XL Turbo",
    vramMb: 12000,
    defaultSettings: {},
  },
  speech: {
    // F5-TTS: far more natural than SpeechT5. ~6 GB VRAM, fits the 16 GB card
    // (loaded one-at-a-time under single-residency, so it never competes with
    // the video/music models). Smaller cards keep SpeechT5 below.
    modelId: "f5-tts",
    label: "F5-TTS",
    vramMb: 6000,
    defaultSettings: {},
  },
  disabledModalities: ["transcribe"],
};

const RTX_3060_6GB: HardwareModelProfile = {
  id: "rtx-3060-6gb",
  label: "Mid-range GPU (5–15 GB, e.g. RTX 3060 6 GB)",
  minVramMb: 5000,
  maxVramMb: 15000,
  llm: { strategy: "last-loaded", requireMultimodal: true },
  image: {
    // sd-turbo over sdxl-turbo: SDXL's ~7 GB working set is too tight on a
    // 6 GB card that is also driving the display.
    modelId: "sd-turbo",
    label: "SD Turbo",
    vramMb: 3000,
    defaultSettings: { steps: 2, guidance: 0, width: 512, height: 512 },
  },
  threeDRef: {
    modelId: "sd-turbo",
    label: "SD Turbo (3D reference)",
    vramMb: 3000,
    defaultSettings: { steps: 2, guidance: 0, width: 512, height: 512 },
  },
  threeD: {
    modelId: "triposr-6gb",
    label: "TripoSR",
    vramMb: 4000,
    defaultSettings: {},
  },
  video: {
    // Auto: a 6 GB card with ≥10 GB RAM qualifies for LTX-2 (synced
    // audio+video); with less RAM the backend lands on GPU-resident
    // AnimateDiff. The RAM half of that gate lives in tier selection.
    modelId: AUTO_TIER_ID,
    label: "Auto (best for this device)",
    vramMb: 4500,
    defaultSettings: {},
  },
  music: {
    modelId: "ace-step-turbo-4gb",
    label: "ACE-Step 1.5 Turbo",
    vramMb: 4000,
    defaultSettings: {},
  },
  speech: {
    modelId: "speecht5-cpu",
    label: "SpeechT5 (CPU)",
    vramMb: 0,
    defaultSettings: {},
  },
  disabledModalities: ["transcribe"],
};

const GTX_1650TI_4GB: HardwareModelProfile = {
  id: "gtx-1650ti-4gb",
  label: "Small GPU (<5 GB, e.g. GTX 1650 Ti 4 GB)",
  minVramMb: 0,
  maxVramMb: 5000,
  llm: { strategy: "last-loaded", requireMultimodal: true },
  image: {
    modelId: "sd-turbo",
    label: "SD Turbo",
    vramMb: 3000,
    defaultSettings: { steps: 2, guidance: 0, width: 512, height: 512 },
  },
  threeDRef: {
    modelId: "sd-turbo",
    label: "SD Turbo (3D reference)",
    vramMb: 3000,
    defaultSettings: { steps: 2, guidance: 0, width: 512, height: 512 },
  },
  threeD: {
    modelId: "triposr-6gb",
    label: "TripoSR",
    vramMb: 4000,
    defaultSettings: {},
  },
  video: {
    // Auto: a 4 GB card with ≥30 GB RAM qualifies for quantized LTX-2 via
    // sequential offload; otherwise the backend lands on AnimateDiff small
    // and degrades to the CPU tier when even that doesn't fit.
    modelId: AUTO_TIER_ID,
    label: "Auto (best for this device)",
    vramMb: 3000,
    defaultSettings: {},
  },
  music: {
    modelId: "ace-step-turbo-4gb",
    label: "ACE-Step 1.5 Turbo",
    vramMb: 4000,
    defaultSettings: {},
  },
  speech: {
    modelId: "speecht5-cpu",
    label: "SpeechT5 (CPU)",
    vramMb: 0,
    defaultSettings: {},
  },
  disabledModalities: ["transcribe"],
};

/** All known profiles, ordered highest VRAM floor → lowest. */
export const HARDWARE_MODEL_PROFILES: readonly HardwareModelProfile[] = [
  RTX_4080S_16GB,
  RTX_3060_6GB,
  GTX_1650TI_4GB,
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
    case "speech":
      return profile.speech;
    case "3d":
      return profile.threeD;
  }
}

/**
 * Return a copy of `profile` with each stage's `modelId` overridden by the
 * user's media-model selection (tier ids). Unset or "auto" selections keep the
 * profile's hardware-matched default. The image override also applies to the
 * 3D reference-image stage so a chosen image model is used for 3D refs too.
 * Pure.
 */
export function applySelectionToProfile(
  profile: HardwareModelProfile,
  selection: {
    image?: string;
    video?: string;
    music?: string;
    speech?: string;
    threed?: string;
  },
): HardwareModelProfile {
  const override = (
    cfg: PipelineModelConfig,
    tierId: string | undefined,
  ): PipelineModelConfig =>
    tierId && tierId !== AUTO_TIER_ID ? { ...cfg, modelId: tierId } : cfg;

  return {
    ...profile,
    image: override(profile.image, selection.image),
    threeDRef: override(profile.threeDRef, selection.image),
    threeD: override(profile.threeD, selection.threed),
    video: override(profile.video, selection.video),
    music: override(profile.music, selection.music),
    speech: override(profile.speech, selection.speech),
  };
}
