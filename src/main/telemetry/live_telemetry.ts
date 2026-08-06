/**
 * Live machine telemetry: what the GPU, CPU and RAM are actually doing *now*.
 *
 * `src/main/hardware/detect.ts` answers "what is this machine" once and caches
 * it forever, which is the right shape for scheduling decisions and the wrong
 * shape for a Stage surface: the plan's "show inference, GPU and PC stats next
 * to the live preview" needs a sampled value, not a capability.
 *
 * Two deliberate choices:
 *
 *   - **Sampled on demand, cached briefly.** A resident 1 Hz poller would spawn
 *     `nvidia-smi` forever even with no telemetry surface on screen, and
 *     `nvidia-smi` costs ~30 ms of CPU each time. The renderer polls only while
 *     a telemetry surface is mounted; the cache stops two mounted surfaces from
 *     doubling the spawn rate.
 *   - **CPU load is a delta, so the first sample has none.** `os.cpus()` reports
 *     cumulative jiffies since boot. Dividing them by uptime would report the
 *     machine's *lifetime* average and read as a stuck needle. `null` until a
 *     second sample exists is honest.
 */

import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";

import log from "electron-log";

const execFileAsync = promisify(execFile);
const logger = log.scope("live-telemetry");

/** Long enough that two mounted surfaces share one probe; short enough to read as live. */
const SAMPLE_CACHE_MS = 900;
const PROBE_TIMEOUT_MS = 4_000;
/** Bounded so a long session cannot grow the inference log without limit. */
const MAX_INFERENCE_SAMPLES = 40;

export interface GpuLiveSample {
  index: number;
  name: string;
  utilizationPercent: number | null;
  memoryUsedMb: number | null;
  memoryTotalMb: number | null;
  temperatureC: number | null;
  powerWatts: number | null;
  powerLimitWatts: number | null;
  clockMhz: number | null;
}

export interface CpuLiveSample {
  /** Aggregate load across all logical cores, or null on the very first sample. */
  percent: number | null;
  /** Per-core load, same caveat. */
  perCore: number[];
  cores: number;
  /** 1-minute load average; always 0 on Windows, so it is reported as null there. */
  loadAverage: number | null;
}

export interface MemoryLiveSample {
  usedMb: number;
  totalMb: number;
  percent: number;
  /** Resident set of this Electron main process, which is Orion's own footprint. */
  processRssMb: number;
}

export interface LiveTelemetrySample {
  capturedAt: number;
  gpus: GpuLiveSample[];
  /** Present only when `nvidia-smi` is unavailable or failed, for honest UI. */
  gpuUnavailableReason: string | null;
  cpu: CpuLiveSample;
  memory: MemoryLiveSample;
}

export interface InferenceSample {
  /** Which brain produced this: the companion, a coding worker, a big brain. */
  actor: string;
  modelId: string | null;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
  /** Time to the first streamed token, when the caller streams. */
  timeToFirstTokenMs: number | null;
  contextSize: number | null;
  timestamp: number;
}

export interface InferenceTelemetry {
  samples: InferenceSample[];
  /** Decode rate of the most recent sample, the number a user reads as "speed". */
  lastTokensPerSecond: number | null;
  /** Mean decode rate across the window, which is steadier to look at. */
  averageTokensPerSecond: number | null;
  lastTimeToFirstTokenMs: number | null;
  /** Prompt occupancy of the most recent sample against its context window. */
  lastContextPercent: number | null;
  totalPromptTokens: number;
  totalCompletionTokens: number;
}

// ─── Pure parsing and arithmetic (exported for tests) ────────────────────────

