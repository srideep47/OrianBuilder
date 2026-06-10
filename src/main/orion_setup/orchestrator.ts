import path from "node:path";
import fs from "node:fs/promises";
import log from "electron-log";
import { getUserDataPath } from "@/paths/paths";
import type {
  OrionSetupState,
  OrionSetupStep,
  OrionSetupStepId,
} from "@/ipc/types/orion_setup";

// =============================================================================
// Orion Setup orchestrator — one persisted, resumable state machine that
// provisions everything the auto content-creation pipeline needs.
// =============================================================================
//
// Mirrors the media queue (main/media_queue/queue.ts): every state transition is
// written to one JSON file, so a setup interrupted by a crash, an app restart,
// or a dropped connection resumes from where it left off rather than starting
// over. The heavy/network steps are idempotent and re-derive truth from the live
// backend status, so already-finished work (installed deps, downloaded weights)
// is detected and skipped. All backend calls are injected (`OrionSetupDeps`) so
// the state machine is unit-testable without touching Python, HF, or the GPU.
// =============================================================================

const logger = log.scope("orion-setup");

const MAX_LOG_LINES = 80;
/** Transient steps get a few attempts with backoff before they fail for good. */
const DEFAULT_ATTEMPTS = 3;

/** Backend calls the orchestrator drives; real impls wired in the IPC handler. */
export interface OrionSetupDeps {
  /** Detect GPU + best media backend. Returns the backend id and a UI summary. */
  refreshHardware: () => Promise<{ backend: string; summary: string }>;
  /** Live media-backend status (venv/deps/health + which model ids are on disk). */
  getMediaStatus: () => Promise<{
    venvExists: boolean;
    depsInstalled: boolean;
    healthy: boolean;
    downloadedModelIds: string[];
  }>;
  /** Which model weights still need downloading for the user's selection. */
  resolveModelPlan: (
    downloadedModelIds: string[],
  ) => { id: string; label: string }[];
  /** Install the Python venv + GPU-matched libraries (incl. ffmpeg). */
  installDeps: (backend: string) => Promise<void>;
  /** Download one model id, streaming raw log chunks (used to surface %). */
  downloadModel: (id: string, onLog: (chunk: string) => void) => Promise<void>;
  /** Start the media backend process. */
  startBackend: () => Promise<void>;
  /** Poll until the backend answers health checks (or time out). */
  waitHealthy: (timeoutMs: number) => Promise<boolean>;
  /** True when a local Engine GGUF is configured AND present on disk. */
  detectEngineModel: () => boolean;
  /** Join the Orion network + persist the preference. */
  enableNetwork: () => Promise<void>;
  /** Fired on every state change so the handler can push a `progress` event. */
  onUpdate: (state: OrionSetupState) => void;
}

const STEP_LABELS: Record<OrionSetupStepId, string> = {
  hardware: "Detect hardware",
  "media-deps": "Install media backend",
  "media-models": "Download media models",
  "start-backend": "Start media backend",
  "engine-model": "Local language model",
  p2p: "Pair a teammate (P2P)",
};

