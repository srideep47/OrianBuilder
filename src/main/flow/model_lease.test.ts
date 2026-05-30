import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ModelLeaseManager,
  planEvictions,
  type ModelLeaseHooks,
  type ResidentModel,
} from "./model_lease";

function resident(
  partial: Partial<ResidentModel> & { key: string; vramMb: number },
): ResidentModel {
  return {
    priority: 0,
    pinned: false,
    lastUsedTick: 0,
    leases: 0,
    ...partial,
  };
}

describe("planEvictions", () => {
  it("evicts nothing when there is already enough free VRAM", () => {
    expect(planEvictions([], 1000, 2000)).toEqual([]);
  });

  it("evicts the lowest-priority model first", () => {
    const r = [
      resident({ key: "high", vramMb: 4000, priority: 10, lastUsedTick: 1 }),
      resident({ key: "low", vramMb: 4000, priority: 0, lastUsedTick: 2 }),
    ];
    expect(planEvictions(r, 3000, 0)).toEqual(["low"]);
  });

  it("breaks priority ties by least-recently-used", () => {
    const r = [
      resident({ key: "recent", vramMb: 2000, priority: 0, lastUsedTick: 9 }),
      resident({ key: "stale", vramMb: 2000, priority: 0, lastUsedTick: 1 }),
    ];
    expect(planEvictions(r, 1500, 0)).toEqual(["stale"]);
  });

  it("never evicts pinned or leased models", () => {
    const r = [
      resident({ key: "pinned", vramMb: 8000, pinned: true }),
      resident({ key: "leased", vramMb: 8000, leases: 1 }),
    ];
    expect(planEvictions(r, 4000, 0)).toBeNull();
  });

  it("evicts multiple models when needed", () => {
    const r = [
      resident({ key: "a", vramMb: 2000, priority: 0, lastUsedTick: 1 }),
      resident({ key: "b", vramMb: 2000, priority: 0, lastUsedTick: 2 }),
    ];
    const plan = planEvictions(r, 4000, 500);
    expect(plan).toEqual(["a", "b"]);
  });
});

describe("ModelLeaseManager", () => {
  let mgr: ModelLeaseManager;
  let free: number;
  let load: ReturnType<typeof vi.fn>;
  let unload: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    free = 16000;
    load = vi.fn(async () => {});
    unload = vi.fn(async () => {});
    const hooks: ModelLeaseHooks = {
      load: async (spec) => {
        await load(spec);
        free -= spec.vramMb;
      },
      unload: async (key) => {
        await unload(key);
      },
      availableVramMb: async () => free,
    };
    mgr = new ModelLeaseManager();
    mgr.setHooks(hooks);
  });

  afterEach(() => vi.clearAllMocks());

  it("loads a model on first acquire", async () => {
    const lease = await mgr.acquire({ key: "llm", vramMb: 8000 });
    expect(load).toHaveBeenCalledTimes(1);
    expect(mgr.isResident("llm")).toBe(true);
    expect(lease.key).toBe("llm");
  });

  it("does not reload an already-resident model", async () => {
    await mgr.acquire({ key: "llm", vramMb: 8000 });
    await mgr.acquire({ key: "llm", vramMb: 8000 });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("evicts an idle model to make room for a new one", async () => {
    free = 10000;
    const a = await mgr.acquire({ key: "a", vramMb: 6000 });
    a.release();
    await mgr.acquire({ key: "b", vramMb: 6000 });
    expect(unload).toHaveBeenCalledWith("a");
    expect(mgr.isResident("a")).toBe(false);
    expect(mgr.isResident("b")).toBe(true);
  });

  it("keeps a leased model resident and loads alongside when room exists", async () => {
    const a = await mgr.acquire({ key: "a", vramMb: 4000 });
    await mgr.acquire({ key: "b", vramMb: 4000 });
    expect(mgr.isResident("a")).toBe(true);
    expect(mgr.isResident("b")).toBe(true);
    expect(a.key).toBe("a");
  });

  it("throws when a model cannot fit even after eviction", async () => {
    free = 4000;
    const a = await mgr.acquire({ key: "a", vramMb: 4000 }); // leased, can't evict
    void a;
    await expect(mgr.acquire({ key: "big", vramMb: 8000 })).rejects.toThrow(
      /insufficient VRAM/i,
    );
  });

  it("releaseIdle unloads only unleased, unpinned models", async () => {
    const a = await mgr.acquire({ key: "a", vramMb: 2000 });
    const b = await mgr.acquire({ key: "b", vramMb: 2000 });
    b.release();
    await mgr.releaseIdle();
    expect(mgr.isResident("a")).toBe(true); // still leased
    expect(mgr.isResident("b")).toBe(false);
    void a;
  });
});
