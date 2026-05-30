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
