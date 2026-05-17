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

export function estimateGpuLayersForContext(input: {
  gpuBudgetMb: number;
  layerSizeMb: number;
  totalLayers: number;
  contextSize: number;
  kvBytesPerTokenPerLayer: number;
  attentionSlidingWindow?: number | null;
  attentionSlidingWindowPattern?: number | null;
  flashAttention?: boolean;
}): number {
  if (
    input.gpuBudgetMb <= 0 ||
    input.layerSizeMb <= 0 ||
    input.totalLayers <= 0
  ) {
    return 0;
  }
  const effectiveContextSize = getEffectiveKvContextSize(
    input.contextSize,
    input.attentionSlidingWindow,
    input.attentionSlidingWindowPattern,
    input.flashAttention,
  );
  const kvPerLayerMb =
    (Math.max(512, effectiveContextSize) * input.kvBytesPerTokenPerLayer) /
    (1024 * 1024);
  return Math.max(
    0,
    Math.min(
      input.totalLayers,
      Math.floor(input.gpuBudgetMb / (input.layerSizeMb + kvPerLayerMb)),
    ),
  );
}

export function getRecommendedAgentContextSize(input: {
  fileName?: string | null;
  architecture?: string | null;
  contextLengthTrained?: number | null;
  gpuBudgetMb: number;
  layerSizeMb: number;
  totalLayers: number;
  kvBytesPerTokenPerLayer: number;
  attentionSlidingWindow?: number | null;
  attentionSlidingWindowPattern?: number | null;
  flashAttention?: boolean;
}): number | null {
  const name =
    `${input.fileName ?? ""} ${input.architecture ?? ""}`.toLowerCase();
  const isQwen3 = /qwen[._-]?3/.test(name) || name.includes("qwen3");
  if (!isQwen3) {
    return null;
  }

  const isMoE =
    name.includes("moe") ||
    /\ba\d+b\b/.test(name) ||
    name.includes("-a3b") ||
    name.includes("_a3b");
  const contextCap = Math.max(2048, input.contextLengthTrained ?? 131072);
  const maxPreferredContext = isMoE ? 131072 : 65536;
  const minGpuLayerRatio = isMoE ? 0.65 : 0.55;
  const minGpuLayers = Math.max(
    1,
    Math.floor(input.totalLayers * minGpuLayerRatio),
  );
  const candidates = [maxPreferredContext, 98304, 65536, 32768].filter(
    (ctx, index, values) => ctx <= contextCap && values.indexOf(ctx) === index,
  );

  for (const contextSize of candidates) {
    const layers = estimateGpuLayersForContext({
      ...input,
      contextSize,
    });
    if (layers >= minGpuLayers) {
      return contextSize;
    }
  }

  return Math.min(contextCap, 32768);
}
