/**
 * Pure tier definitions shared between the main process (orchestrator) and
 * the renderer (Engine UI). NO node-only imports allowed in this file.
 *
 * Tier order matters: pickBestTier walks the array top-to-bottom and returns
 * the first tier whose vramRequiredMb fits in the available VRAM. Always
 * order from highest VRAM (best quality) → lowest (CPU fallback).
 */

export type MediaQuality = "ultra" | "best" | "good" | "basic" | "slow";

export interface MediaTier {
  id: string;
  /** Human-readable label for UI display. */
  label: string;
  /** Minimum GPU VRAM (MB) required to load this model. 0 = CPU fallback. */
  vramRequiredMb: number;
  /** Minimum total system RAM (MB), when the model is RAM-gated too. */
  ramRequiredMb?: number;
  /**
   * When set, the tier fits if ANY {vramMb, ramMb} pair is satisfied — used
   * for models whose weights trade VRAM for system RAM via CPU offload (e.g.
   * LTX-2 quantized). vramRequiredMb/ramRequiredMb then act as display floors.
   */
  anyOfRequirements?: readonly { vramMb: number; ramMb: number }[];
  /** True when the model emits a synced soundtrack with the frames; pipeline
   *  steps can then skip their own music generation + mux pass. */
  generatesAudio?: boolean;
  /** True for image-to-video-only models (Wan 2.2 14B): they animate a
   *  supplied keyframe image and cannot run from text alone. Auto-selection
   *  skips them unless the request carries an image. */
  requiresImage?: boolean;
  /** Approximate disk size after download (MB). For UI download estimates. */
  downloadSizeMb: number;
  quality: MediaQuality;
  /** HuggingFace repo id, used by the Python backend to download/load. */
  hfRepo?: string;
  /** Approximate seconds per generation on the target hardware. */
  approxSecondsPerGen?: number;
}

export interface ImageTierUiConfig {
  tierId: string;
  downloadId: string;
  shortName: string;
  description: string;
  vramGb: number;
  downloadGb: number;
  defaultSteps: number;
  minSteps: number;
  maxSteps: number;
  /** Whether guidance scale is meaningful for this model (turbo = no). */
  supportsGuidance: boolean;
  defaultGuidance: number;
  defaultWidth: number;
  defaultHeight: number;
  allowedResolutions: { width: number; height: number; label: string }[];
  qualityPresets: { label: string; steps: number; guidance: number }[];
}

export const USER_FACING_IMAGE_TIERS: readonly ImageTierUiConfig[] = [
  {
    tierId: "z-image-turbo",
    downloadId: "image-z-image-turbo",
    shortName: "Z Image Turbo",
    description:
      "Alibaba Tongyi 8-step model. High quality, ~8 GB VRAM · 12 GB download. Auto-selected for 8 GB+ GPUs. No HuggingFace auth required.",
    vramGb: 8,
    downloadGb: 12,
    defaultSteps: 6,
    minSteps: 4,
    maxSteps: 8,
    supportsGuidance: true,
    defaultGuidance: 4.0,
    defaultWidth: 768,
    defaultHeight: 768,
    allowedResolutions: [
      { width: 512, height: 512, label: "512 × 512" },
      { width: 768, height: 768, label: "768 × 768" },
      { width: 1024, height: 1024, label: "1024 × 1024" },
    ],
    qualityPresets: [
      { label: "Draft (4 steps)", steps: 4, guidance: 2.0 },
      { label: "Balanced (6 steps)", steps: 6, guidance: 4.0 },
      { label: "Quality (8 steps)", steps: 8, guidance: 6.0 },
    ],
  },
  {
    tierId: "sd-turbo",
    downloadId: "image-sd-turbo",
    shortName: "SD Turbo",
    description:
      "1-step turbo model. ~3 GB VRAM · 1.7 GB download. Best for low-VRAM machines and fast iteration.",
    vramGb: 3,
    downloadGb: 1.7,
    defaultSteps: 1,
    minSteps: 1,
    maxSteps: 4,
    supportsGuidance: false,
    defaultGuidance: 0,
    defaultWidth: 512,
    defaultHeight: 512,
    allowedResolutions: [
      { width: 512, height: 512, label: "512 × 512" },
      { width: 768, height: 768, label: "768 × 768" },
    ],
    qualityPresets: [
      { label: "Fast (1 step)", steps: 1, guidance: 0 },
      { label: "Balanced (2 steps)", steps: 2, guidance: 0 },
      { label: "Quality (4 steps)", steps: 4, guidance: 0 },
    ],
  },
] as const;

