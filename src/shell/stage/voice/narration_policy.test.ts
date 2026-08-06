import { describe, expect, it } from "vitest";

import {
  collapseDeferred,
  decideNarration,
  type ProactiveNarrationInput,
} from "./narration_policy";

const narration = (
  over: Partial<ProactiveNarrationInput> = {},
): ProactiveNarrationInput => ({
  id: "n1",
  timestamp: 1_000,
  priority: "normal",
  text: "The website worker changed three files.",
  taskIds: ["task-1"],
  speak: true,
  ...over,
});

describe("decideNarration", () => {
  it("never speaks while voice is off, but still records", () => {
    const decision = decideNarration(narration(), {
      detail: "normal",
      phase: "off",
      voiceEnabled: false,
    });
    expect(decision).toMatchObject({
      record: true,
      speak: false,
      defer: false,
    });
  });

  it("speaks a milestone when the user is idle", () => {
    const decision = decideNarration(narration(), {
      detail: "normal",
      phase: "listening",
      voiceEnabled: true,
    });
    expect(decision.speak).toBe(true);
    expect(decision.queuePriority).toBe("status");
    expect(decision.interruptLowerPriority).toBe(false);
  });

  it("holds a milestone rather than talking over the user", () => {
    for (const phase of ["capturing", "transcribing"] as const) {
      const decision = decideNarration(narration(), {
        detail: "normal",
        phase,
        voiceEnabled: true,
      });
      expect(decision.speak, phase).toBe(false);
      expect(decision.defer, phase).toBe(true);
    }
  });

  it("interrupts for a critical failure even mid-utterance", () => {
    const decision = decideNarration(
      narration({ priority: "critical", text: "The build failed." }),
      { detail: "normal", phase: "capturing", voiceEnabled: true },
    );
    expect(decision.speak).toBe(true);
    expect(decision.defer).toBe(false);
    expect(decision.queuePriority).toBe("critical");
    expect(decision.interruptLowerPriority).toBe(true);
  });

  it("keeps failures audible in quiet mode", () => {
    // Quiet is "less chatter", not "do not tell me the build died".
    const quietMilestone = decideNarration(narration(), {
      detail: "quiet",
      phase: "listening",
      voiceEnabled: true,
    });
    const quietFailure = decideNarration(narration({ priority: "critical" }), {
      detail: "quiet",
      phase: "listening",
      voiceEnabled: true,
    });
    expect(quietMilestone.speak).toBe(false);
    expect(quietMilestone.record).toBe(true);
    expect(quietFailure.speak).toBe(true);
  });

  it("speaks main's quiet-priority events only in detailed mode", () => {
    const checkpoint = narration({ priority: "quiet", speak: false });
    expect(
      decideNarration(checkpoint, {
        detail: "normal",
        phase: "listening",
        voiceEnabled: true,
      }).speak,
    ).toBe(false);
    expect(
      decideNarration(checkpoint, {
        detail: "detailed",
        phase: "listening",
        voiceEnabled: true,
      }).speak,
    ).toBe(true);
  });

  it("speaks while she is already speaking, letting the queue serialise it", () => {
    // The queue sorts an interactive reply ahead of a status line, so this can
    // never delay an answer; dropping it here would lose the milestone entirely.
    const decision = decideNarration(narration(), {
      detail: "normal",
      phase: "speaking",
      voiceEnabled: true,
    });
    expect(decision.speak).toBe(true);
    expect(decision.queuePriority).toBe("status");
  });
});

describe("collapseDeferred", () => {
  it("keeps only the newest update per task", () => {
    const held = [
      narration({ id: "a", timestamp: 1, text: "Installing dependencies." }),
      narration({ id: "b", timestamp: 2, text: "Running the build." }),
    ];
    expect(collapseDeferred(held).map((item) => item.id)).toEqual(["b"]);
  });

  it("keeps every critical update, even superseded ones", () => {
    const held = [
      narration({ id: "fail", timestamp: 1, priority: "critical" }),
      narration({ id: "ok", timestamp: 2 }),
    ];
    expect(collapseDeferred(held).map((item) => item.id)).toEqual([
      "fail",
      "ok",
    ]);
  });

  it("does not let one task's update shadow another's", () => {
    const held = [
      narration({ id: "a", timestamp: 1, taskIds: ["task-1"] }),
      narration({ id: "b", timestamp: 2, taskIds: ["task-2"] }),
    ];
    expect(collapseDeferred(held).map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("treats an aggregate as its own stream, not as either task", () => {
    const held = [
      narration({ id: "single", timestamp: 1, taskIds: ["task-1"] }),
      narration({ id: "both", timestamp: 2, taskIds: ["task-1", "task-2"] }),
    ];
    expect(collapseDeferred(held).map((item) => item.id)).toEqual([
      "single",
      "both",
    ]);
  });

  it("returns updates oldest-first so the story stays in order", () => {
    const held = [
      narration({ id: "b", timestamp: 5, taskIds: ["t2"] }),
      narration({ id: "a", timestamp: 2, taskIds: ["t1"] }),
    ];
    expect(collapseDeferred(held).map((item) => item.timestamp)).toEqual([
      2, 5,
    ]);
  });

  it("is empty for an empty backlog", () => {
    expect(collapseDeferred([])).toEqual([]);
  });
});
