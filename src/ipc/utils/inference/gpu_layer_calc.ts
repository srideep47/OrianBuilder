export const OOM_KEYWORDS = [
  "VRAM",
  "vram",
  "memory",
  "Memory",
  "OOM",
  "OutOfMemory",
  "out of memory",
  "context size",
  "Context size",
  "too large",
  "CUDA",
  "cuda",
  "cuLaunchKernel",
  "allocation failed",
];

export function isOomError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return OOM_KEYWORDS.some((kw) => msg.includes(kw));
}

export function getEffectiveKvContextSize(
  contextSize: number,
  attentionSlidingWindow?: number | null,
  attentionSlidingWindowPattern?: number | null,
  flashAttention?: boolean,
): number {
  const slidingWindow = attentionSlidingWindow ?? 0;
  if (slidingWindow <= 0 || slidingWindow >= contextSize) {
    return contextSize;
  }
  const pattern = Math.max(1, attentionSlidingWindowPattern ?? 1);
  const nonSwaPercent =
    pattern <= 1 ? 1 : 1 / (pattern + (flashAttention ? -0.5 : -1));
  return Math.ceil(
    (1 - nonSwaPercent) * slidingWindow + nonSwaPercent * contextSize,
  );
}

export function calculateGpuLayers(
  vramMb: number,
  utilization: number,
  vramHeadroomMb: number | undefined,
  layerSizeMb: number,
  totalLayers: number,
  contextSize: number,
  kvBytesPerTokenPerLayer: number,
  attentionSlidingWindow?: number | null,
  attentionSlidingWindowPattern?: number | null,
  flashAttention?: boolean,
): number {
  if (vramMb <= 0 || layerSizeMb <= 0) return 0;
  const explicitHeadroomMb =
    typeof vramHeadroomMb === "number"
      ? Math.max(256, Math.min(4096, vramHeadroomMb))
      : null;
  const utilBudget = vramMb * Math.min(0.98, Math.max(0.3, utilization));
  const budget = Math.max(
    0,
    explicitHeadroomMb == null ? utilBudget : vramMb - explicitHeadroomMb,
  );
  const effectiveContextSize = getEffectiveKvContextSize(
    contextSize,
    attentionSlidingWindow,
    attentionSlidingWindowPattern,
    flashAttention,
  );
  const kvPerLayerMb =
    (Math.max(512, effectiveContextSize) * kvBytesPerTokenPerLayer) /
    (1024 * 1024);
  const perLayerMb = layerSizeMb + kvPerLayerMb;
  return Math.min(totalLayers, Math.floor(budget / perLayerMb));
}

export function clampGpuLayers(layers: number, totalLayers: number): number {
  return Math.max(0, Math.min(totalLayers, Math.floor(layers)));
}
