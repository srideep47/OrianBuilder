import { afterEach, describe, expect, it, vi } from "vitest";

import type { MartaTaskEvent } from "@/ipc/types/marta";
import { TaskNarrationCoordinator } from "./task_narrator";

function event(
  type: MartaTaskEvent["type"],
  taskId: string,
  summary: string,
): MartaTaskEvent {
  return {
    eventId: `${taskId}:${type}`,
    timestamp: 1,
    taskId,
    actor: "test",
    type,
    publicSummary: summary,
  };
}

afterEach(() => vi.useRealTimers());

describe("TaskNarrationCoordinator", () => {
  it("ignores heartbeats and aggregates parallel milestones", () => {
    vi.useFakeTimers();
    const narrations: Array<{ text: string; speak: boolean }> = [];
    const coordinator = new TaskNarrationCoordinator((value) =>
      narrations.push(value),
    );
    coordinator.accept(event("heartbeat", "a", "still alive"));
    coordinator.accept(event("started", "a", "Started the build."));
    coordinator.accept(event("verifying", "b", "Checking the preview."));
    vi.advanceTimersByTime(500);
    expect(narrations).toMatchObject([
      {
        text: "2 updates. Started the build. Checking the preview.",
        speak: true,
      },
    ]);
  });

  it("flushes a failure immediately and deduplicates repeats", () => {
    const emit = vi.fn();
    const coordinator = new TaskNarrationCoordinator(emit, () => 100);
    const failed = event("failed", "a", "The preview failed verification.");
    coordinator.accept(failed);
    coordinator.accept(failed);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0]).toMatchObject({
      priority: "critical",
      speak: true,
      taskIds: ["a"],
    });
  });

  it("keeps low-value resource changes visual rather than spoken", () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const coordinator = new TaskNarrationCoordinator(emit);
    coordinator.accept(event("resource", "a", "Marta moved to CPU."));
    vi.advanceTimersByTime(500);
    expect(emit.mock.calls[0][0]).toMatchObject({
      priority: "quiet",
      speak: false,
    });
  });
});
