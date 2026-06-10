import log from "electron-log";
import type { SwapEvent } from "@/ipc/types/intent";

// =============================================================================
// Orion Unification - N-Model Lease Scheduler (Phase 2)
// =============================================================================
//
// Generalizes the 2-way (LLM ↔ media) `model_orchestrator` into a VRAM-budgeted
// scheduler that can keep several models resident at once and evict the least
// valuable ones when a new model needs room. The existing orchestrator keeps
// driving the embedded-LLM ↔ media swap; this scheduler is additive and is the
// foundation for chaining many capabilities that each need different models.
//
// Real load/unload is delegated to pluggable hooks so this module stays free of
// backend specifics and fully unit-testable. The eviction planner is a pure
// function (`planEvictions`) exported for tests.
// =============================================================================

const logger = log.scope("model-lease");

export interface ModelSpec {
  /** Stable identifier, e.g. "embedded:qwen2.5-7b" or "media:sd-turbo". */
  key: string;
  /** Estimated VRAM footprint in MB. */
  vramMb: number;
  /** Higher priority models are evicted last. Default 0. */
  priority?: number;
  /** Pinned models are never evicted automatically. Default false. */
  pinned?: boolean;
}

export interface ResidentModel extends Required<ModelSpec> {
  /** Monotonic counter of last acquisition; higher = more recently used. */
  lastUsedTick: number;
  /** Active lease count. Models with leases > 0 are never evicted. */
  leases: number;
}

export interface ModelLeaseHooks {
  /** Load a model into VRAM. */
  load: (spec: ModelSpec) => Promise<void>;
  /** Unload a model from VRAM. */
  unload: (key: string) => Promise<void>;
  /** Returns currently free VRAM in MB. */
  availableVramMb: () => Promise<number>;
}

export interface Lease {
  key: string;
  release: () => void;
}

// Pure eviction planner

/**
 * Decide which resident models to evict to free `needMb` of VRAM, given
 * `freeMb` currently available. Never selects pinned models or models with
 * active leases. Evicts in ascending order of (priority, lastUsedTick), i.e.
 * lowest priority first, then least-recently-used. Returns the keys to evict,
 * or null if the need cannot be satisfied even after evicting everything
 * eligible.
 *
 * Pure function exported for unit tests.
 */
export function planEvictions(
  resident: ResidentModel[],
  needMb: number,
  freeMb: number,
): string[] | null {
  if (freeMb >= needMb) return [];

  const evictable = resident
    .filter((m) => !m.pinned && m.leases === 0)
    .sort((a, b) =>
      a.priority !== b.priority
        ? a.priority - b.priority
        : a.lastUsedTick - b.lastUsedTick,
    );

  const toEvict: string[] = [];
  let reclaimed = 0;
  for (const m of evictable) {
    if (freeMb + reclaimed >= needMb) break;
    toEvict.push(m.key);
    reclaimed += m.vramMb;
  }

  return freeMb + reclaimed >= needMb ? toEvict : null;
}

// Scheduler

/** Swap telemetry buffer cap; oldest events are dropped beyond this. */
const MAX_SWAP_EVENTS = 200;

export class ModelLeaseManager {
  private resident = new Map<string, ResidentModel>();
  private tick = 0;
  private hooks: ModelLeaseHooks | null = null;
  /** Serializes acquire/release so eviction math sees a consistent state. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Load/unload timings since the last drain (swap-cost telemetry). */
  private swapEvents: SwapEvent[] = [];

  setHooks(hooks: ModelLeaseHooks): void {
    this.hooks = hooks;
  }

  private recordSwap(event: SwapEvent): void {
    this.swapEvents.push(event);
    if (this.swapEvents.length > MAX_SWAP_EVENTS) {
      this.swapEvents.splice(0, this.swapEvents.length - MAX_SWAP_EVENTS);
    }
  }

  /** Return and clear the swap events recorded since the last drain. */
  drainSwapTelemetry(): SwapEvent[] {
    const events = this.swapEvents;
    this.swapEvents = [];
    return events;
  }

  getResident(): ResidentModel[] {
    return [...this.resident.values()];
  }

  isResident(key: string): boolean {
    return this.resident.has(key);
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    // Keep the chain alive even if a step rejects.
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * Ensure `spec` is resident (loading + evicting as needed) and take a lease
   * on it. Call `lease.release()` when the model is no longer needed so it
   * becomes eligible for future eviction.
   */
  acquire(spec: ModelSpec): Promise<Lease> {
    return this.run(async () => {
      if (!this.hooks) {
        throw new Error("ModelLeaseManager: hooks not configured");
      }
      const normalized: Required<ModelSpec> = {
        key: spec.key,
        vramMb: spec.vramMb,
        priority: spec.priority ?? 0,
        pinned: spec.pinned ?? false,
      };

      const existing = this.resident.get(spec.key);
      if (existing) {
        existing.leases += 1;
        existing.lastUsedTick = ++this.tick;
        existing.priority = normalized.priority;
        existing.pinned = existing.pinned || normalized.pinned;
        logger.info(`lease+ ${spec.key} (leases=${existing.leases})`);
        return this.makeLease(spec.key);
      }

      const free = await this.hooks.availableVramMb();
      const plan = planEvictions(this.getResident(), normalized.vramMb, free);
      if (plan === null) {
        throw new Error(
          `Cannot fit model "${spec.key}" (${normalized.vramMb} MB): insufficient VRAM even after eviction.`,
        );
      }
      for (const key of plan) {
        await this.evict(key);
      }

      logger.info(`load ${spec.key} (${normalized.vramMb} MB)`);
      const loadStarted = Date.now();
      await this.hooks.load(spec);
      const loadMs = Date.now() - loadStarted;
      this.recordSwap({
        kind: "load",
        key: spec.key,
        durationMs: loadMs,
        freeVramMbBefore: free,
      });
      logger.info(`load ${spec.key} done in ${loadMs} ms (free ${free} MB)`);
      this.resident.set(spec.key, {
        ...normalized,
        lastUsedTick: ++this.tick,
        leases: 1,
      });
      return this.makeLease(spec.key);
    });
  }

  private makeLease(key: string): Lease {
    let released = false;
    return {
      key,
      release: () => {
        if (released) return;
        released = true;
        const m = this.resident.get(key);
        if (m && m.leases > 0) {
          m.leases -= 1;
          logger.info(`lease- ${key} (leases=${m.leases})`);
        }
      },
    };
  }

  private async evict(key: string): Promise<void> {
    const m = this.resident.get(key);
    if (!m) return;
    if (m.leases > 0) {
      throw new Error(`Refusing to evict leased model "${key}"`);
    }
    logger.info(`evict ${key} (reclaim ${m.vramMb} MB)`);
    const unloadStarted = Date.now();
    if (this.hooks) await this.hooks.unload(key);
    this.recordSwap({
      kind: "unload",
      key,
      durationMs: Date.now() - unloadStarted,
    });
    this.resident.delete(key);
  }

  /** Force-unload everything not currently leased. */
  releaseIdle(): Promise<void> {
    return this.run(async () => {
      for (const m of this.getResident()) {
        if (m.leases === 0 && !m.pinned) await this.evict(m.key);
      }
    });
  }
}

// Singleton

let singleton: ModelLeaseManager | null = null;

export function getModelLeaseManager(): ModelLeaseManager {
  if (!singleton) singleton = new ModelLeaseManager();
  return singleton;
}

/** Test-only: reset the singleton between tests. */
export function _resetModelLeaseManagerForTests(): void {
  singleton = null;
}
