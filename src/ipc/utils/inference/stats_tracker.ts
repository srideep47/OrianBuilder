import os from "node:os";

export type InferenceState =
  | "idle"
  | "loading"
  | "prefilling"
  | "generating"
  | "thinking"
  | "tool_calling";

export interface InferenceStats {
  state: InferenceState;
  operation: string;
  backend: "none" | "llama-cpp" | "tensorrt-native";
  liveTps: number;
  avgTps: number;
  prefillTps: number;
  prefillComplete: boolean;
  promptTokens: number;
  prefillDurationMs: number;
  decodeTps: number;
  recentDecodeTps: number;
  peakTps: number;
  lowestTps: number;
  tokensGenerated: number;
  sessionDurationMs: number;
  totalSessions: number;
  totalTokensAllTime: number;
  processCpuPercent: number;
  systemRamUsedMb: number;
  systemRamTotalMb: number;
}

export interface InferenceLogEntry {
  ts: number;
  level: "info" | "warn" | "error";
  msg: string;
}

type StatsListener = (s: InferenceStats) => void;
type LogListener = (e: InferenceLogEntry) => void;

const LOG_RING_SIZE = 200;
const TPS_WINDOW_SECONDS = 3;
const EMA_ALPHA = 0.3;
const MIN_DECODE_SAMPLES = 3;
const NUM_CORES = os.cpus().length || 1;

interface TpsBucket {
  ts: number;
  count: number;
}

class StatsTracker {
  private statsListeners = new Set<StatsListener>();
  private logListeners = new Set<LogListener>();
  private logRingBuffer: InferenceLogEntry[] = [];

  private tpsBuckets: TpsBucket[] = [];
  private sessionStart = 0;
  private prefillStart = 0;
  private firstTokenAt = 0;
  private currentPromptTokens = 0;
  private currentPrefillDurationMs = 0;
  private sessionTokens = 0;
  private sessionPeakTps = 0;
  private sessionLowestTps = Infinity;
  private allTimeTotalTokens = 0;
  private allTimeTotalSessions = 0;

  private lastDecodeTokenAt = 0;
  private emaInterTokenMs = 0;
  private decodeTokenCount = 0;

  private sysCpuLastUsage: NodeJS.CpuUsage | null = null;
  private sysCpuLastTs: number | null = null;
  private sysCpuPercent = 0;

  private statsBroadcastTimer: NodeJS.Timeout | null = null;
  private hardwareBroadcastTimer: NodeJS.Timeout | null = null;

  private inferenceState: InferenceState = "idle";
  private inferenceOperation = "";

  // Backend is owned by model state; stats tracker mirrors it for display.
  private backend: "none" | "llama-cpp" | "tensorrt-native" = "none";

  setBackend(b: "none" | "llama-cpp" | "tensorrt-native"): void {
    this.backend = b;
  }

  getInferenceState(): InferenceState {
    return this.inferenceState;
  }

  // ─── Listeners ─────────────────────────────────────────────────────────────

  addStatsListener(fn: StatsListener): () => void {
    this.statsListeners.add(fn);
    return () => this.statsListeners.delete(fn);
  }

  addLogListener(fn: LogListener): () => void {
    this.logListeners.add(fn);
    return () => this.logListeners.delete(fn);
  }

  getRecentLogs(): InferenceLogEntry[] {
    return [...this.logRingBuffer];
  }

  emitLog(level: InferenceLogEntry["level"], msg: string): void {
    const entry: InferenceLogEntry = { ts: Date.now(), level, msg };
    this.logRingBuffer.push(entry);
    if (this.logRingBuffer.length > LOG_RING_SIZE) this.logRingBuffer.shift();
    for (const fn of this.logListeners) fn(entry);
  }

  // ─── Stats snapshot ─────────────────────────────────────────────────────────

  getCurrentStats(): InferenceStats {
    const liveTps = this.computeLiveTps();
    const sessionDurationMs =
      this.sessionStart > 0 ? Date.now() - this.sessionStart : 0;
    const avgTps =
      sessionDurationMs > 0
        ? (this.sessionTokens / sessionDurationMs) * 1000
        : 0;

    const prefillComplete = this.firstTokenAt > 0;
    const activePrefillMs = prefillComplete
      ? this.currentPrefillDurationMs
      : this.prefillStart > 0
        ? Date.now() - this.prefillStart
        : 0;
    const prefillTps =
      prefillComplete &&
      this.currentPromptTokens > 0 &&
      this.currentPrefillDurationMs > 0
        ? (this.currentPromptTokens / this.currentPrefillDurationMs) * 1000
        : 0;

    const decodeMs =
      this.firstTokenAt > 0 ? Math.max(1, Date.now() - this.firstTokenAt) : 0;
    const decodeTps =
      this.sessionTokens > 0 && decodeMs > 0
        ? (this.sessionTokens / decodeMs) * 1000
        : 0;

    const recentDecodeTps =
      this.decodeTokenCount >= MIN_DECODE_SAMPLES && this.emaInterTokenMs > 0
        ? 1000 / this.emaInterTokenMs
        : 0;

    const processCpuPercent = this.sampleProcessCpu();
    const systemRamTotalMb = Math.round(os.totalmem() / (1024 * 1024));
    const systemRamUsedMb = Math.round(
      (os.totalmem() - os.freemem()) / (1024 * 1024),
    );

    return {
      state: this.inferenceState,
      operation: this.inferenceOperation,
      backend: this.backend,
      liveTps,
      avgTps,
      prefillTps,
      prefillComplete,
      promptTokens: this.currentPromptTokens,
      prefillDurationMs: activePrefillMs,
      decodeTps,
      recentDecodeTps,
      peakTps: this.sessionPeakTps,
      lowestTps: this.sessionLowestTps === Infinity ? 0 : this.sessionLowestTps,
      tokensGenerated: this.sessionTokens,
      sessionDurationMs,
      totalSessions: this.allTimeTotalSessions,
      totalTokensAllTime: this.allTimeTotalTokens,
      processCpuPercent,
      systemRamUsedMb,
      systemRamTotalMb,
    };
  }

