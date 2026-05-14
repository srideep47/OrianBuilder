/**
 * Pure tier definitions shared between the main process (orchestrator) and
 * the renderer (Engine UI). NO node-only imports allowed in this file.
 */

export type MediaQuality = "best" | "good" | "basic" | "slow";

export interface MediaTier {
  id: string;
  vramRequiredMb: number;
  quality: MediaQuality;
}

export const IMAGE_MODEL_TIERS: readonly MediaTier[] = [
  { id: "flux-schnell", vramRequiredMb: 12000, quality: "best" },
  { id: "sdxl-turbo", vramRequiredMb: 8000, quality: "good" },
  { id: "sd-1.5", vramRequiredMb: 4000, quality: "basic" },
  { id: "sd-1.5-cpu", vramRequiredMb: 0, quality: "slow" },
] as const;

export const AUDIO_TTS_TIERS: readonly MediaTier[] = [
  { id: "xtts-v2", vramRequiredMb: 3000, quality: "best" },
  { id: "piper", vramRequiredMb: 0, quality: "good" },
] as const;

export const VIDEO_TIERS: readonly MediaTier[] = [
  { id: "ltx-video", vramRequiredMb: 12000, quality: "best" },
  { id: "stable-video-diffusion", vramRequiredMb: 8000, quality: "good" },
  { id: "text-to-video-cpu", vramRequiredMb: 0, quality: "slow" },
] as const;

const QUALITY_RANK: Record<MediaQuality, number> = {
  best: 0,
  good: 1,
  basic: 2,
  slow: 3,
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

export function pickBestVideoTier(
  availableVramMb: number,
  preferredQuality?: MediaQuality,
): MediaTier {
  return pickBestTier(VIDEO_TIERS, availableVramMb, preferredQuality);
}

export interface AvailableTiersSnapshot {
  image: MediaTier[];
  audio: MediaTier[];
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
    video: filter(VIDEO_TIERS),
    projectedAvailableVramMb: projected,
  };
}