// ─── Image generation tiers (text → 512×512 image) ───────────────────────────
//
// Tier order: first match by VRAM wins (highest quality → lowest fallback).
//
//   • z-image-turbo: Alibaba Tongyi, 8-step, 8GB VRAM ← quality default for 8 GB+
//   • sdxl-turbo:    1-step, 6GB VRAM
//   • sd-turbo:      1-step, 3GB VRAM ← budget default for ≤4 GB
//   • sd-1.5:        classic 20-step, 4GB VRAM
//   • sd-1.5-onnx-cpu: CPU fallback

export const IMAGE_MODEL_TIERS: readonly MediaTier[] = [
  {
    // Alibaba Tongyi — auto-selected for 8 GB+ GPUs.
    id: "z-image-turbo",
    label: "Z Image Turbo (8GB)",
    vramRequiredMb: 8000,
    downloadSizeMb: 12000,
    quality: "best",
    hfRepo: "Tongyi-MAI/Z-Image-Turbo",
    approxSecondsPerGen: 4,
  },
  {
    id: "sdxl-turbo",
    label: "SDXL Turbo (6GB)",
    vramRequiredMb: 6000,
    downloadSizeMb: 7000,
    quality: "good",
    hfRepo: "stabilityai/sdxl-turbo",
    approxSecondsPerGen: 2,
  },
  {
    // Auto-selected for ≤4 GB GPUs.
    id: "sd-turbo",
    label: "SD Turbo (3GB)",
    vramRequiredMb: 3000,
    downloadSizeMb: 1700,
    quality: "good",
    hfRepo: "stabilityai/sd-turbo",
    approxSecondsPerGen: 2,
  },
  {
    id: "sd-1.5",
    label: "Stable Diffusion 1.5 (4GB)",
    vramRequiredMb: 4000,
    downloadSizeMb: 4000,
    quality: "basic",
    hfRepo: "runwayml/stable-diffusion-v1-5",
    approxSecondsPerGen: 8,
  },
  {
    id: "sd-1.5-onnx-cpu",
    label: "SD 1.5 ONNX (CPU)",
    vramRequiredMb: 0,
    downloadSizeMb: 2500,
    quality: "slow",
    hfRepo: "nmkd/stable-diffusion-1.5-onnx-fp16",
    approxSecondsPerGen: 90,
  },
] as const;

// ─── Video generation tiers (text → ~3s video) ───────────────────────────────
//
// Four production tiers + a CPU fallback, matched to the hardware OrianBuilder
// targets. Mirrors mediaai-backend/.../models/video.py VIDEO_TIERS — keep both
// in sync.
//
//   • ltx-2-av-small:         TOP   — LTX-2.3, synced audio+video, GGUF
//                                     transformer (Q4_K_S ~16.7 GB), group-
//                                     offloaded (RAM-pinned on ≥24 GB machines,
//                                     disk-spill otherwise); fits when (≥6 GB
//                                     VRAM & ≥10 GB RAM) or (≥4 GB VRAM & ≥30 GB)
//   • ltx-video:              TOP   — LTX-Video 0.9, no audio (≥12 GB VRAM)
//   • animatediff-sd15:       MID   — RTX 3060 6 GB class (GPU-resident)
//   • animatediff-sd15-small: SMALL — GTX 1650 Ti 4 GB class (CPU offload)
//   • text-to-video-cpu:      CPU fallback (256×256, slow)
//
// (The full bf16 "ltx-2-av" dev tier was removed: bitsandbytes 4-bit at load
// leaves a "meta tensor" during model offload on current torch/diffusers and
// fails generation. The GGUF transformer path below is the reliable AV route.)

