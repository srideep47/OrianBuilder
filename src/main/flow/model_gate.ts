import log from "electron-log";

// =============================================================================
// Orion Orchestrated Pipeline — Single-Resident Model Gate
// =============================================================================
//
// Enforces the core invariant: AT MOST ONE model/pipeline is resident in VRAM at
// any moment, across BOTH the embedded LLM server and the media backend. This is
// what makes batch-by-modality work — `enter()` the image model once, generate
// many images, then `enter()` the video model (which unloads images first).
//
// Distinct from `model_lease.ts` (an N-model VRAM-budgeted scheduler kept for
// future co-residency needs): the gate is deliberately a single slot, because
// this pipeline never wants two pipelines live at once (ACE-Step alone is 12 GB
// of a 16 GB card). Multiple loads WITHIN a stage (3D = image-ref then TripoSR)
// are just sequential `enter()` calls.
//
// Real load/unload is delegated to pluggable hooks so the gate stays free of
// backend specifics and fully unit-testable. All operations are serialized.
// See plans/orion-orchestrated-pipeline.md.
// =============================================================================

const logger = log.scope("model-gate");

export type ModelKind = "llm" | "image" | "video" | "music" | "3d";

/** A model the gate can make resident. `modelId` identifies the no-op case
 *  (entering the already-resident model does not reload it). */
export interface ResidentSlot {
  kind: ModelKind;
  modelId: string;
  /** Single-slot VRAM footprint in MB (bookkeeping/telemetry). */
  vramMb: number;
}

export interface ModelGateHooks {
  /** Bring `slot` into VRAM. Called only when no other model is resident. */
  load: (slot: ResidentSlot) => Promise<void>;
  /** Evict `slot` from VRAM. */
  unload: (slot: ResidentSlot) => Promise<void>;
}

function sameSlot(a: ResidentSlot | null, b: ResidentSlot): boolean {
  return a != null && a.kind === b.kind && a.modelId === b.modelId;
}

export class ModelGate {
  private current: ResidentSlot | null = null;
  private hooks: ModelGateHooks | null = null;
  /** Serializes enter/exit so the single-resident invariant can't race. */
  private queue: Promise<unknown> = Promise.resolve();

  setHooks(hooks: ModelGateHooks): void {
    this.hooks = hooks;
  }

  /** The currently resident model, or null when idle. */
  getResident(): ResidentSlot | null {
    return this.current;
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * Ensure `slot` is the single resident model, unloading whatever else is
   * resident first. No-op when `slot` is already resident (this is the batch
   * win — re-entering the same model never reloads it). When hooks are not set,
   * the gate updates bookkeeping only so higher layers degrade gracefully.
   */
  enter(slot: ResidentSlot): Promise<void> {
    return this.run(async () => {
      if (sameSlot(this.current, slot)) {
        logger.debug(`enter ${slot.kind}:${slot.modelId} (already resident)`);
        return;
      }
      if (this.current) {
        logger.info(`unload ${this.current.kind}:${this.current.modelId}`);
        if (this.hooks) await this.hooks.unload(this.current);
        this.current = null;
      }
      logger.info(`load ${slot.kind}:${slot.modelId} (${slot.vramMb} MB)`);
      if (this.hooks) await this.hooks.load(slot);
      this.current = slot;
    });
  }

  /** Unload the resident model (if any) → idle. Safe to call when idle. */
  exit(): Promise<void> {
    return this.run(async () => {
      if (!this.current) return;
      logger.info(`exit: unload ${this.current.kind}:${this.current.modelId}`);
      if (this.hooks) await this.hooks.unload(this.current);
      this.current = null;
    });
  }

  /**
   * Make `slot` resident, run `fn`, and leave `slot` resident afterwards. Use
   * this for a whole modality batch: the model stays loaded across every asset
   * in the batch; the orchestrator calls `enter()`/`exit()` to move between
   * stages. Errors in `fn` propagate but the model is left resident (the next
   * `enter()` will swap it out cleanly).
   */
  async with<T>(slot: ResidentSlot, fn: () => Promise<T>): Promise<T> {
    await this.enter(slot);
    return fn();
  }
}

// ─── Singleton ───────────────────────────────────────────────────────────────

let singleton: ModelGate | null = null;

export function getModelGate(): ModelGate {
  if (!singleton) singleton = new ModelGate();
  return singleton;
}

/** Test-only: reset the singleton between tests. */
export function _resetModelGateForTests(): void {
  singleton = null;
}
