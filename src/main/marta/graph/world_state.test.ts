import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetWorldStateForTests,
  collectWorldState,
  renderWorldState,
  setWorldStateSources,
  type WorldState,
} from "./world_state";

beforeEach(() => {
  _resetWorldStateForTests();
});

const EMPTY: WorldState = {
  stage: { surfaceId: null },
  project: null,
  resident: null,
  companion: null,
  freeVramMb: null,
  totalVramMb: null,
  gpu: null,
  running: [],
  recentArtifacts: [],
  degraded: [],
};

describe("collectWorldState", () => {
  it("returns a usable digest with no sources wired at all", () => {
    // P0 lands before the runtime exists, so an entirely unwired digest has to
    // be a valid one rather than a crash.
    return expect(collectWorldState()).resolves.toEqual(EMPTY);
  });

  it("gathers from every wired source", async () => {
    setWorldStateSources({
      stage: () => ({ surfaceId: "game.workbench", params: { appId: 3 } }),
      project: () => ({ id: 3, name: "coffee", running: true }),
      resident: () => ({ kind: "llm", modelId: "qwen3.5-4b", vramMb: 5600 }),
      vram: async () => ({
        freeMb: 10240,
        totalMb: 16384,
        gpu: "RTX 4080 SUPER (cuda)",
      }),
      running: () => [{ kind: "flow" as const, id: "f1", label: "logo" }],
      recentArtifacts: () => [{ kind: "image", label: "hero.png" }],
    });

    const state = await collectWorldState();
    expect(state.stage.surfaceId).toBe("game.workbench");
    expect(state.project?.name).toBe("coffee");
    expect(state.resident?.modelId).toBe("qwen3.5-4b");
    expect(state.freeVramMb).toBe(10240);
    expect(state.running).toHaveLength(1);
    expect(state.degraded).toEqual([]);
  });

  it("survives a throwing source and names it as degraded", async () => {
    // The whole point: a broken GPU probe must not stop Marta answering, and
    // she must know the section is missing rather than assume it was empty.
    setWorldStateSources({
      project: () => ({ id: 1, name: "still works" }),
      vram: async () => {
        throw new Error("nvidia-smi not found");
      },
      running: () => {
        throw new Error("db locked");
      },
    });

    const state = await collectWorldState();
    expect(state.project?.name).toBe("still works");
    expect(state.freeVramMb).toBeNull();
    expect(state.running).toEqual([]);
    expect(state.degraded.sort()).toEqual(["running", "vram"]);
  });

  it("collects sources concurrently rather than in series", async () => {
    const order: string[] = [];
    const slow = (name: string, ms: number) => async () => {
      await new Promise((r) => setTimeout(r, ms));
      order.push(name);
      return null;
    };
    setWorldStateSources({
      project: slow("project", 20),
      resident: slow("resident", 5),
    });

    await collectWorldState();
    // Serial collection would finish `project` first because it is requested
    // first; concurrent collection finishes the faster one first.
    expect(order).toEqual(["resident", "project"]);
  });
});

describe("renderWorldState", () => {
  it("says the Stage is empty rather than saying nothing", () => {
    expect(renderWorldState(EMPTY)).toBe(
      "On screen: nothing — the Stage is empty.",
    );
  });

  it("omits sections that have nothing in them", () => {
    // A line reading "Running: none" teaches a small model that "Running:" is
    // noise. Its absence teaches nothing, which is what we want.
    const rendered = renderWorldState(EMPTY);
    expect(rendered).not.toMatch(/Running/);
    expect(rendered).not.toMatch(/GPU/);
    expect(rendered).not.toMatch(/Active project/);
  });

  it("renders a full digest compactly", () => {
    const rendered = renderWorldState({
      stage: { surfaceId: "create.studio", alsoShowing: ["create.queue"] },
      project: {
        id: 3,
        name: "coffee",
        running: true,
        branch: "main",
        uncommittedFiles: 4,
      },
      resident: { kind: "image", modelId: "sdxl", vramMb: 8192 },
      companion: { modelId: "qwen3.5-4b", placement: "gpu" },
      freeVramMb: 4096,
      totalVramMb: 16384,
      gpu: "RTX 4080 SUPER (cuda)",
      running: [
        { kind: "media", id: "m1", label: "hero render", progress: 60 },
        { kind: "mission", id: "x1", label: "refactor", awaitingUser: true },
      ],
      recentArtifacts: [{ kind: "image", label: "logo.png" }],
      degraded: [],
    });

    expect(rendered).toContain(
      "On screen: create.studio alongside create.queue",
    );
    expect(rendered).toContain('Active project: "coffee" (id 3)');
    expect(rendered).toContain("branch main");
    expect(rendered).toContain("4 uncommitted files");
    expect(rendered).toContain("4GB free of 16GB");
    expect(rendered).toContain("Model resident: sdxl (image, 8GB)");
    expect(rendered).toContain("media:hero render 60%");
    // Blocked work is shouted, because it is the one thing Marta should raise
    // unprompted.
    expect(rendered).toContain("mission:refactor — WAITING ON THE USER");
    expect(rendered).toContain('Recently produced: image "logo.png"');
    expect(rendered).toContain("You are running as qwen3.5-4b on GPU");
    expect(rendered.split("\n")).toHaveLength(7);
  });

  it("tells her she is slower when she has been pushed onto the CPU", () => {
    // She needs this to say "give me a moment" honestly instead of appearing
    // to hang.
    const rendered = renderWorldState({
      ...EMPTY,
      companion: { modelId: "qwen3.5-4b", placement: "cpu" },
    });
    expect(rendered).toContain("on CPU while the GPU is busy");
    expect(rendered).toContain("slower than usual");
  });

  it("distinguishes a temporary demotion from a latched one", () => {
    const rendered = renderWorldState({
      ...EMPTY,
      companion: {
        modelId: "qwen3.5-4b",
        placement: "cpu",
        thrashLatched: true,
      },
    });
    expect(rendered).toContain("staying there until the GPU frees up");
  });

  it("tells Marta not to assert emptiness for a degraded section", () => {
    const rendered = renderWorldState({ ...EMPTY, degraded: ["vram"] });
    expect(rendered).toContain("do not assert these are empty");
    expect(rendered).toContain("vram");
  });
});

describe("setWorldStateSources", () => {
  it("merges rather than replaces, so sources can be wired in pieces", async () => {
    setWorldStateSources({ project: () => ({ id: 1, name: "first" }) });
    setWorldStateSources({ resident: () => null });

    const state = await collectWorldState();
    expect(state.project?.name).toBe("first");
  });

  it("accepts synchronous and asynchronous sources alike", async () => {
    const sync = vi.fn(() => ({ surfaceId: "app.settings" }));
    setWorldStateSources({ stage: sync });
    expect((await collectWorldState()).stage.surfaceId).toBe("app.settings");
    expect(sync).toHaveBeenCalledOnce();
  });
});