export const VIDEO_TIERS: readonly MediaTier[] = [
  {
    // Wan 2.2 A14B — the strongest open video model on 16 GB-class cards.
    // Two 14 B GGUF transformer experts (Q4_K_S ~8.7 GB each) + the lightx2v
    // Lightning LoRA for 4-step sampling. IMAGE-TO-VIDEO ONLY: it animates a
    // keyframe image (the storyboard pipeline generates one per scene), so
    // auto-selection skips it for plain text-to-video requests. No synced
    // audio — the pipeline lays music/narration in the edit pass instead.
    id: "wan-2.2-i2v",
    label: "Wan 2.2 14B (image-to-video, best quality)",
    vramRequiredMb: 10240,
    ramRequiredMb: 24576,
    requiresImage: true,
    downloadSizeMb: 31000,
    quality: "best",
    hfRepo: "Wan-AI/Wan2.2-I2V-A14B-Diffusers",
    approxSecondsPerGen: 90,
  },
  {
    // LTX-2.3 generates the soundtrack WITH the frames (synced audio+video).
    // A community GGUF transformer (Q4_K_S ~16.7 GB) replaces the 40 GB bf16
    // one and runs via diffusers group offloading: weight groups stream to the
    // GPU on demand, RAM-pinned on ≥24 GB machines (faster) or disk-spilled
    // otherwise — so the gate is an any-of VRAM/RAM combination. Still needs the
    // repo's Gemma-3 TE + connectors (~55 GB of a fresh download).
    id: "ltx-2-av-small",
    label: "LTX-2.3 (synced audio+video)",
    vramRequiredMb: 4096,
    ramRequiredMb: 10240,
    anyOfRequirements: [
      { vramMb: 6144, ramMb: 10240 },
      { vramMb: 4096, ramMb: 30720 },
    ],
    generatesAudio: true,
    downloadSizeMb: 72000,
    quality: "best",
    hfRepo: "diffusers/LTX-2.3-Diffusers",
    approxSecondsPerGen: 120,
  },
  {
    id: "ltx-video",
    label: "LTX Video (top · 12GB+)",
    vramRequiredMb: 12000,
    downloadSizeMb: 18000,
    quality: "best",
    hfRepo: "Lightricks/LTX-Video",
    approxSecondsPerGen: 25,
  },
  {
    // Wan 2.2 TI2V-5B — text-to-video for the 6 GB-VRAM / 16 GB-RAM floor.
    // Q4_K_S GGUF transformer (~3.1 GB); the UMT5 text encoder streams via
    // group offload.
    id: "wan-2.2-5b",
    label: "Wan 2.2 5B (small GPU)",
    vramRequiredMb: 5120,
    ramRequiredMb: 10240,
    downloadSizeMb: 15000,
    quality: "good",
    hfRepo: "Wan-AI/Wan2.2-TI2V-5B-Diffusers",
    approxSecondsPerGen: 120,
  },
  {
    id: "animatediff-sd15",
    label: "AnimateDiff + SD 1.5 (mid · 6GB)",
    vramRequiredMb: 4500,
    downloadSizeMb: 6000,
    quality: "good",
    hfRepo: "guoyww/animatediff-motion-adapter-v1-5-3",
    approxSecondsPerGen: 60,
  },
  {
    id: "animatediff-sd15-small",
    label: "AnimateDiff + SD 1.5 (small · 4GB)",
    vramRequiredMb: 3000,
    downloadSizeMb: 6000,
    quality: "basic",
    hfRepo: "guoyww/animatediff-motion-adapter-v1-5-3",
    approxSecondsPerGen: 180,
  },
  {
    id: "text-to-video-cpu",
    label: "Text-to-Video MS (CPU)",
    vramRequiredMb: 0,
    downloadSizeMb: 8000,
    quality: "slow",
    hfRepo: "damo-vilab/text-to-video-ms-1.7b",
    approxSecondsPerGen: 600,
  },
] as const;

// ─── Music generation tiers (text → soundtrack, ACE-Step 1.5) ────────────────
//
// Mirrors mediaai-backend/.../models/music.py MUSIC_TIERS.