function stateFile(): string {
  return path.join(getUserDataPath(), "orion-setup", "state.json");
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class OrionSetupOrchestrator {
  private state: OrionSetupState;
  private deps: OrionSetupDeps | null = null;
  private running = false;
  private cancelRequested = false;
  private loaded = false;

  constructor() {
    this.state = this.freshState(true, true);
  }

  setDeps(deps: OrionSetupDeps): void {
    this.deps = deps;
  }

  /** Load persisted state; a step caught mid-run by a crash goes back to pending. */
  async init(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await fs.readFile(stateFile(), "utf-8");
      const parsed = JSON.parse(raw) as OrionSetupState;
      for (const step of parsed.steps) {
        if (step.status === "running") {
          step.status = "pending";
          step.percent = undefined;
        }
      }
      // A run that was interrupted shows as resumable, not still-running.
      if (parsed.overall === "running") parsed.overall = "paused";
      this.state = parsed;
      logger.info(`loaded persisted setup state (overall=${parsed.overall})`);
    } catch {
      // No state yet — keep the fresh idle state.
    }
  }

  getState(): OrionSetupState {
    return structuredClone(this.state);
  }

  /** Begin a full setup, rebuilding the step list from the chosen scope. */
  async start(params: {
    includeEngine: boolean;
    includeP2p: boolean;
  }): Promise<OrionSetupState> {
    await this.init();
    if (this.running) return this.getState();
    this.state = this.freshState(params.includeEngine, params.includeP2p);
    this.state.startedAt = Date.now();
    this.appendLog("Starting Orion setup…");
    this.touch();
    void this.run(new Set(this.state.steps.map((s) => s.id)));
    return this.getState();
  }

  /** Continue an interrupted setup: re-derive what's already done, run the rest. */
  async resume(): Promise<OrionSetupState> {
    await this.init();
    if (this.running) return this.getState();
    if (!this.state.startedAt) {
      // Nothing was ever started — treat resume as a default start.
      return this.start({
        includeEngine: this.state.includeEngine,
        includeP2p: this.state.includeP2p,
      });
    }
    await this.reconcile();
    this.appendLog("Resuming Orion setup…");
    const toRun = new Set(
      this.state.steps
        .filter((s) => s.status !== "done" && s.status !== "skipped")
        .map((s) => s.id),
    );
    this.touch();
    void this.run(toRun);
    return this.getState();
  }

  /** Stop after the current step; the run can be resumed later. */
  async cancel(): Promise<OrionSetupState> {
    this.cancelRequested = true;
    this.appendLog("Cancelling… (finishing the current step)");
    this.touch();
    return this.getState();
  }

  async retryStep(stepId: OrionSetupStepId): Promise<OrionSetupState> {
    await this.init();
    if (this.running) return this.getState();
    const step = this.state.steps.find((s) => s.id === stepId);
    if (step) {
      step.status = "pending";
      step.error = undefined;
      step.percent = undefined;
    }
    this.touch();
    void this.run(new Set([stepId]));
    return this.getState();
  }

  async skipStep(stepId: OrionSetupStepId): Promise<OrionSetupState> {
    await this.init();
    const step = this.state.steps.find((s) => s.id === stepId);
    if (step && !step.required) {
      step.status = "skipped";
      step.error = undefined;
    }
    this.recomputeOverall();
    this.touch();
    return this.getState();
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private freshState(
    includeEngine: boolean,
    includeP2p: boolean,
  ): OrionSetupState {
    const make = (
      id: OrionSetupStepId,
      required: boolean,
      enabled: boolean,
    ): OrionSetupStep => ({
      id,
      label: STEP_LABELS[id],
      required,
      status: enabled ? "pending" : "skipped",
    });
    return {
      overall: "idle",
      includeEngine,
      includeP2p,
      log: [],
      steps: [
        make("hardware", true, true),
        make("media-deps", true, true),
        make("media-models", true, true),
        make("start-backend", true, true),
        make("engine-model", false, includeEngine),
        make("p2p", false, includeP2p),
      ],
    };
  }

  private appendLog(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    this.state.log.push(trimmed);
    if (this.state.log.length > MAX_LOG_LINES) {
      this.state.log = this.state.log.slice(-MAX_LOG_LINES);
    }
  }

  private touch(): void {
    this.state.updatedAt = Date.now();
    void this.persist();
    this.deps?.onUpdate(this.getState());
  }

  private async persist(): Promise<void> {
    try {
      const file = stateFile();
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify(this.state), "utf-8");
    } catch (err) {
      logger.warn("failed to persist orion setup state", err);
    }
  }

  private recomputeOverall(): void {
    const required = this.state.steps.filter((s) => s.required);
    const allRequiredDone = required.every(
      (s) => s.status === "done" || s.status === "skipped",
    );
    if (this.running) {
      this.state.overall = "running";
    } else if (allRequiredDone) {
      this.state.overall = "completed";
    } else if (this.state.startedAt) {
      this.state.overall = "paused";
    } else {
      this.state.overall = "idle";
    }
  }

  /** Re-derive done-ness of long steps from the live backend before resuming. */
  private async reconcile(): Promise<void> {
    if (!this.deps) return;
    try {
      const st = await this.deps.getMediaStatus();
      this.setStatus(
        "media-deps",
        st.venvExists && st.depsInstalled ? "done" : "pending",
      );
      const plan = this.deps.resolveModelPlan(st.downloadedModelIds);
      this.setStatus("media-models", plan.length === 0 ? "done" : "pending");
      this.setStatus("start-backend", st.healthy ? "done" : "pending");
    } catch (err) {
      logger.warn("reconcile: media status probe failed", err);
    }
    if (this.state.includeEngine) {
      this.setStatus(
        "engine-model",
        this.deps.detectEngineModel() ? "done" : "needs-action",
      );
    }
  }

  private setStatus(id: OrionSetupStepId, status: OrionSetupStep["status"]) {
    const step = this.state.steps.find((s) => s.id === id);
    // Never downgrade a finished step back to pending during reconcile.
    if (step && !(status === "pending" && step.status === "done")) {
      step.status = status;
    }
  }

  private async run(stepIds: Set<OrionSetupStepId>): Promise<void> {
    if (!this.deps || this.running) return;
    this.running = true;
    this.cancelRequested = false;
    this.recomputeOverall();
    this.touch();
    try {
      for (const step of this.state.steps) {
        if (this.cancelRequested) break;
        if (!stepIds.has(step.id)) continue;
        // `hardware` always re-runs (cheap; refreshes the backend id); others
        // skip if already satisfied.
        if (
          step.id !== "hardware" &&
          (step.status === "done" || step.status === "skipped")
        ) {
          continue;
        }
        await this.runStep(step);
        // A failed REQUIRED step pauses the whole run (user resumes/retries).
        // Optional steps (engine/p2p) never block; the loop continues.
        if (step.status === "failed" && step.required) break;
      }
    } finally {
      this.running = false;
      this.cancelRequested = false;
      this.recomputeOverall();
      if (this.state.overall === "completed") {
        this.appendLog("Orion is ready.");
      }
      this.touch();
    }
  }

  private async runStep(step: OrionSetupStep): Promise<void> {
    const deps = this.deps!;
    step.status = "running";
    step.error = undefined;
    this.touch();
    try {
      switch (step.id) {
        case "hardware": {
          const hw = await this.withRetry("hardware", () =>
            deps.refreshHardware(),
          );
          this.state.backend = hw.backend;
          this.state.hardwareSummary = hw.summary;
          step.detail = hw.summary;
          this.appendLog(`Hardware: ${hw.summary}`);
          step.status = "done";
          break;
        }
        case "media-deps": {
          const st = await deps.getMediaStatus();
          if (st.venvExists && st.depsInstalled) {
            step.detail = "Already installed";
            step.status = "done";
            break;
          }
          const backend = this.state.backend ?? "cpu";
          step.detail = `Installing Python libraries (${backend})…`;
          this.appendLog(step.detail);
          this.touch();
          await this.withRetry("media-deps", () => deps.installDeps(backend));
          step.detail = "Installed";
          step.status = "done";
          break;
        }
        case "media-models": {
          const st = await deps.getMediaStatus();
          const plan = deps.resolveModelPlan(st.downloadedModelIds);
          if (plan.length === 0) {
            step.detail = "All models present";
            step.status = "done";
            break;
          }
          for (let i = 0; i < plan.length; i++) {
            if (this.cancelRequested) {
              step.status = "pending";
              return;
            }
            const model = plan[i];
            step.detail = `${model.label} (${i + 1}/${plan.length})`;
            step.percent = 0;
            this.appendLog(`Downloading ${model.label}…`);
            this.touch();
            await this.withRetry("media-models", () =>
              deps.downloadModel(model.id, (chunk) =>
                this.onDownloadLog(step, chunk),
              ),
            );
            this.appendLog(`✓ ${model.label}`);
          }
          step.percent = 100;
          step.detail = "All models downloaded";
          step.status = "done";
          break;
        }
        case "start-backend": {
          step.detail = "Starting…";
          this.touch();
          await this.withRetry("start-backend", async () => {
            await deps.startBackend();
            const ok = await deps.waitHealthy(60_000);
            if (!ok) throw new Error("backend did not become healthy in time");
          });
          step.detail = "Healthy";
          step.status = "done";
          break;
        }
        case "engine-model": {
          if (deps.detectEngineModel()) {
            step.detail = "Model configured";
            step.status = "done";
          } else {
            step.detail = "Pick a local language model in the Engine page";
            step.actionRoute = "/inference";
            step.status = "needs-action";
          }
          break;
        }
        case "p2p": {
          await deps.enableNetwork().catch((err) => {
            logger.warn("enableNetwork failed", err);
          });
          step.detail = "Network on — generate an invite or redeem one to pair";
          step.actionRoute = "/network";
          step.status = "needs-action";
          break;
        }
      }
    } catch (err) {
      step.status = "failed";
      step.error = err instanceof Error ? err.message : String(err);
      step.percent = undefined;
      this.appendLog(`✗ ${step.label}: ${step.error}`);
      logger.error(`step ${step.id} failed: ${step.error}`);
    }
    this.touch();
  }

  /** Parse the media download script's `{"type":"progress","percentage":N}`
   *  lines into the step's percent; keep human lines in the activity log. */
  private onDownloadLog(step: OrionSetupStep, chunk: string): void {
    let changed = false;
    for (const line of chunk.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const pct = this.extractPercent(trimmed);
      if (pct != null) {
        step.percent = pct;
        changed = true;
      } else if (trimmed.length < 200) {
        this.appendLog(trimmed);
        changed = true;
      }
    }
    if (changed) this.touch();
  }

  private extractPercent(line: string): number | null {
    if (line.includes("percentage")) {
      try {
        const obj = JSON.parse(line) as { percentage?: unknown };
        if (typeof obj.percentage === "number") {
          return Math.max(0, Math.min(100, Math.round(obj.percentage)));
        }
      } catch {
        /* not JSON — fall through */
      }
    }
    const m = line.match(/(\d{1,3})\s*%/);
    if (m) return Math.max(0, Math.min(100, parseInt(m[1], 10)));
    return null;
  }

  private async withRetry<T>(
    label: string,
    fn: () => Promise<T>,
    attempts = DEFAULT_ATTEMPTS,
  ): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (this.cancelRequested) throw new Error("cancelled");
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (this.cancelRequested || attempt === attempts) break;
        const backoffMs = 1000 * 2 ** (attempt - 1);
        const msg = err instanceof Error ? err.message : String(err);
        this.appendLog(
          `${label}: attempt ${attempt} failed (${msg}); retrying in ${backoffMs / 1000}s…`,
        );
        this.touch();
        await sleep(backoffMs);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}

let singleton: OrionSetupOrchestrator | null = null;

export function getOrionSetupOrchestrator(): OrionSetupOrchestrator {
  if (!singleton) singleton = new OrionSetupOrchestrator();
  return singleton;
}

/** Test-only: reset the singleton between tests. */
export function _resetOrionSetupOrchestratorForTests(): void {
  singleton = null;
}
