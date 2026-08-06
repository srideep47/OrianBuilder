import type { NarrationHealth, NarrationPriority } from "./runtime";
import type { TtsEngine } from "./tts";

export type NarrationOutcome = "spoken" | "cancelled" | "failed" | "skipped";

export interface NarrationRequestOptions {
  priority?: NarrationPriority;
  /** Requests from the same Marta turn are cancelled as one unit on barge-in. */
  groupId?: string;
  signal?: AbortSignal;
  /** Interrupt a lower-priority active announcement immediately. */
  interruptLowerPriority?: boolean;
}

interface QueueItem {
  id: number;
  text: string;
  priority: NarrationPriority;
  groupId?: string;
  controller: AbortController;
  resolve: (outcome: NarrationOutcome) => void;
  settled: boolean;
  detachExternalAbort?: () => void;
}

const PRIORITY: Record<NarrationPriority, number> = {
  background: 0,
  status: 1,
  interactive: 2,
  critical: 3,
};

/**
 * One owner for all speech output.
 *
 * Browsers maintain an implicit global speech queue. Letting every task call it
 * directly causes overlapping, stale status announcements and makes barge-in
 * nondeterministic. This explicit queue serializes speech, prioritizes the user
 * conversation, and gives every turn a cancellable group.
 */
export class NarrationQueue {
  private pending: QueueItem[] = [];
  private active: QueueItem | null = null;
  private draining = false;
  private nextId = 1;

  constructor(
    private readonly engine: TtsEngine,
    private readonly onHealthChange?: (health: NarrationHealth) => void,
  ) {}

  getHealth(): NarrationHealth {
    return {
      active: this.active !== null,
      queued: this.pending.length,
      currentPriority: this.active?.priority ?? null,
    };
  }

  enqueue(
    text: string,
    options: NarrationRequestOptions = {},
  ): Promise<NarrationOutcome> {
    const cleaned = text.trim();
    if (!cleaned) return Promise.resolve("skipped");
    if (options.signal?.aborted) return Promise.resolve("cancelled");

    const priority = options.priority ?? "status";
    return new Promise<NarrationOutcome>((resolve) => {
      const item: QueueItem = {
        id: this.nextId++,
        text: cleaned,
        priority,
        groupId: options.groupId,
        controller: new AbortController(),
        resolve,
        settled: false,
      };

      if (options.signal) {
        const onAbort = () => this.cancelItem(item);
        options.signal.addEventListener("abort", onAbort, { once: true });
        item.detachExternalAbort = () =>
          options.signal?.removeEventListener("abort", onAbort);
      }

      if (
        options.interruptLowerPriority &&
        this.active &&
        PRIORITY[priority] > PRIORITY[this.active.priority]
      ) {
        this.cancelItem(this.active);
      }

      this.pending.push(item);
      this.pending.sort(
        (a, b) => PRIORITY[b.priority] - PRIORITY[a.priority] || a.id - b.id,
      );
      this.emitHealth();
      void this.drain();
    });
  }

  cancelGroup(groupId: string): void {
    for (let index = this.pending.length - 1; index >= 0; index--) {
      const item = this.pending[index];
      if (item.groupId === groupId) this.cancelItem(item);
    }
    if (this.active?.groupId === groupId) this.cancelItem(this.active);
  }

  cancelAll(): void {
    while (this.pending.length > 0) {
      this.cancelItem(this.pending[this.pending.length - 1]);
    }
    if (this.active) this.cancelItem(this.active);
    // Cancel even if the active backend forgot to honor AbortSignal.
    this.engine.cancel();
    this.emitHealth();
  }

  private cancelItem(item: QueueItem): void {
    if (item.settled) return;
    const index = this.pending.indexOf(item);
    if (index >= 0) this.pending.splice(index, 1);
    item.controller.abort();
    if (this.active === item) this.engine.cancel();
    this.settle(item, "cancelled");
    this.emitHealth();
  }

  private settle(item: QueueItem, outcome: NarrationOutcome): void {
    if (item.settled) return;
    item.settled = true;
    item.detachExternalAbort?.();
    item.resolve(outcome);
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.pending.length > 0) {
        const item = this.pending.shift();
        if (!item || item.settled) continue;
        this.active = item;
        this.emitHealth();

        const aborted = new Promise<NarrationOutcome>((resolve) => {
          item.controller.signal.addEventListener(
            "abort",
            () => resolve("cancelled"),
            { once: true },
          );
        });
        const spoken = Promise.resolve(
          this.engine.speak(item.text, { signal: item.controller.signal }),
        )
          .then<NarrationOutcome>(() =>
            item.controller.signal.aborted ? "cancelled" : "spoken",
          )
          .catch<NarrationOutcome>(() => "failed");

        const outcome = await Promise.race([spoken, aborted]);
        this.settle(item, outcome);
        if (this.active === item) this.active = null;
        this.emitHealth();
      }
    } finally {
      this.draining = false;
      this.emitHealth();
      // An enqueue can land between the loop's final check and `finally`.
      if (this.pending.length > 0) void this.drain();
    }
  }

  private emitHealth(): void {
    this.onHealthChange?.(this.getHealth());
  }
}