export const MUSIC_TIERS: readonly MediaTier[] = [
  {
    id: "ace-step-xl-turbo-12gb",
    label: "ACE-Step 1.5 XL Turbo (12GB)",
    vramRequiredMb: 12000,
    downloadSizeMb: 14000,
    quality: "best",
    approxSecondsPerGen: 60,
  },
  {
    id: "ace-step-turbo-4gb",
    label: "ACE-Step 1.5 Turbo (4GB)",
    vramRequiredMb: 4000,
    downloadSizeMb: 9700,
    quality: "good",
    approxSecondsPerGen: 90,
  },
] as const;

// ─── Audio TTS tiers (text → speech) ──────────────────────────────────────────
//
// Modern lineup:
//   • f5-tts: F5-TTS, voice cloning, very natural, 6GB
//   • xtts-v2: Coqui XTTS-v2, voice cloning, 4GB
//   • kokoro-82m: Kokoro 82M — SOTA tiny model, runs CPU at near-realtime, 1GB GPU optional
//   • piper: CPU-only fast TTS
//   • speecht5-cpu: legacy SpeechT5 fallback (existing)

export const AUDIO_TTS_TIERS: readonly MediaTier[] = [
  {
    id: "f5-tts",
    label: "F5-TTS (6GB)",
    vramRequiredMb: 6000,
    downloadSizeMb: 5000,
    quality: "best",
    hfRepo: "SWivid/F5-TTS",
    approxSecondsPerGen: 4,
  },
  {
    id: "xtts-v2",
    label: "XTTS v2 (3GB)",
    vramRequiredMb: 3000,
    downloadSizeMb: 1900,
    quality: "best",
    hfRepo: "coqui/XTTS-v2",
    approxSecondsPerGen: 3,
  },
  {
    id: "kokoro-82m",
    label: "Kokoro 82M (1GB / CPU)",
    vramRequiredMb: 1000,
    downloadSizeMb: 350,
    quality: "good",
    hfRepo: "hexgrad/Kokoro-82M",
    approxSecondsPerGen: 2,
  },
  {
    id: "piper",
    label: "Piper TTS (CPU)",
    vramRequiredMb: 0,
    downloadSizeMb: 60,
    quality: "good",
    approxSecondsPerGen: 1,
  },
  {
    id: "speecht5-cpu",
    label: "SpeechT5 (CPU)",
    vramRequiredMb: 0,
    downloadSizeMb: 600,
    quality: "slow",
    hfRepo: "microsoft/speecht5_tts",
    approxSecondsPerGen: 8,
  },
] as const;

// ─── Audio STT tiers (audio → transcription) ──────────────────────────────────

export const AUDIO_STT_TIERS: readonly MediaTier[] = [
  {
    id: "whisper-large-v3-turbo",
    label: "Whisper Large v3 Turbo (6GB)",
    vramRequiredMb: 6000,
    downloadSizeMb: 1620,
    quality: "best",
    hfRepo: "openai/whisper-large-v3-turbo",
    approxSecondsPerGen: 4,
  },
  {
    id: "whisper-large-v3",
    label: "Whisper Large v3 (8GB)",
    vramRequiredMb: 8000,
    downloadSizeMb: 3100,
    quality: "best",
    hfRepo: "openai/whisper-large-v3",
    approxSecondsPerGen: 12,
  },
  {
    id: "whisper-medium",
    label: "Whisper Medium (4GB)",
    vramRequiredMb: 4000,
    downloadSizeMb: 1530,
    quality: "good",
    hfRepo: "openai/whisper-medium",
    approxSecondsPerGen: 6,
  },
  {
    id: "whisper-base",
    label: "Whisper Base (2GB)",
    vramRequiredMb: 2000,
    downloadSizeMb: 290,
    quality: "basic",
    hfRepo: "openai/whisper-base",
    approxSecondsPerGen: 4,
  },
  {
    id: "whisper-tiny-cpu",
    label: "Whisper Tiny (CPU)",
    vramRequiredMb: 0,
    downloadSizeMb: 75,
    quality: "slow",
    hfRepo: "openai/whisper-tiny",
    approxSecondsPerGen: 15,
  },
] as const;

