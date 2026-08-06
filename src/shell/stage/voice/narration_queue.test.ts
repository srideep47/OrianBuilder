import { describe, expect, it } from "vitest";

import { NarrationQueue } from "./narration_queue";
import type { VoiceBackendHealth, VoiceBackendDescriptor } from "./runtime";
import type { TtsEngine } from "./tts";

class ControlledTts implements TtsEngine {
  readonly descriptor: VoiceBackendDescriptor = {
    id: "controlled",
    label: "Controlled test voice",
    kind: "tts",
    execution: "browser",
  };
  readonly calls: string[] = [];
  private finishes: Array<() => void> = [];
  private speaking = false;

  isAvailable(): boolean {
    return true;
  }
  getHealth(): VoiceBackendHealth {
    return {
      descriptor: this.descriptor,
      status: "ready",
      supportsStreaming: true,
      supportsCancellation: true,
      checkedAt: 1,
    };
  }
  speak(text: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    this.calls.push(text);
    this.speaking = true;
    return new Promise((resolve) => {
      const finish = () => {
        this.speaking = false;
        resolve();
      };
      this.finishes.push(finish);
      options.signal?.addEventListener("abort", finish, { once: true });
    });
  }
  finishNext(): void {
    this.finishes.shift()?.();
  }
  cancel(): void {
    this.finishNext();
  }
  isSpeaking(): boolean {
    return this.speaking;
  }
}

const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("NarrationQueue", () => {
  it("serializes speech and promotes interactive replies over queued status", async () => {
    const tts = new ControlledTts();
    const queue = new NarrationQueue(tts);
    const background = queue.enqueue("background", { priority: "background" });
    await tick();
    const status = queue.enqueue("status", { priority: "status" });
    const interactive = queue.enqueue("answer", { priority: "interactive" });

    expect(tts.calls).toEqual(["background"]);
    tts.finishNext();
    await expect(background).resolves.toBe("spoken");
    await tick();
    expect(tts.calls).toEqual(["background", "answer"]);
    tts.finishNext();
    await expect(interactive).resolves.toBe("spoken");
    await tick();
    expect(tts.calls).toEqual(["background", "answer", "status"]);
    tts.finishNext();
    await expect(status).resolves.toBe("spoken");
  });

  it("interrupts lower-priority narration and cancels a turn as one group", async () => {
    const tts = new ControlledTts();
    const queue = new NarrationQueue(tts);
    const background = queue.enqueue("long update", {
      groupId: "task",
      priority: "background",
    });
    await tick();
    const critical = queue.enqueue("permission required", {
      priority: "critical",
      interruptLowerPriority: true,
    });

    await expect(background).resolves.toBe("cancelled");
    await tick();
    expect(tts.calls).toEqual(["long update", "permission required"]);
    queue.cancelAll();
    await expect(critical).resolves.toBe("cancelled");
    await tick();
    expect(queue.getHealth()).toEqual({
      active: false,
      queued: 0,
      currentPriority: null,
    });
  });
});
