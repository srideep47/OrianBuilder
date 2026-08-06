import { describe, expect, it } from "vitest";

import {
  computeCpuLoad,
  parseGpuLiveSamples,
  readCpuTimes,
  summariseInference,
  type CpuTimesSnapshot,
  type InferenceSample,
} from "./live_telemetry";

function times(user: number, idle: number) {
  return { user, nice: 0, sys: 0, idle, irq: 0 };
}

describe("parseGpuLiveSamples", () => {
  it("parses a single-GPU nounits line", () => {
    const [gpu] = parseGpuLiveSamples(
      "0, NVIDIA GeForce RTX 4080 SUPER, 37, 5120, 16376, 54, 118.42, 320, 2610\n",
    );
    expect(gpu).toEqual({
      index: 0,
      name: "NVIDIA GeForce RTX 4080 SUPER",
      utilizationPercent: 37,
      memoryUsedMb: 5120,
      memoryTotalMb: 16376,
      temperatureC: 54,
      powerWatts: 118.42,
      powerLimitWatts: 320,
      clockMhz: 2610,
    });
  });

  it("keeps one entry per GPU on a multi-GPU machine", () => {
    const gpus = parseGpuLiveSamples(
      ["0, GPU A, 10, 1, 2, 3, 4, 5, 6", "1, GPU B, 20, 1, 2, 3, 4, 5, 6"].join(
        "\n",
      ),
    );
    expect(gpus.map((gpu) => [gpu.index, gpu.name])).toEqual([
      [0, "GPU A"],
      [1, "GPU B"],
    ]);
  });

  it("reports unsupported fields as null rather than zero", () => {
    // A laptop/entry card returns `[N/A]` for power; 0 W would read as a card
    // that is somehow drawing no power at all.
    const [gpu] = parseGpuLiveSamples(
      "0, NVIDIA T400, 4, 128, 2048, [N/A], [Not Supported], [N/A], 300",
    );
    expect(gpu.temperatureC).toBeNull();
    expect(gpu.powerWatts).toBeNull();
    expect(gpu.powerLimitWatts).toBeNull();
    expect(gpu.utilizationPercent).toBe(4);
  });

  it("returns nothing for empty output instead of a phantom GPU", () => {
    expect(parseGpuLiveSamples("")).toEqual([]);
    expect(parseGpuLiveSamples("\n \n")).toEqual([]);
  });
});

describe("computeCpuLoad", () => {
  it("has no percentage on the first sample", () => {
    // The cumulative-jiffies trap: a lifetime average would look like a live
    // reading and never move.
    expect(
      computeCpuLoad(null, readCpuTimes([{ times: times(10, 90) }])),
    ).toEqual({ percent: null, perCore: [] });
  });

  it("computes busy time between two snapshots", () => {
    const previous = readCpuTimes([
      { times: times(100, 900) },
      { times: times(100, 900) },
    ]);
    const current = readCpuTimes([
      { times: times(150, 950) },
      { times: times(200, 900) },
    ]);
    const load = computeCpuLoad(previous, current);
    expect(load.perCore).toEqual([50, 100]);
    expect(load.percent).toBe(75);
  });

  it("returns null when no time has elapsed", () => {
    const snapshot = readCpuTimes([{ times: times(100, 900) }]);
    expect(computeCpuLoad(snapshot, snapshot).percent).toBeNull();
  });

  it("ignores a snapshot whose core count changed", () => {
    // Electron can be resumed after hibernation with a different reported core
    // list; subtracting mismatched arrays would produce negative percentages.
    const previous: CpuTimesSnapshot = { busy: [1], total: [2] };
    const current: CpuTimesSnapshot = { busy: [1, 1], total: [2, 2] };
    expect(computeCpuLoad(previous, current).percent).toBeNull();
  });

  it("clamps to 0..100", () => {
    const previous: CpuTimesSnapshot = { busy: [0], total: [0] };
    const current: CpuTimesSnapshot = { busy: [500], total: [100] };
    expect(computeCpuLoad(previous, current).perCore[0]).toBe(100);
  });
});

describe("summariseInference", () => {
  const sample = (over: Partial<InferenceSample> = {}): InferenceSample => ({
    actor: "Marta companion",
    modelId: "qwen3.5-4b",
    promptTokens: 1_000,
    completionTokens: 100,
    durationMs: 2_000,
    timeToFirstTokenMs: 240,
    contextSize: 65_536,
    timestamp: 1,
    ...over,
  });

  it("is empty and non-throwing with no samples", () => {
    expect(summariseInference([])).toEqual({
      samples: [],
      lastTokensPerSecond: null,
      averageTokensPerSecond: null,
      lastTimeToFirstTokenMs: null,
      lastContextPercent: null,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
    });
  });

  it("reports the newest decode rate and the window average", () => {
    const summary = summariseInference([
      sample({ completionTokens: 100, durationMs: 2_000 }), // 50 t/s
      sample({ completionTokens: 300, durationMs: 2_000 }), // 150 t/s
    ]);
    expect(summary.lastTokensPerSecond).toBe(150);
    expect(summary.averageTokensPerSecond).toBe(100);
    expect(summary.totalCompletionTokens).toBe(400);
    expect(summary.totalPromptTokens).toBe(2_000);
  });

  it("does not divide by zero on a cancelled call", () => {
    const summary = summariseInference([
      sample({ completionTokens: 0, durationMs: 0 }),
    ]);
    expect(summary.lastTokensPerSecond).toBeNull();
    expect(summary.averageTokensPerSecond).toBeNull();
  });

  it("expresses context occupancy as prompt plus completion", () => {
    const summary = summariseInference([
      sample({
        promptTokens: 30_000,
        completionTokens: 2_768,
        contextSize: 65_536,
      }),
    ]);
    expect(summary.lastContextPercent).toBe(50);
  });

  it("has no context percentage when the window is unknown", () => {
    expect(
      summariseInference([sample({ contextSize: null })]).lastContextPercent,
    ).toBeNull();
  });
});
