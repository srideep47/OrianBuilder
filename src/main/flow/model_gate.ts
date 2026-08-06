import log from "electron-log";
import type { SwapEvent } from "@/ipc/types/intent";

// =============================================================================
// Orion — Model Residency Gate
// =============================================================================
//
// Two tiers, one queue.
//
// **Exclusive tier** — at most ONE heavy model/pipeline resident at a time,
// across both the embedded LLM server and the media backend. This is what makes
// batch-by-modality work: `enter()` the image model once, generate many images,
// then `enter()` the video model (which unloads images first). Orion prioritises
// reliable operation on consumer hardware over speculative co-residency —
// ACE-Step alone can occupy 12 GB of a 16 GB card.
//
// **Companion tier** — exactly one small always-on model, reserved for Marta,
// the orchestrator. She is deliberately OUTSIDE the single-resident rule,
// because the whole product depends on her being able to answer while a heavy
// job holds the card. The strict rule would evict her on every generation and
// the user would be talking to nothing.
//
// She is not, however, immune. When a heavy model genuinely cannot fit
// alongside her, she is **demoted** rather than unloaded: hot-migrated to a CPU
// placement that keeps her session and her conversation, just slower. The
// distinction matters — unloading would drop her working memory mid-sentence.
//
// **Who decides.** Residency is a policy, not a hard-coded rule, and Marta owns
// it: her runtime installs a `ResidencyPolicy` and from then on she is the one
// choosing what gets the card, whether she yields it, and when she takes it
// back. `DEFAULT_RESIDENCY_POLICY` reproduces the pre-Marta behaviour exactly,
// so the gate is correct before she exists and correct if she is disabled.
//
// Real load/unload/demote is delegated to pluggable hooks so the gate stays free
// of backend specifics and fully unit-testable. All operations — both tiers —
// are serialised on one queue, because a companion demote racing an exclusive
// load is precisely the bug this class exists to prevent.
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

// ─── Companion ───────────────────────────────────────────────────────────────

export type CompanionPlacement = "gpu" | "cpu";

/**
 * The always-on orchestrator model. One at a time; entering a different
 * `modelId` replaces it (that is the model-ladder swap, e.g. 4B → 0.8B).
 */
export interface CompanionSlot {
  modelId: string;
  /** VRAM it occupies while placed on the GPU. */
  vramMb: number;
  /** Where the caller wants it whenever there is room. */
  preferredPlacement: CompanionPlacement;
  /** Where it actually is right now. */
  placement: CompanionPlacement;
}

export type CompanionRequest = Omit<CompanionSlot, "placement">;

/**
 * VRAM left unclaimed when deciding whether two models fit together.
 *
 * Reported free VRAM is approximate on every platform and actively unreliable
 * on Windows, and a loading pipeline's peak is higher than its steady state.
 * Being wrong in the optimistic direction costs a failed load and a retry;
 * being wrong pessimistically costs Marta her GPU placement for no reason. This
 * is small enough to stay optimistic and large enough to absorb normal
 * fragmentation.
 */
export const COMPANION_HEADROOM_MB = 768;

// ─── Admission ───────────────────────────────────────────────────────────────

export interface AdmissionRequest {
  /** The exclusive slot being requested. */
  slot: ResidentSlot;
  /** What currently holds the exclusive tier. */
  resident: ResidentSlot | null;
  /** The companion, if one is running. */
  companion: CompanionSlot | null;
  /** Total usable VRAM in MB, or null when the gate has not been told. */
  budgetMb: number | null;
}

export interface AdmissionDecision {
  /** False refuses the request; `enter`/`with` reject with `reason`. */
  admit: boolean;
  /** Move the companion to CPU before loading. */
  demoteCompanion: boolean;
  reason?: string;
}

/** Asked before the gate puts a demoted companion back on the card. */
export interface RestoreRequest {
  companion: CompanionSlot;
  /** What holds the exclusive tier now — null when the card is idle. */
  resident: ResidentSlot | null;
  budgetMb: number | null;
}

