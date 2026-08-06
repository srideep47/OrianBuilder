/**
 * Marta's control of GPU residency.
 *
 * Before this, `ModelGate` enforced one hard-coded rule and nobody owned the
 * decision. Now the gate enforces *a* policy and Marta supplies it — she is the
 * orchestrator, so what holds the card is hers to decide, including whether she
 * yields it herself.
 *
 * Her policy differs from the default in one substantive way: **hysteresis.**
 *
 * The default answers each admission in isolation, which is correct per-request
 * and wrong across a batch. A flow alternating image → music → image →
 * music migrates her off and back on the card every step, and each migration
 * costs a real model reload that competes for the same PCIe bandwidth the
 * generation needs. After a few migrations in quick succession she stops trying
 * to come back and stays on the CPU until the card actually goes idle. Slower
 * answers for a minute beat thrashing the bus for ten.
 *
 * That judgement needs a view across requests over time, which is exactly what
 * an orchestrator has and a per-call rule does not.
 */

import log from "electron-log";

import {
  fitsAlongsideCompanion,
  getModelGate,
  type AdmissionDecision,
  type AdmissionRequest,
  type ResidencyPolicy,
  type RestoreRequest,
} from "@/main/flow/model_gate";
import { getCachedHardwareProfile } from "@/main/hardware/detect";
import { planMartaPlacement, type MartaPlacementPlan } from "./model_ladder";

const logger = log.scope("marta-residency");

/**
 * How many gate-initiated demotions inside `THRASH_WINDOW_MS` before Marta
 * stops trying to reclaim the GPU.
 *
 * Three, not two: a single image → music → image sequence produces two
 * demotions and is a perfectly normal flow that should not cost her the card
 * for the rest of the run.
 */
export const THRASH_THRESHOLD = 3;
export const THRASH_WINDOW_MS = 90_000;

/** How long she stays on the CPU after the latch trips, if the card stays busy. */
export const THRASH_COOLDOWN_MS = 180_000;

/** Injected so the hysteresis is testable without waiting in real time. */
export type Clock = () => number;

export interface MartaResidencyStatus {
  plan: MartaPlacementPlan | null;
  /** Demotion timestamps still inside the thrash window. */
  recentDemotions: number;
  /** True while she is deliberately staying off the card. */
  thrashLatched: boolean;
}

export class MartaResidencyController {
  private demotions: number[] = [];
  private latchedUntil = 0;
  private plan: MartaPlacementPlan | null = null;

  constructor(private readonly now: Clock = Date.now) {}

  setPlan(plan: MartaPlacementPlan | null): void {
    this.plan = plan;
  }

  getStatus(): MartaResidencyStatus {
    this.prune();
    return {
      plan: this.plan,
      recentDemotions: this.demotions.length,
      thrashLatched: this.now() < this.latchedUntil,
    };
  }

  private prune(): void {
    const cutoff = this.now() - THRASH_WINDOW_MS;
    this.demotions = this.demotions.filter((t) => t > cutoff);
  }

  private recordDemotion(): void {
    this.demotions.push(this.now());
    this.prune();
    if (this.demotions.length >= THRASH_THRESHOLD) {
      this.latchedUntil = this.now() + THRASH_COOLDOWN_MS;
      logger.info(
        `companion migrated ${this.demotions.length} times in ${THRASH_WINDOW_MS / 1000}s — ` +
          `staying on CPU until the GPU is idle`,
      );
    }
  }

  admit = (request: AdmissionRequest): AdmissionDecision => {
    const { slot, companion, budgetMb } = request;

    // Nothing to yield.
    if (!companion || companion.placement === "cpu") {
      return { admit: true, demoteCompanion: false };
    }

    // Unknown capacity: stay optimistic and let the gate's retry-on-failure
    // path find the truth. Demoting pre-emptively would put her on the CPU for
    // every generation on any machine whose VRAM cannot be read.
    if (budgetMb === null) {
      return { admit: true, demoteCompanion: false };
    }

    if (fitsAlongsideCompanion(slot, companion, budgetMb)) {
      return { admit: true, demoteCompanion: false };
    }

    // Marta always yields. The heavy model is what the user actually asked
    // for; she is the thing that arranged it. Refusing the request to protect
    // her own placement would be the orchestrator serving itself.
    this.recordDemotion();
    return {
      admit: true,
      demoteCompanion: true,
      reason: `${slot.kind}:${slot.modelId} needs ${slot.vramMb}MB of ${budgetMb}MB`,
    };
  };

  allowRestore = (request: RestoreRequest): boolean => {
    // An idle card always wins: it is the end of the batch, so there is nothing
    // left to thrash against and she should come straight back. This is also
    // what releases the latch.
    if (request.resident === null) {
      this.latchedUntil = 0;
      this.demotions = [];
      return true;
    }
    if (this.now() < this.latchedUntil) return false;
    return true;
  };

  /** The policy object handed to the gate. */
  policy(): ResidencyPolicy {
    return { admit: this.admit, allowRestore: this.allowRestore };
  }

  /** Test seam: forget the migration history. */
  reset(): void {
    this.demotions = [];
    this.latchedUntil = 0;
  }
}

// ─── Singleton wiring ────────────────────────────────────────────────────────

let controller: MartaResidencyController | null = null;
let initPromise: Promise<MartaPlacementPlan> | null = null;

export function getMartaResidency(): MartaResidencyController {
  if (!controller) controller = new MartaResidencyController();
  return controller;
}

/**
 * Hand the gate its VRAM budget and Marta's policy.
 *
 * Called once during IPC host startup, before any flow can run. It does not
 * start her model — that is the runtime's job — so the gate is correctly
 * configured whether or not she ever comes up.
 *
 * Memoised. Hardware detection costs ~700ms on a cold cache and shells out to
 * `nvidia-smi`; doing it twice would be pure waste, and two concurrent callers
 * racing to `setVramBudgetMb` is a correctness problem, not just a slow one.
 */
export function initMartaResidency(): Promise<MartaPlacementPlan> {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const profile = await getCachedHardwareProfile();
    const plan = planMartaPlacement(profile);

    const gate = getModelGate();
    gate.setVramBudgetMb(profile.primaryGpu?.vramMb ?? null);
    gate.setResidencyPolicy(getMartaResidency().policy());
    getMartaResidency().setPlan(plan);

    logger.info(
      `Marta residency: ${plan.tier.label} on ${plan.placement} — ${plan.rationale}`,
    );
    return plan;
  })();

  return initPromise;
}

/**
 * Resolve once the budget and policy are installed.
 *
 * Anything *reporting* residency must await this or it will see a null plan for
 * the first second of the app's life and report "no plan" as though the machine
 * were unsupported. Resolves immediately if init was never started, so callers
 * cannot deadlock on a subsystem that is switched off.
 */
export async function whenMartaResidencyReady(): Promise<void> {
  if (!initPromise) return;
  try {
    await initPromise;
  } catch {
    // Init logs its own failure. A caller asking "is she ready" should get an
    // answer, not the exception from a subsystem it does not own.
  }
}

export function _resetMartaResidencyForTests(): void {
  controller = null;
  initPromise = null;
}
