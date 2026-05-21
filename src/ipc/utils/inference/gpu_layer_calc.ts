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
  mmprojOverheadMb?: number,
): number {
  if (vramMb <= 0 || layerSizeMb <= 0) return 0;
  // Scale headroom with VRAM so small cards (4 GB class) don't lose a giant
  // fraction of their budget to a fixed pad. 4 GB → ~256 MiB, 8 GB → ~384 MiB,
  // 12 GB+ → caller's value (default 512). The caller's value still acts as a
  // ceiling so we never reserve less than what they explicitly asked for on a
  // small card.
  const explicitHeadroomMb =
    typeof vramHeadroomMb === "number"
      ? (() => {
          const requested = Math.max(128, Math.min(4096, vramHeadroomMb));
          if (vramMb <= 4096) return Math.min(requested, 256);
          if (vramMb <= 8192) return Math.min(requested, 384);
          return requested;
        })()
      : null;
  const utilBudget = vramMb * Math.min(0.98, Math.max(0.3, utilization));
  const rawBudget =
    explicitHeadroomMb == null ? utilBudget : vramMb - explicitHeadroomMb;
  // Multimodal projector (mmproj) resides in GPU memory alongside the model
  // layers. llama.cpp does not include it in n_gpu_layers accounting, so we
  // must subtract its footprint from the budget — otherwise small-VRAM cards
  // (e.g. 4 GB RX 6500M loading a Qwen3-VL with a 1.5 GB projector) OOM.
  const mmprojReserve =
    typeof mmprojOverheadMb === "number" && mmprojOverheadMb > 0
      ? mmprojOverheadMb
      : 0;
  const budget = Math.max(0, rawBudget - mmprojReserve);
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
