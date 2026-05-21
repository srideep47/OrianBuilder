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
  {
    tierId: "z-image-turbo",
    downloadId: "image-z-image-turbo",
    shortName: "Z Image Turbo",
    description:
      "8-step model with high quality. ~8 GB VRAM · 12 GB download. Recommended for dedicated GPUs.",
    vramGb: 8,
    downloadGb: 12,
    defaultSteps: 4,
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
] as const;

// ─── Image generation tiers (text → 512×512 image) ───────────────────────────
//
// Tier order: first match by VRAM wins, so fastest-download / fastest-gen
// models are placed first within each VRAM bracket.
//
//   • flux-dev:      SOTA quality, 24GB VRAM, 24GB download
//   • flux-schnell:  4-step, very high quality, 12GB VRAM, 24GB download
//   • sd-turbo:      1-step, 2 seconds, 3GB VRAM, 1.7GB download  ← FAST DEFAULT
//   • z-image-turbo: 8-step, excellent quality, 6GB VRAM, 12GB download
//   • sdxl-turbo:    1-step, fast, 6GB VRAM, 7GB download
//   • sd-1.5:        classic 20-step, 4GB VRAM, 4GB download
//   • sd-1.5-onnx-cpu: CPU fallback, 2.5GB download

export const IMAGE_MODEL_TIERS: readonly MediaTier[] = [
  {
    // Local GGUF file — auto-selected on any backend when the file exists.
    // No download needed; file placed at $userData/mediaai/models/z-image-turbo-Q4_1.gguf
    id: "z-image-turbo-gguf",
    label: "Z Image Turbo Q4_1 (GGUF)",
    vramRequiredMb: 0,
    downloadSizeMb: 0,
    quality: "best",
    approxSecondsPerGen: 6,
  },
  {
    id: "flux-dev",
    label: "FLUX.1 dev (24GB)",
    vramRequiredMb: 24000,
    downloadSizeMb: 24000,
    quality: "ultra",
    hfRepo: "black-forest-labs/FLUX.1-dev",
    approxSecondsPerGen: 25,
  },
  {
    id: "flux-schnell",
    label: "FLUX.1 schnell (12GB)",
    vramRequiredMb: 12000,
    downloadSizeMb: 24000,
    quality: "best",
    hfRepo: "black-forest-labs/FLUX.1-schnell",
    approxSecondsPerGen: 6,
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
    id: "sd-turbo",
    label: "SD Turbo (3GB)",
    vramRequiredMb: 3000,
    downloadSizeMb: 1700,
    quality: "good",
    hfRepo: "stabilityai/sd-turbo",
    approxSecondsPerGen: 2,
  },
  {
    id: "z-image-turbo",
    label: "Z Image Turbo (8GB)",
    vramRequiredMb: 8000,
    downloadSizeMb: 12000,
    quality: "best",
    hfRepo: "Tongyi-MAI/Z-Image-Turbo",
    approxSecondsPerGen: 4,
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

// ─── Video generation tiers (text → ~5s video) ───────────────────────────────
//
// Modern lineup:
//   • wan-2.1-t2v-1.3b: Alibaba Wan 2.1, 1.3B variant — efficient, 8GB
//   • ltx-video: Lightricks LTX-Video, 12GB, very fast
//   • cogvideox-2b: THUDM CogVideoX 2B, 6GB, decent quality
//   • animatediff-sd15: SD 1.5 + AnimateDiff motion module, 4GB
//   • text-to-video-cpu: CPU fallback (8 frames, 256x256)

export const VIDEO_TIERS: readonly MediaTier[] = [
  {
    id: "wan-2.1-1.3b",
    label: "Wan 2.1 (1.3B, 8GB)",
    vramRequiredMb: 8000,
    downloadSizeMb: 14000,
    quality: "best",
    hfRepo: "Wan-AI/Wan2.1-T2V-1.3B-Diffusers",
    approxSecondsPerGen: 60,
  },
  {
    id: "ltx-video",
    label: "LTX Video (12GB)",
    vramRequiredMb: 12000,
    downloadSizeMb: 18000,
    quality: "best",
    hfRepo: "Lightricks/LTX-Video",
    approxSecondsPerGen: 25,
  },
  {
    id: "animatediff-sd15",
    label: "AnimateDiff + SD 1.5 (4GB)",
    vramRequiredMb: 4000,
    downloadSizeMb: 6000,
    quality: "basic",
    hfRepo: "guoyww/animatediff-motion-adapter-v1-5-3",
    approxSecondsPerGen: 45,
  },
  {
    id: "cogvideox-2b",
    label: "CogVideoX 2B (7GB)",
    vramRequiredMb: 7000,
    downloadSizeMb: 11000,
    quality: "good",
    hfRepo: "THUDM/CogVideoX-2b",
    approxSecondsPerGen: 90,
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

export function pickBestTier(
  tiers: readonly MediaTier[],
  availableVramMb: number,
  preferredQuality?: MediaQuality,
): MediaTier {
  const minRank =
    preferredQuality !== undefined ? QUALITY_RANK[preferredQuality] : -1;
  const eligible = tiers.filter(
    (t) =>
      t.vramRequiredMb <= availableVramMb && QUALITY_RANK[t.quality] >= minRank,
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
): MediaTier {
  return pickBestTier(VIDEO_TIERS, availableVramMb, preferredQuality);
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
): AvailableTiersSnapshot {
  const projected = liveAvailableVramMb + freedByLlmUnloadMb;
  const filter = (tiers: readonly MediaTier[]) => {
    const minRank =
      preferredQuality !== undefined ? QUALITY_RANK[preferredQuality] : -1;
    return tiers.filter(
      (t) =>
        t.vramRequiredMb <= projected && QUALITY_RANK[t.quality] >= minRank,
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
