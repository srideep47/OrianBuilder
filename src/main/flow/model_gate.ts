import log from "electron-log";
import type { SwapEvent } from "@/ipc/types/intent";

// =============================================================================
// Orion Orchestrated Pipeline — Single-Resident Model Gate
// =============================================================================
//
// Enforces the core invariant: AT MOST ONE model/pipeline is resident in VRAM at
// any moment, across BOTH the embedded LLM server and the media backend. This is
// what makes batch-by-modality work — `enter()` the image model once, generate
// many images, then `enter()` the video model (which unloads images first).
//
// The gate is deliberately a single slot: Orion prioritizes reliable operation
// on consumer hardware over speculative model co-residency (ACE-Step alone can
// occupy 12 GB of a 16 GB card). Multiple loads within a stage are represented
// as explicit sequential slots.
//
// Real load/unload is delegated to pluggable hooks so the gate stays free of
// backend specifics and fully unit-testable. All operations are serialized.
// See plans/orion-orchestrated-pipeline.md.
// =============================================================================

const logger = log.scope("model-gate");

export type ModelKind = "llm" | "image" | "video" | "music" | "speech" | "3d";

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

class ModelOperationCleanupError extends Error {
  readonly operationError: unknown;
  readonly cleanupError: unknown;

  constructor(
    slot: ResidentSlot,
    operationError: unknown,
    cleanupError: unknown,
  ) {
    super(
      `Model operation and cleanup both failed for ${slot.kind}:${slot.modelId}`,
    );
    this.name = "ModelOperationCleanupError";
    this.operationError = operationError;
    this.cleanupError = cleanupError;
  }
}

export class ModelGate {
  private current: ResidentSlot | null = null;
  private hooks: ModelGateHooks | null = null;
  private swapEvents: SwapEvent[] = [];
  /**
   * Serializes both residency changes and the work performed while a model is
   * resident. Holding this queue for `with()` is important: serializing only
   * load/unload calls would still allow another flow to swap the model while a
   * generation is in progress.
   */
  private queue: Promise<unknown> = Promise.resolve();

  setHooks(hooks: ModelGateHooks): void {
    this.hooks = hooks;
  }

  /** The currently resident model, or null when idle. */
  getResident(): ResidentSlot | null {
    return this.current;
  }

  /** Return and clear swap timings since the previous drain. */
  drainSwapTelemetry(): SwapEvent[] {
    const events = this.swapEvents;
    this.swapEvents = [];
    return events;
  }

  private async unloadCurrent(slot: ResidentSlot): Promise<void> {
    const started = Date.now();
    if (this.hooks) await this.hooks.unload(slot);
    this.swapEvents.push({
      kind: "unload",
      key: `${slot.kind}:${slot.modelId}`,
      durationMs: Date.now() - started,
    });
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
  private async enterExclusive(slot: ResidentSlot): Promise<void> {
    if (sameSlot(this.current, slot)) {
      logger.debug(`enter ${slot.kind}:${slot.modelId} (already resident)`);
      return;
    }
    if (this.current) {
      logger.info(`unload ${this.current.kind}:${this.current.modelId}`);
      await this.unloadCurrent(this.current);
      this.current = null;
    }
    logger.info(`load ${slot.kind}:${slot.modelId} (${slot.vramMb} MB)`);
    const started = Date.now();
    if (this.hooks) await this.hooks.load(slot);
    this.swapEvents.push({
      kind: "load",
      key: `${slot.kind}:${slot.modelId}`,
      durationMs: Date.now() - started,
    });
    this.current = slot;
  }

  enter(slot: ResidentSlot): Promise<void> {
    return this.run(() => this.enterExclusive(slot));
  }

  /** Unload the resident model (if any) → idle. Safe to call when idle. */
  exit(): Promise<void> {
    return this.run(async () => {
      if (!this.current) return;
      logger.info(`exit: unload ${this.current.kind}:${this.current.modelId}`);
      await this.unloadCurrent(this.current);
      this.current = null;
    });
  }

  /**
   * Make `slot` resident, run `fn`, and leave `slot` resident after success. Use
   * this for a whole modality batch: the model stays loaded across every asset
   * in the batch; the orchestrator calls `enter()`/`exit()` to move between
   * stages. A failed or cancelled operation is different: evict immediately so
   * a long-running autonomous session never strands VRAM after an exception.
   */
  with<T>(slot: ResidentSlot, fn: () => Promise<T>): Promise<T> {
    return this.run(async () => {
      await this.enterExclusive(slot);
      try {
        return await fn();
      } catch (workError) {
        // Only unload the slot acquired by this call. The queue makes a
        // concurrent swap impossible, but the identity check keeps this logic
        // correct if the implementation changes later.
        if (sameSlot(this.current, slot)) {
          try {
            logger.info(
              `operation failed: unload ${slot.kind}:${slot.modelId}`,
            );
            await this.unloadCurrent(slot);
            this.current = null;
          } catch (cleanupError) {
            logger.error(
              `failed to unload ${slot.kind}:${slot.modelId} after operation error`,
              cleanupError,
            );
            throw new ModelOperationCleanupError(slot, workError, cleanupError);
          }
        }
        throw workError;
      }
    });
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
