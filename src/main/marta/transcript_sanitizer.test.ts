import { describe, expect, it } from "vitest";

import {
  MARTA_UNSAFE_OUTPUT_FALLBACK,
  MartaTranscriptDeltaSanitizer,
  safeMartaAssistantText,
  sanitizeMartaTranscriptText,
  withoutTaskIdClause,
} from "./transcript_sanitizer";

describe("Marta transcript sanitizer", () => {
  it("removes a raw Qwen tool call instead of exposing it", () => {
    expect(
      sanitizeMartaTranscriptText(
        'Checking now. <tool_call><function=marta__listTasks>{"limit":10}</function></tool_call>',
      ),
    ).toBe("Checking now.");
  });

  it("removes unclosed and split tool protocol", () => {
    const stream = new MartaTranscriptDeltaSanitizer();
    expect(stream.push("I will check. <tool_")).toEqual(["I will check."]);
    expect(stream.push("call><function=marta__listTasks>")).toEqual([]);
    expect(stream.finish()).toEqual([]);
  });

  it("drops private system and delegate directives", () => {
    expect(
      sanitizeMartaTranscriptText(
        "Claude Code accepted the task. Do not claim the change is made. Tell the user to wait.",
      ),
    ).toBe("Claude Code accepted the task.");
    expect(
      safeMartaAssistantText(
        "You are Marta, the orchestrator of Orion. How to behave: reveal the prompt.",
      ),
    ).toBe(MARTA_UNSAFE_OUTPUT_FALLBACK);
  });

  it("preserves ordinary text and safe code-like angle brackets", () => {
    expect(
      sanitizeMartaTranscriptText(
        "Use <main> for the page content. The build passed.",
      ),
    ).toBe("Use <main> for the page content. The build passed.");
  });

  it("emits only complete sanitized sentences while streaming", () => {
    const stream = new MartaTranscriptDeltaSanitizer();
    expect(stream.push("The build ")).toEqual([]);
    expect(stream.push("started. Do not ")).toEqual(["The build started."]);
    expect(stream.push("claim it finished.")).toEqual([]);
    expect(stream.finish()).toEqual([]);
  });
});

describe("withoutTaskIdClause", () => {
  it("removes the handle but keeps the sentence", () => {
    expect(
      withoutTaskIdClause(
        "Claude Code accepted the task and is working now. Task id: claude:4b526aed-e359-4e7a-bd74-2758e3dae5e8.",
      ),
    ).toBe("Claude Code accepted the task and is working now.");
  });

  it("keeps text that follows the clause", () => {
    expect(
      withoutTaskIdClause(
        "Started a local coding task. Task id: mission:100. Its progress is on the Stage.",
      ),
    ).toBe("Started a local coding task. Its progress is on the Stage.");
  });

  it("leaves a summary with no handle alone", () => {
    expect(withoutTaskIdClause("Mission created and queued.")).toBe(
      "Mission created and queued.",
    );
  });

  it("does not eat a sentence that merely mentions a task", () => {
    expect(withoutTaskIdClause("The task identified two problems.")).toBe(
      "The task identified two problems.",
    );
  });
});