/**
 * Who decides what holds the GPU.
 *
 * Both directions are here on purpose. Admission alone would let Marta yield
 * the card but not decide when to take it back, and taking it back at the wrong
 * moment — between two steps of an alternating-modality batch — is how you get
 * migration thrash. Controlling residency means controlling both edges.
 */
export interface ResidencyPolicy {
  admit: (
    request: AdmissionRequest,
  ) => AdmissionDecision | Promise<AdmissionDecision>;
  /** Omit to always allow a restore once the arithmetic says it fits. */
  allowRestore?: (request: RestoreRequest) => boolean | Promise<boolean>;
}

/** True when `slot` and `companion` can hold the card at the same time. */
export function fitsAlongsideCompanion(
  slot: ResidentSlot,
  companion: CompanionSlot,
  budgetMb: number,
): boolean {
  return slot.vramMb + companion.vramMb + COMPANION_HEADROOM_MB <= budgetMb;
}

/**
 * The behaviour when Marta has not installed a policy of her own.
 *
 * Always admits — refusing work is a decision only an orchestrator with context
 * should make — and keeps the companion resident unless the arithmetic says it
 * cannot work. With an unknown budget it stays optimistic: a failed load is
 * retried with the companion demoted (see `enterExclusive`), so guessing wrong
 * costs one retry, whereas demoting pre-emptively would put Marta on the CPU
 * for every generation on any machine whose VRAM we cannot read.
 */
export const DEFAULT_RESIDENCY_POLICY: ResidencyPolicy = {
  admit: (request) => {
    const { slot, companion, budgetMb } = request;
    if (!companion || companion.placement === "cpu") {
      return { admit: true, demoteCompanion: false };
    }
    if (budgetMb === null) {
      return { admit: true, demoteCompanion: false };
    }
    return {
      admit: true,
      demoteCompanion: !fitsAlongsideCompanion(slot, companion, budgetMb),
    };
  },
};

// ─── Hooks ───────────────────────────────────────────────────────────────────

/**
 * The exclusive tier's backend, owned by `pipeline_wiring.ts`.
 *
 * Deliberately separate from `CompanionHooks`: the two tiers are wired by
 * different subsystems at different times, and a single setter meant whichever
 * ran second silently erased the other's hooks.
 */
export interface ModelGateHooks {
  /** Bring `slot` into VRAM. */
  load: (slot: ResidentSlot) => Promise<void>;
  /** Evict `slot` from VRAM. */
  unload: (slot: ResidentSlot) => Promise<void>;
}

/** The companion tier's backend, owned by Marta's runtime. */
export interface CompanionHooks {
  /** Start the companion at `slot.placement`. */
  load: (slot: CompanionSlot) => Promise<void>;
  /** Stop the companion entirely. */
  unload: (slot: CompanionSlot) => Promise<void>;
  /**
   * Move the companion off the GPU **without ending its session**. Falls back
   * to `unload` when absent, which frees the VRAM correctly but loses her
   * conversation — so a real implementation should always provide this.
   */
  demote?: (slot: CompanionSlot) => Promise<void>;
  /** Move the companion back onto the GPU. */
  restore?: (slot: CompanionSlot) => Promise<void>;
}

function sameSlot(a: ResidentSlot | null, b: ResidentSlot): boolean {
  return a != null && a.kind === b.kind && a.modelId === b.modelId;
}

export class AdmissionRefusedError extends Error {
  readonly slot: ResidentSlot;

  constructor(slot: ResidentSlot, reason: string) {
    super(`Admission refused for ${slot.kind}:${slot.modelId} — ${reason}`);
    this.name = "AdmissionRefusedError";
    this.slot = slot;
  }
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
  private companion: CompanionSlot | null = null;
  private hooks: ModelGateHooks | null = null;
  private companionHooks: CompanionHooks | null = null;
  private policy: ResidencyPolicy = DEFAULT_RESIDENCY_POLICY;
  private budgetMb: number | null = null;
  private swapEvents: SwapEvent[] = [];
  /**
   * Serialises both residency changes and the work performed while a model is
   * resident. Holding this queue for `with()` is important: serialising only
   * load/unload calls would still allow another flow to swap the model while a
   * generation is in progress.
   */
  private queue: Promise<unknown> = Promise.resolve();