const QUALITY_RANK: Record<MediaQuality, number> = {
  ultra: 0,
  best: 1,
  good: 2,
  basic: 3,
  slow: 4,
};

/**
 * True when the tier's hardware requirements fit. `totalRamMb` undefined means
 * "unknown" — RAM checks pass, mirroring the Python backend's behavior (which
 * re-validates with its own RAM reading anyway).
 */
export function tierFitsHardware(
  tier: MediaTier,
  availableVramMb: number,
  totalRamMb?: number,
): boolean {
  if (tier.anyOfRequirements && tier.anyOfRequirements.length > 0) {
    return tier.anyOfRequirements.some(
      (req) =>
        availableVramMb >= req.vramMb &&
        (totalRamMb === undefined || totalRamMb >= req.ramMb),
    );
  }
  if (
    totalRamMb !== undefined &&
    tier.ramRequiredMb !== undefined &&
    totalRamMb < tier.ramRequiredMb
  ) {
    return false;
  }
  return tier.vramRequiredMb <= availableVramMb;
}

export function pickBestTier(
  tiers: readonly MediaTier[],
  availableVramMb: number,
  preferredQuality?: MediaQuality,
  totalRamMb?: number,
): MediaTier {
  const minRank =
    preferredQuality !== undefined ? QUALITY_RANK[preferredQuality] : -1;
  const eligible = tiers.filter(
    (t) =>
      tierFitsHardware(t, availableVramMb, totalRamMb) &&
      QUALITY_RANK[t.quality] >= minRank,
  );
  if (eligible.length > 0) return eligible[0];
  return tiers[tiers.length - 1];
}

export function pickBestImageTier(
  availableVramMb: number,
  preferredQuality?: MediaQuality,
): MediaTier {
  return pickBestTier(IMAGE_MODEL_TIERS, availableVramMb, preferredQuality);
}

export function pickBestAudioTtsTier(
  availableVramMb: number,
  preferredQuality?: MediaQuality,
): MediaTier {
  return pickBestTier(AUDIO_TTS_TIERS, availableVramMb, preferredQuality);
}

export function pickBestAudioSttTier(
  availableVramMb: number,
  preferredQuality?: MediaQuality,
): MediaTier {
  return pickBestTier(AUDIO_STT_TIERS, availableVramMb, preferredQuality);
}

export function pickBestVideoTier(
  availableVramMb: number,
  preferredQuality?: MediaQuality,
  totalRamMb?: number,
  hasImage = false,
): MediaTier {
  // i2v-only tiers (Wan 2.2 14B) need a keyframe image — without one they
  // can't run at all, so auto-selection must skip them.
  const eligible = hasImage
    ? VIDEO_TIERS
    : VIDEO_TIERS.filter((t) => !t.requiresImage);
  return pickBestTier(eligible, availableVramMb, preferredQuality, totalRamMb);
}

export function pickBestMusicTier(
  availableVramMb: number,
  preferredQuality?: MediaQuality,
): MediaTier {
  return pickBestTier(MUSIC_TIERS, availableVramMb, preferredQuality);
}

export interface AvailableTiersSnapshot {
  image: MediaTier[];
  audio: MediaTier[];
  audioStt: MediaTier[];
  video: MediaTier[];
  projectedAvailableVramMb: number;
}

export function selectAvailableTiers(
  liveAvailableVramMb: number,
  freedByLlmUnloadMb: number,
  preferredQuality?: MediaQuality,
  totalRamMb?: number,
): AvailableTiersSnapshot {
  const projected = liveAvailableVramMb + freedByLlmUnloadMb;
  const filter = (tiers: readonly MediaTier[]) => {
    const minRank =
      preferredQuality !== undefined ? QUALITY_RANK[preferredQuality] : -1;
    return tiers.filter(
      (t) =>
        tierFitsHardware(t, projected, totalRamMb) &&
        QUALITY_RANK[t.quality] >= minRank,
    );
  };
  return {
    image: filter(IMAGE_MODEL_TIERS),
    audio: filter(AUDIO_TTS_TIERS),
    audioStt: filter(AUDIO_STT_TIERS),
    video: filter(VIDEO_TIERS),
    projectedAvailableVramMb: projected,
  };
}