  // ─── CPU sampling ───────────────────────────────────────────────────────────

  private sampleProcessCpu(): number {
    const now = Date.now();
    const cur = process.cpuUsage();
    if (this.sysCpuLastUsage && this.sysCpuLastTs) {
      const elapsedUs = (now - this.sysCpuLastTs) * 1000;
      if (elapsedUs > 0) {
        const cpuUs =
          cur.user -
          this.sysCpuLastUsage.user +
          (cur.system - this.sysCpuLastUsage.system);
        const rawPercent = (cpuUs / elapsedUs) * 100;
        this.sysCpuPercent = Math.round(Math.min(100, rawPercent / NUM_CORES));
      }
    }
    this.sysCpuLastUsage = cur;
    this.sysCpuLastTs = now;
    return this.sysCpuPercent;
  }

  // ─── Hardware broadcast (always-on 2 s interval) ────────────────────────────

  startHardwareBroadcast(): void {
    if (this.hardwareBroadcastTimer) return;
    this.sampleProcessCpu(); // prime baseline so first reading is accurate
    this.hardwareBroadcastTimer = setInterval(
      () => this.broadcastStats(),
      2000,
    );
  }

  stopHardwareBroadcast(): void {
    if (this.hardwareBroadcastTimer) {
      clearInterval(this.hardwareBroadcastTimer);
      this.hardwareBroadcastTimer = null;
    }
  }

  // ─── Inference state ────────────────────────────────────────────────────────

  setState(s: InferenceState, op = ""): void {
    this.inferenceState = s;
    this.inferenceOperation = op;
    this.broadcastStats();
  }

  private broadcastStats(): void {
    if (this.statsListeners.size === 0) return;
    const snap = this.getCurrentStats();
    for (const fn of this.statsListeners) fn(snap);
  }

  private startStatsBroadcast(): void {
    if (this.statsBroadcastTimer) return;
    this.statsBroadcastTimer = setInterval(() => this.broadcastStats(), 250);
  }

  stopStatsBroadcast(): void {
    if (this.statsBroadcastTimer) {
      clearInterval(this.statsBroadcastTimer);
      this.statsBroadcastTimer = null;
    }
    this.setState("idle", "");
    this.broadcastStats();
  }

  // ─── Session lifecycle ──────────────────────────────────────────────────────

  beginSession(promptTokens: number): void {
    this.sessionStart = Date.now();
    this.prefillStart = this.sessionStart;
    this.firstTokenAt = 0;
    this.currentPromptTokens = promptTokens;
    this.currentPrefillDurationMs = 0;
    this.sessionTokens = 0;
    this.sessionPeakTps = 0;
    this.sessionLowestTps = Infinity;
    this.tpsBuckets = [];
    this.lastDecodeTokenAt = 0;
    this.emaInterTokenMs = 0;
    this.decodeTokenCount = 0;
    this.allTimeTotalSessions++;
    this.startStatsBroadcast();
  }

  // ─── Token accounting ───────────────────────────────────────────────────────

  recordToken(): void {
    const now = Date.now();
    if (this.firstTokenAt === 0 && this.prefillStart > 0) {
      this.firstTokenAt = now;
      this.currentPrefillDurationMs = Math.max(
        1,
        this.firstTokenAt - this.prefillStart,
      );
      this.lastDecodeTokenAt = now;
      this.decodeTokenCount = 0;
      this.emaInterTokenMs = 0;
    } else if (this.lastDecodeTokenAt > 0) {
      const delta = now - this.lastDecodeTokenAt;
      if (delta > 0) {
        this.emaInterTokenMs =
          this.decodeTokenCount < MIN_DECODE_SAMPLES
            ? this.emaInterTokenMs === 0
              ? delta
              : (this.emaInterTokenMs * this.decodeTokenCount + delta) /
                (this.decodeTokenCount + 1)
            : EMA_ALPHA * delta + (1 - EMA_ALPHA) * this.emaInterTokenMs;
      }
      this.lastDecodeTokenAt = now;
      this.decodeTokenCount++;
    }
    this.sessionTokens++;
    this.allTimeTotalTokens++;

    if (
      this.tpsBuckets.length === 0 ||
      now - this.tpsBuckets[this.tpsBuckets.length - 1].ts > 500
    ) {
      this.tpsBuckets.push({ ts: now, count: 1 });
    } else {
      this.tpsBuckets[this.tpsBuckets.length - 1].count++;
    }

    const live = this.computeLiveTps();
    if (live > this.sessionPeakTps) this.sessionPeakTps = live;
    if (live > 0 && live < this.sessionLowestTps) this.sessionLowestTps = live;
  }

  recordTokenCount(count: number): void {
    for (let i = 0; i < Math.max(0, count); i++) this.recordToken();
  }

  private computeLiveTps(): number {
    const cutoff = Date.now() - TPS_WINDOW_SECONDS * 1000;
    this.tpsBuckets = this.tpsBuckets.filter((b) => b.ts >= cutoff);
    const total = this.tpsBuckets.reduce((s, b) => s + b.count, 0);
    const windowMs =
      this.tpsBuckets.length > 0
        ? Math.max(1, Date.now() - this.tpsBuckets[0].ts)
        : TPS_WINDOW_SECONDS * 1000;
    return total > 0 ? (total / windowMs) * 1000 : 0;
  }
}

export const statsTracker = new StatsTracker();
