import type { MartaTask, MartaTaskEvent } from "@/ipc/types/marta";

export interface ProactiveNarration {
  id: string;
  timestamp: number;
  priority: "quiet" | "normal" | "critical";
  text: string;
  taskIds: string[];
  speak: boolean;
}

interface PendingNarration {
  event: MartaTaskEvent;
  task?: MartaTask;
  priority: ProactiveNarration["priority"];
}

function priorityFor(
  event: MartaTaskEvent,
): ProactiveNarration["priority"] | null {
  switch (event.type) {
    case "heartbeat":
      return null;
    case "resource":
    case "layout":
      return "quiet";
    case "failed":
      return "critical";
    case "blocked":
    case "retrying":
    case "verifying":
    case "succeeded":
    case "cancelled":
    case "started":
      return "normal";
    case "created":
    case "queued":
    case "checkpoint":
    case "artifact":
      return "quiet";
  }
}

function sentence(update: PendingNarration): string {
  const label = update.task?.title?.trim();
  const summary = update.event.publicSummary.trim().replace(/\s+/g, " ");
  if (
    !label ||
    new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(summary)
  ) {
    return summary;
  }
  return `${label}: ${summary}`;
}

/**
 * Coalesces the task event stream into useful spoken milestones.
 * Heartbeats stay machine-readable; failures flush immediately; nearby normal
 * updates become one sentence so parallel work never turns Marta into a log
 * reader.
 */
export class TaskNarrationCoordinator {
  private pending: PendingNarration[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly recent = new Map<string, number>();

  constructor(
    private readonly emit: (narration: ProactiveNarration) => void,
    private readonly now: () => number = Date.now,
    private readonly aggregationMs = 450,
  ) {}

  accept(event: MartaTaskEvent, task?: MartaTask): void {
    const priority = priorityFor(event);
    if (!priority || !event.publicSummary.trim()) return;
    const dedupeKey = `${event.taskId}:${event.type}:${event.publicSummary.trim()}`;
    const at = this.now();
    if ((this.recent.get(dedupeKey) ?? -Infinity) > at - 10_000) return;
    this.recent.set(dedupeKey, at);
    for (const [key, timestamp] of this.recent) {
      if (timestamp < at - 60_000) this.recent.delete(key);
    }

    this.pending.push({ event, task, priority });
    if (priority === "critical") {
      this.flush();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.aggregationMs);
    }
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.pending.length === 0) return;

    const updates = this.pending.splice(0);
    const taskIds = [...new Set(updates.map((update) => update.event.taskId))];
    const priority = updates.some((update) => update.priority === "critical")
      ? "critical"
      : updates.some((update) => update.priority === "normal")
        ? "normal"
        : "quiet";
    const statements = updates.map(sentence);
    const text =
      statements.length === 1
        ? statements[0]
        : `${statements.length} updates. ${statements.join(" ")}`;
    this.emit({
      id: `${updates[0].event.eventId}:narration`,
      timestamp: this.now(),
      priority,
      text,
      taskIds,
      speak: priority !== "quiet",
    });
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = [];
  }
}
