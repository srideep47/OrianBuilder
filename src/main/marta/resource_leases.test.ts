import { describe, expect, it, vi } from "vitest";

import { ResourceLeaseManager } from "./resource_leases";

describe("ResourceLeaseManager", () => {
  it("acquires all requested resources atomically", () => {
    const leases = new ResourceLeaseManager(() => 100);
    expect(leases.acquire("task-a", ["git-index:1", "file:a"])).toMatchObject({
      ok: true,
      leases: [{ key: "file:a" }, { key: "git-index:1" }],
    });

    const conflict = leases.acquire("task-b", ["free", "file:a"]);
    expect(conflict).toEqual({
      ok: false,
      conflicts: [{ key: "file:a", owner: "task-a", expiresAt: 120_100 }],
    });
    expect(leases.snapshot().map((lease) => lease.key)).not.toContain("free");
  });

  it("renews, releases, and reaps expired leases", () => {
    let now = 0;
    const leases = new ResourceLeaseManager(() => now, 20);
    leases.acquire("a", ["gpu"]);
    now = 10;
    expect(leases.heartbeat("a")).toBe(1);
    now = 25;
    expect(leases.acquire("b", ["gpu"]).ok).toBe(false);
    now = 31;
    expect(leases.acquire("b", ["gpu"]).ok).toBe(true);
    expect(leases.release("b")).toBe(1);
    expect(leases.snapshot()).toEqual([]);
  });

  it("notifies observers when ownership changes", () => {
    const leases = new ResourceLeaseManager();
    const listener = vi.fn();
    const unsubscribe = leases.subscribe(listener);
    leases.acquire("a", ["preview:5173"]);
    leases.release("a");
    unsubscribe();
    leases.acquire("b", ["preview:5173"]);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