/** `nvidia-smi` prints `[N/A]` and `[Not Supported]` for fields a card lacks. */
function numberOrNull(value: string | undefined): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("[")) return null;
  const parsed = Number.parseFloat(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export const NVIDIA_SMI_QUERY_FIELDS = [
  "index",
  "name",
  "utilization.gpu",
  "memory.used",
  "memory.total",
  "temperature.gpu",
  "power.draw",
  "power.limit",
  "clocks.sm",
] as const;

/**
 * Parse `nvidia-smi --query-gpu=<fields> --format=csv,noheader,nounits`.
 *
 * `nounits` is what makes this a pure number parse; without it every field
 * arrives as `"12 W"` and the arithmetic silently becomes string handling.
 */
export function parseGpuLiveSamples(stdout: string): GpuLiveSample[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, fallbackIndex) => {
      const columns = line.split(",").map((column) => column.trim());
      const index = numberOrNull(columns[0]);
      return {
        index: index ?? fallbackIndex,
        name: columns[1] ?? "NVIDIA GPU",
        utilizationPercent: numberOrNull(columns[2]),
        memoryUsedMb: numberOrNull(columns[3]),
        memoryTotalMb: numberOrNull(columns[4]),
        temperatureC: numberOrNull(columns[5]),
        powerWatts: numberOrNull(columns[6]),
        powerLimitWatts: numberOrNull(columns[7]),
        clockMhz: numberOrNull(columns[8]),
      };
    })
    .filter((gpu) => gpu.name.length > 0);
}

export interface CpuTimesSnapshot {
  /** Busy jiffies per core: everything except `idle`. */
  busy: number[];
  /** Total jiffies per core. */
  total: number[];
}

export function readCpuTimes(
  cpus: ReadonlyArray<{ times: os.CpuInfo["times"] }> = os.cpus(),
): CpuTimesSnapshot {
  const busy: number[] = [];
  const total: number[] = [];
  for (const cpu of cpus) {
    const { user, nice, sys, idle, irq } = cpu.times;
    const cpuTotal = user + nice + sys + idle + irq;
    busy.push(cpuTotal - idle);
    total.push(cpuTotal);
  }
  return { busy, total };
}

/**
 * Load between two snapshots, per core and aggregate.
 *
 * Returns `null` percentages when no time has elapsed — two samples taken in
 * the same millisecond divide by zero, and `NaN` rendered in a gauge looks like
 * a crash rather than "ask again in a moment".
 */
export function computeCpuLoad(
  previous: CpuTimesSnapshot | null,
  current: CpuTimesSnapshot,
): { percent: number | null; perCore: number[] } {
  if (!previous || previous.total.length !== current.total.length) {
    return { percent: null, perCore: [] };
  }
  const perCore: number[] = [];
  let busyDelta = 0;
  let totalDelta = 0;
  for (let index = 0; index < current.total.length; index += 1) {
    const busy = current.busy[index] - previous.busy[index];
    const total = current.total[index] - previous.total[index];
    busyDelta += busy;
    totalDelta += total;
    perCore.push(total > 0 ? clampPercent((busy / total) * 100) : 0);
  }
  return {
    percent:
      totalDelta > 0 ? clampPercent((busyDelta / totalDelta) * 100) : null,
    perCore,
  };
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value * 10) / 10));
}

/** Derive the read-model the Stage shows from a bounded window of samples. */
export function summariseInference(
  samples: ReadonlyArray<InferenceSample>,
): InferenceTelemetry {
  const rate = (sample: InferenceSample): number | null =>
    sample.durationMs > 0 && sample.completionTokens > 0
      ? Math.round(
          (sample.completionTokens / (sample.durationMs / 1_000)) * 10,
        ) / 10
      : null;

  const rates = samples
    .map(rate)
    .filter((value): value is number => value !== null);
  const last = samples.at(-1) ?? null;

  return {
    samples: [...samples],
    lastTokensPerSecond: last ? rate(last) : null,
    averageTokensPerSecond:
      rates.length > 0
        ? Math.round(
            (rates.reduce((sum, value) => sum + value, 0) / rates.length) * 10,
          ) / 10
        : null,
    lastTimeToFirstTokenMs: last?.timeToFirstTokenMs ?? null,
    lastContextPercent:
      last && last.contextSize && last.contextSize > 0
        ? clampPercent(
            ((last.promptTokens + last.completionTokens) / last.contextSize) *
              100,
          )
        : null,
    totalPromptTokens: samples.reduce(
      (sum, sample) => sum + sample.promptTokens,
      0,
    ),
    totalCompletionTokens: samples.reduce(
      (sum, sample) => sum + sample.completionTokens,
      0,
    ),
  };
}