  /** Wire the exclusive tier. Does not touch the companion tier. */
  setHooks(hooks: ModelGateHooks): void {
    this.hooks = hooks;
  }

  /** Wire the companion tier. Does not touch the exclusive tier. */
  setCompanionHooks(hooks: CompanionHooks | null): void {
    this.companionHooks = hooks;
  }

  /**
   * Hand residency control to Marta. Called by her runtime at startup; passing
   * `null` restores the default so disabling her cannot wedge the gate.
   */
  setResidencyPolicy(policy: ResidencyPolicy | null): void {
    this.policy = policy ?? DEFAULT_RESIDENCY_POLICY;
  }

  /** Total usable VRAM in MB. `null` means unknown — the policy stays optimistic. */
  setVramBudgetMb(budgetMb: number | null): void {
    this.budgetMb = budgetMb;
  }

  getVramBudgetMb(): number | null {
    return this.budgetMb;
  }

  /** The currently resident exclusive model, or null when idle. */
  getResident(): ResidentSlot | null {
    return this.current;
  }

  /** The companion, or null when Marta is not running. */
  getCompanion(): CompanionSlot | null {
    return this.companion ? { ...this.companion } : null;
  }

  /** Return and clear swap timings since the previous drain. */
  drainSwapTelemetry(): SwapEvent[] {
    const events = this.swapEvents;
    this.swapEvents = [];
    return events;
  }

  private record(
    kind: SwapEvent["kind"],
    key: string,
    startedAt: number,
  ): void {
    this.swapEvents.push({ kind, key, durationMs: Date.now() - startedAt });
  }

