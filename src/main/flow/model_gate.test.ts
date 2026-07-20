import { describe, it, expect, beforeEach } from "vitest";
import {
  ModelGate,
  getModelGate,
  _resetModelGateForTests,
  type ResidentSlot,
  type ModelGateHooks,
} from "./model_gate";

function slot(kind: ResidentSlot["kind"], modelId: string): ResidentSlot {
  return { kind, modelId, vramMb: 1000 };
}

function recordingHooks(): { hooks: ModelGateHooks; events: string[] } {
  const events: string[] = [];
  return {
    events,
    hooks: {
      load: async (s) => {
        events.push(`load:${s.kind}:${s.modelId}`);
      },
      unload: async (s) => {
        events.push(`unload:${s.kind}:${s.modelId}`);
      },
    },
  };
}

describe("ModelGate", () => {
  beforeEach(() => _resetModelGateForTests());

  it("loads on first enter and tracks the resident model", async () => {
    const gate = new ModelGate();
    const { hooks, events } = recordingHooks();
    gate.setHooks(hooks);

    await gate.enter(slot("image", "z-image-turbo"));
    expect(events).toEqual(["load:image:z-image-turbo"]);
    expect(gate.getResident()?.modelId).toBe("z-image-turbo");
  });

  it("does NOT reload when re-entering the same model (batch win)", async () => {
    const gate = new ModelGate();
    const { hooks, events } = recordingHooks();
    gate.setHooks(hooks);

    await gate.enter(slot("image", "z-image-turbo"));
    await gate.enter(slot("image", "z-image-turbo"));
    await gate.enter(slot("image", "z-image-turbo"));
    expect(events).toEqual(["load:image:z-image-turbo"]);
  });

  it("unloads the old model before loading a new one (single resident)", async () => {
    const gate = new ModelGate();
    const { hooks, events } = recordingHooks();
    gate.setHooks(hooks);

    await gate.enter(slot("image", "z-image-turbo"));
    await gate.enter(slot("video", "ltx-video"));
    expect(events).toEqual([
      "load:image:z-image-turbo",
      "unload:image:z-image-turbo",
      "load:video:ltx-video",
    ]);
    expect(gate.getResident()?.kind).toBe("video");
  });

  it("exit unloads and goes idle; exit when idle is a no-op", async () => {
    const gate = new ModelGate();
    const { hooks, events } = recordingHooks();
    gate.setHooks(hooks);

    await gate.enter(slot("music", "ace-step-1.5-xl-turbo"));
    await gate.exit();
    expect(gate.getResident()).toBeNull();
    expect(events).toEqual([
      "load:music:ace-step-1.5-xl-turbo",
      "unload:music:ace-step-1.5-xl-turbo",
    ]);

    await gate.exit(); // idle no-op
    expect(events).toHaveLength(2);
  });

  it("with() keeps the model resident after running fn", async () => {
    const gate = new ModelGate();
    const { hooks } = recordingHooks();
    gate.setHooks(hooks);

    const out = await gate.with(slot("image", "z-image-turbo"), async () => 42);
    expect(out).toBe(42);
    expect(gate.getResident()?.modelId).toBe("z-image-turbo");
  });

  it("evicts a model when generation fails or is cancelled", async () => {
    const gate = new ModelGate();
    const { hooks, events } = recordingHooks();
    gate.setHooks(hooks);
    const cancellation = new Error("cancelled");
    cancellation.name = "AbortError";

    await expect(
      gate.with(slot("video", "ltx-video"), async () => {
        throw cancellation;
      }),
    ).rejects.toBe(cancellation);

    expect(events).toEqual(["load:video:ltx-video", "unload:video:ltx-video"]);
    expect(gate.getResident()).toBeNull();
  });

  it("stays idle after a load process failure and accepts the next request", async () => {
    const gate = new ModelGate();
    const events: string[] = [];
    let failNextLoad = true;
    gate.setHooks({
      load: async (s) => {
        events.push(`load:${s.modelId}`);
        if (failNextLoad) {
          failNextLoad = false;
          throw new Error("worker crashed during load");
        }
      },
      unload: async (s) => {
        events.push(`unload:${s.modelId}`);
      },
    });

    await expect(gate.enter(slot("image", "broken"))).rejects.toThrow(
      "worker crashed during load",
    );
    expect(gate.getResident()).toBeNull();

    await gate.enter(slot("image", "healthy"));
    expect(gate.getResident()?.modelId).toBe("healthy");
    expect(events).toEqual(["load:broken", "load:healthy"]);
  });

  it("does not load a replacement when the resident model cannot unload", async () => {
    const gate = new ModelGate();
    const events: string[] = [];
    gate.setHooks({
      load: async (s) => {
        events.push(`load:${s.modelId}`);
      },
      unload: async (s) => {
        events.push(`unload:${s.modelId}`);
        throw new Error("worker did not release VRAM");
      },
    });
    await gate.enter(slot("image", "resident"));

    await expect(gate.enter(slot("video", "replacement"))).rejects.toThrow(
      "worker did not release VRAM",
    );
    expect(events).toEqual(["load:resident", "unload:resident"]);
    expect(gate.getResident()?.modelId).toBe("resident");
  });

  it("serializes concurrent enters so only one model is ever resident", async () => {
    const gate = new ModelGate();
    const { hooks, events } = recordingHooks();
    gate.setHooks(hooks);

    await Promise.all([
      gate.enter(slot("image", "a")),
      gate.enter(slot("video", "b")),
      gate.enter(slot("music", "c")),
    ]);
    // Loads/unloads must be balanced and never overlap: every load except the
    // last is followed by an unload before the next load.
    const loads = events.filter((e) => e.startsWith("load")).length;
    const unloads = events.filter((e) => e.startsWith("unload")).length;
    expect(loads).toBe(3);
    expect(unloads).toBe(2);
    expect(gate.getResident()).not.toBeNull();
  });

  it("does not swap models while another generation is using the resident slot", async () => {
    const gate = new ModelGate();
    const { hooks } = recordingHooks();
    gate.setHooks(hooks);
    const sequence: string[] = [];
    let releaseImage!: () => void;
    let signalImageStarted!: () => void;
    const imageStarted = new Promise<void>((resolve) => {
      signalImageStarted = resolve;
    });
    const imageCanFinish = new Promise<void>((resolve) => {
      releaseImage = resolve;
    });

    const imageRun = gate.with(slot("image", "a"), async () => {
      sequence.push("image-start");
      signalImageStarted();
      await imageCanFinish;
      sequence.push("image-end");
    });
    await imageStarted;
    const videoRun = gate.with(slot("video", "b"), async () => {
      sequence.push("video-start");
    });

    await Promise.resolve();
    expect(sequence).toEqual(["image-start"]);
    expect(gate.getResident()?.modelId).toBe("a");
    releaseImage();
    await Promise.all([imageRun, videoRun]);
    expect(sequence).toEqual(["image-start", "image-end", "video-start"]);
    expect(gate.getResident()?.modelId).toBe("b");
  });

  it("degrades to bookkeeping-only when no hooks are set", async () => {
    const gate = new ModelGate();
    await gate.enter(slot("image", "z-image-turbo"));
    expect(gate.getResident()?.modelId).toBe("z-image-turbo");
    await gate.exit();
    expect(gate.getResident()).toBeNull();
  });

  it("getModelGate returns a singleton", () => {
    expect(getModelGate()).toBe(getModelGate());
  });
});