// ─── Sampling ────────────────────────────────────────────────────────────────

let cachedSample: LiveTelemetrySample | null = null;
let inFlight: Promise<LiveTelemetrySample> | null = null;
let previousCpuTimes: CpuTimesSnapshot | null = null;
/**
 * Sticky once `nvidia-smi` is missing.
 *
 * Retrying a missing executable every second costs a process spawn and a
 * rejected promise for as long as the surface stays open, and the answer never
 * changes inside one session.
 */
let gpuProbeDisabledReason: string | null = null;
const inferenceSamples: InferenceSample[] = [];

async function probeGpus(): Promise<{
  gpus: GpuLiveSample[];
  reason: string | null;
}> {
  if (gpuProbeDisabledReason) {
    return { gpus: [], reason: gpuProbeDisabledReason };
  }
  try {
    const { stdout } = await execFileAsync(
      "nvidia-smi",
      [
        `--query-gpu=${NVIDIA_SMI_QUERY_FIELDS.join(",")}`,
        "--format=csv,noheader,nounits",
      ],
      { timeout: PROBE_TIMEOUT_MS, windowsHide: true },
    );
    return { gpus: parseGpuLiveSamples(stdout), reason: null };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      gpuProbeDisabledReason =
        "nvidia-smi is not on PATH, so live GPU load is unavailable on this machine.";
      logger.info("Live GPU telemetry disabled: nvidia-smi not found.");
    }
    return {
      gpus: [],
      reason:
        gpuProbeDisabledReason ??
        `nvidia-smi failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function collect(): Promise<LiveTelemetrySample> {
  const { gpus, reason } = await probeGpus();
  const currentCpu = readCpuTimes();
  const load = computeCpuLoad(previousCpuTimes, currentCpu);
  previousCpuTimes = currentCpu;

  const totalMb = Math.round(os.totalmem() / (1024 * 1024));
  const freeMb = Math.round(os.freemem() / (1024 * 1024));
  const usedMb = Math.max(0, totalMb - freeMb);
  const [loadAverage] = os.loadavg();

  return {
    capturedAt: Date.now(),
    gpus,
    gpuUnavailableReason: reason,
    cpu: {
      percent: load.percent,
      perCore: load.perCore,
      cores: currentCpu.total.length,
      // `os.loadavg()` is documented as returning zeroes on Windows; reporting
      // 0.00 there would read as an idle machine rather than "not measured".
      loadAverage: loadAverage > 0 ? Math.round(loadAverage * 100) / 100 : null,
    },
    memory: {
      usedMb,
      totalMb,
      percent: totalMb > 0 ? clampPercent((usedMb / totalMb) * 100) : 0,
      processRssMb: Math.round(process.memoryUsage.rss() / (1024 * 1024)),
    },
  };
}

/**
 * One live sample, shared between concurrent callers.
 *
 * The in-flight promise is deduped as well as the result: without it, two
 * surfaces mounting on the same frame each spawn `nvidia-smi` before either
 * populates the cache.
 */
export async function sampleLiveTelemetry(): Promise<LiveTelemetrySample> {
  if (cachedSample && Date.now() - cachedSample.capturedAt < SAMPLE_CACHE_MS) {
    return cachedSample;
  }
  inFlight ??= collect()
    .then((sample) => {
      cachedSample = sample;
      return sample;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Record one completed model call. Called by every brain that runs inference. */
export function recordInferenceSample(
  sample: Omit<InferenceSample, "timestamp"> & { timestamp?: number },
): void {
  inferenceSamples.push({
    ...sample,
    timestamp: sample.timestamp ?? Date.now(),
  });
  if (inferenceSamples.length > MAX_INFERENCE_SAMPLES) {
    inferenceSamples.splice(0, inferenceSamples.length - MAX_INFERENCE_SAMPLES);
  }
}

export function getInferenceTelemetry(): InferenceTelemetry {
  return summariseInference(inferenceSamples);
}

export function _resetLiveTelemetryForTests(): void {
  cachedSample = null;
  inFlight = null;
  previousCpuTimes = null;
  gpuProbeDisabledReason = null;
  inferenceSamples.length = 0;
}