  private async unloadCurrent(slot: ResidentSlot): Promise<void> {
    const started = Date.now();
    if (this.hooks) await this.hooks.unload(slot);
    this.record("unload", `${slot.kind}:${slot.modelId}`, started);
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  // ─── Companion tier ────────────────────────────────────────────────────────

  /**
   * Start (or replace) the companion. Entering the same `modelId` is a no-op,
   * so the runtime can call this freely to assert Marta should be up.
   */
  enterCompanion(request: CompanionRequest): Promise<void> {
    return this.run(async () => {
      if (this.companion?.modelId === request.modelId) {
        this.companion.preferredPlacement = request.preferredPlacement;
        this.companion.vramMb = request.vramMb;
        await this.reconcileCompanion();
        return;
      }
      if (this.companion) await this.unloadCompanionSlot(this.companion);

      // Start where there is room, rather than starting on the GPU and
      // immediately demoting — that would cost two migrations on a busy card.
      const placement = this.companionFitsNow(request.vramMb)
        ? request.preferredPlacement
        : "cpu";
      const slot: CompanionSlot = { ...request, placement };

      logger.info(
        `companion load ${slot.modelId} on ${placement} (${slot.vramMb} MB)`,
      );
      const started = Date.now();
      if (this.companionHooks?.load) await this.companionHooks.load(slot);
      this.record("load", `companion:${slot.modelId}`, started);
      this.companion = slot;
    });
  }

  /** Stop the companion entirely. Safe to call when none is running. */
  exitCompanion(): Promise<void> {
    return this.run(async () => {
      if (!this.companion) return;
      await this.unloadCompanionSlot(this.companion);
      this.companion = null;
    });
  }

  private async unloadCompanionSlot(slot: CompanionSlot): Promise<void> {
    logger.info(`companion unload ${slot.modelId}`);
    const started = Date.now();
    if (this.companionHooks?.unload) await this.companionHooks.unload(slot);
    this.record("unload", `companion:${slot.modelId}`, started);
  }

  /**
   * Whether a companion of `vramMb` fits beside whatever holds the card now.
   *
   * With an unknown budget the only defensible answer is "yes if nothing else
   * is loaded". Returning an optimistic yes while a heavy model is resident
   * would undo the retry path in `enterExclusive`: that retry demotes her
   * precisely *because* the load proved they do not fit, and a reconcile
   * immediately afterwards would put her straight back and OOM again.
   *
   * Note this is deliberately stricter than the admission policy, which does
   * stay optimistic on an unknown budget. Keeping a working GPU session alive
   * is a different question from creating one against unmeasured capacity.
   */
  private companionFitsNow(vramMb: number): boolean {
    if (this.budgetMb === null) return this.current === null;
    const used = this.current?.vramMb ?? 0;
    return used + vramMb + COMPANION_HEADROOM_MB <= this.budgetMb;
  }

  private async demote(slot: CompanionSlot): Promise<void> {
    if (slot.placement === "cpu") return;
    logger.info(`companion demote ${slot.modelId} -> cpu`);
    const started = Date.now();
    if (this.companionHooks?.demote) {
      await this.companionHooks.demote(slot);
    } else if (this.companionHooks?.unload) {
      // No migration path: stopping her is the only way to free the VRAM. This
      // loses her conversation, hence the warning — it is a missing hook, not a
      // design choice.
      logger.warn(
        `no demoteCompanion hook; unloading ${slot.modelId} instead — its session is lost`,
      );
      await this.companionHooks.unload(slot);
    }
    this.record("demote", `companion:${slot.modelId}`, started);
    slot.placement = "cpu";
  }

  private async restore(slot: CompanionSlot): Promise<void> {
    if (slot.placement === "gpu") return;
    logger.info(`companion restore ${slot.modelId} -> gpu`);
    const started = Date.now();
    if (this.companionHooks?.restore) {
      await this.companionHooks.restore(slot);
    } else if (this.companionHooks?.load) {
      await this.companionHooks.load({ ...slot, placement: "gpu" });
    }
    this.record("restore", `companion:${slot.modelId}`, started);
    slot.placement = "gpu";
  }

  /**
   * Put the companion back on the GPU once there is room again.
   *
   * Runs after every exclusive transition, so freeing a 12 GB music model
   * brings Marta back onto the card without anyone asking. Only undoes the
   * gate's own demotions: a caller who asked for CPU keeps CPU.
   *
   * A failed restore is logged and swallowed. She is still running on the CPU,
   * so the user is not stuck — and throwing here would fail the generation that
   * had just succeeded.
   */
  private async reconcileCompanion(): Promise<void> {
    const slot = this.companion;
    if (!slot) return;

    // The caller wants her off the card. This is a preference, not a
    // gate-initiated demotion, so it is recorded as such and survives the card
    // freeing up — otherwise "get off my GPU" would last until the next
    // reconcile and silently undo itself.
    if (slot.preferredPlacement === "cpu" && slot.placement === "gpu") {
      try {
        await this.demote(slot);
      } catch (error) {
        logger.error(`failed to move companion ${slot.modelId} to cpu`, error);
      }
      return;
    }

    if (slot.preferredPlacement !== "gpu") return;
    if (slot.placement === "gpu") return;
    if (!this.companionFitsNow(slot.vramMb)) return;

    try {
      if (this.policy.allowRestore) {
        const allowed = await this.policy.allowRestore({
          companion: { ...slot },
          resident: this.current,
          budgetMb: this.budgetMb,
        });
        if (!allowed) {
          logger.debug(`companion restore held off by policy: ${slot.modelId}`);
          return;
        }
      }
      await this.restore(slot);
    } catch (error) {
      logger.error(`failed to restore companion ${slot.modelId} to gpu`, error);
    }
  }

  // ─── Exclusive tier ────────────────────────────────────────────────────────

  /**
   * Ensure `slot` is the resident exclusive model, unloading whatever else is
   * resident first. No-op when `slot` is already resident (this is the batch
   * win — re-entering the same model never reloads it). When hooks are not set,
   * the gate updates bookkeeping only so higher layers degrade gracefully.
   */
  private async enterExclusive(slot: ResidentSlot): Promise<void> {
    if (sameSlot(this.current, slot)) {
      logger.debug(`enter ${slot.kind}:${slot.modelId} (already resident)`);
      return;
    }

    const decision = await this.policy.admit({
      slot,
      resident: this.current,
      companion: this.getCompanion(),
      budgetMb: this.budgetMb,
    });
    if (!decision.admit) {
      const reason = decision.reason ?? "no reason given";
      logger.info(`admission refused ${slot.kind}:${slot.modelId}: ${reason}`);
      throw new AdmissionRefusedError(slot, reason);
    }

    if (this.current) {
      logger.info(`unload ${this.current.kind}:${this.current.modelId}`);
      await this.unloadCurrent(this.current);
      this.current = null;
    }

    if (decision.demoteCompanion && this.companion) {
      await this.demote(this.companion);
    }

    try {
      await this.loadExclusive(slot);
    } catch (error) {
      // The commonest cause of a load failure on a busy card is that the
      // companion was left resident and the arithmetic was too optimistic —
      // which is exactly what an unknown VRAM budget produces. Give up her
      // placement and try once more before surfacing the failure.
      const canRetry =
        this.companion !== null && this.companion.placement === "gpu";
      if (!canRetry) throw error;

      logger.warn(
        `load ${slot.kind}:${slot.modelId} failed with the companion resident; ` +
          `demoting it and retrying once`,
        error,
      );
      await this.demote(this.companion!);
      await this.loadExclusive(slot);
    }
  }

  private async loadExclusive(slot: ResidentSlot): Promise<void> {
    logger.info(`load ${slot.kind}:${slot.modelId} (${slot.vramMb} MB)`);
    const started = Date.now();
    if (this.hooks) await this.hooks.load(slot);
    this.record("load", `${slot.kind}:${slot.modelId}`, started);
    this.current = slot;
  }

  enter(slot: ResidentSlot): Promise<void> {
    return this.run(async () => {
      await this.enterExclusive(slot);
      await this.reconcileCompanion();
    });
  }

  /**
   * Unload the resident exclusive model (if any) → idle, and bring the
   * companion back onto the card. Does not stop the companion; use
   * `exitCompanion` for that.
   */
  exit(): Promise<void> {
    return this.run(async () => {
      if (this.current) {
        logger.info(
          `exit: unload ${this.current.kind}:${this.current.modelId}`,
        );
        await this.unloadCurrent(this.current);
        this.current = null;
      }
      await this.reconcileCompanion();
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
      // Deliberately not reconciled here: bringing the companion back onto the
      // card in the gap between load and generation would re-create the
      // pressure the demotion just relieved. She returns when the slot exits.
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
            await this.reconcileCompanion();
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

  /**
   * Reserve the exclusive VRAM tier for a backend whose lifecycle is owned by
   * the caller (for example Marta's on-demand big-brain llama-server).
   *
   * This performs the same admission, existing-model eviction, companion
   * demotion and post-run restoration as `with`, but deliberately does not call
   * the normal exclusive hooks.  The caller starts/stops its backend inside
   * `fn`, so invoking those hooks as well would load two large models.
   */
  withExternal<T>(slot: ResidentSlot, fn: () => Promise<T>): Promise<T> {
    return this.run(async () => {
      const decision = await this.policy.admit({
        slot,
        resident: this.current,
        companion: this.getCompanion(),
        budgetMb: this.budgetMb,
      });
      if (!decision.admit) {
        throw new AdmissionRefusedError(
          slot,
          decision.reason ?? "no reason given",
        );
      }
      if (this.current) {
        await this.unloadCurrent(this.current);
        this.current = null;
      }
      if (decision.demoteCompanion && this.companion) {
        await this.demote(this.companion);
      }

      const loadStarted = Date.now();
      this.current = slot;
      this.record("load", `${slot.kind}:${slot.modelId}`, loadStarted);
      try {
        return await fn();
      } finally {
        if (sameSlot(this.current, slot)) {
          const unloadStarted = Date.now();
          this.current = null;
          this.record("unload", `${slot.kind}:${slot.modelId}`, unloadStarted);
        }
        await this.reconcileCompanion();
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
