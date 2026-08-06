import { describe, expect, it } from "vitest";

import {
  columnsForWidth,
  focusWeightFor,
  solveStageLayout,
  taskPriority,
  type SurfaceIntent,
} from "./layout_solver";

function intent(over: Partial<SurfaceIntent> = {}): SurfaceIntent {
  return {
    key: "task-1",
    kind: "task",
    priority: 200,
    focusWeight: 1,
    minColumns: 1,
    preferredColumns: 1,
    collapsible: true,
    ...over,
  };
}

describe("columnsForWidth", () => {
  it("fits one tile in a narrow deck and three in a wide one", () => {
    expect(columnsForWidth(340)).toBe(1);
    expect(columnsForWidth(520)).toBe(2);
    expect(columnsForWidth(780)).toBe(3);
  });

  it("never returns zero columns", () => {
    // A zero-column grid renders nothing at all, which looks like a crash.
    expect(columnsForWidth(0)).toBe(1);
    expect(columnsForWidth(-100)).toBe(1);
  });

  it("stops at three, because a fourth column is unreadable", () => {
    expect(columnsForWidth(4_000)).toBe(3);
  });
});

describe("solveStageLayout", () => {
  it("gives every tile one column when nothing is emphasised", () => {
    const layout = solveStageLayout(
      [intent({ key: "a" }), intent({ key: "b" })],
      { columns: 2 },
    );
    expect(layout.tiles.map((tile) => [tile.key, tile.columns])).toEqual([
      ["a", 1],
      ["b", 1],
    ]);
    expect(layout.collapsed).toEqual([]);
  });

  it("widens an emphasised tile so the rest actually reflow around it", () => {
    // This is the whole point: "make task one larger" has to take columns from
    // its siblings, not merely grow and push them down a scroll container.
    const layout = solveStageLayout(
      [
        intent({ key: "a", focusWeight: focusWeightFor("large") }),
        intent({ key: "b" }),
        intent({ key: "c" }),
      ],
      { columns: 3 },
    );
    const byKey = new Map(layout.tiles.map((tile) => [tile.key, tile]));
    expect(byKey.get("a")?.columns).toBe(2);
    expect(byKey.get("b")?.columns).toBe(1);
    expect(byKey.get("c")?.columns).toBe(1);
  });

  it("gives a focused tile the full width and extra height", () => {
    const layout = solveStageLayout(
      [intent({ key: "a", focusWeight: focusWeightFor("focus") })],
      { columns: 3 },
    );
    expect(layout.tiles[0]).toMatchObject({ columns: 3, rows: 2 });
  });

  it("does not let a tile exceed the grid", () => {
    const layout = solveStageLayout(
      [intent({ key: "a", focusWeight: 4, preferredColumns: 2 })],
      { columns: 2 },
    );
    expect(layout.tiles[0].columns).toBe(2);
  });

  it("honours a minimum width even in a one-column deck", () => {
    // Clamping to the grid rather than to the minimum: a 2-column minimum in a
    // 1-column deck must still render, just narrower than it wanted.
    const layout = solveStageLayout([intent({ key: "a", minColumns: 2 })], {
      columns: 1,
    });
    expect(layout.tiles[0].columns).toBe(1);
  });

  it("orders by priority, and keeps insertion order for ties", () => {
    const layout = solveStageLayout(
      [
        intent({ key: "healthy", priority: 200 }),
        intent({ key: "failing", priority: 400 }),
        intent({ key: "healthy-2", priority: 200 }),
      ],
      { columns: 3 },
    );
    expect(layout.tiles.map((tile) => tile.key)).toEqual([
      "failing",
      "healthy",
      "healthy-2",
    ]);
  });

  it("collapses the excess and names it instead of hiding it", () => {
    const layout = solveStageLayout(
      Array.from({ length: 6 }, (_unused, index) =>
        intent({ key: `t${index}`, priority: 200 - index }),
      ),
      { columns: 3, maxFullTiles: 2 },
    );
    expect(layout.tiles.map((tile) => tile.key)).toEqual(["t0", "t1"]);
    expect(layout.collapsed.map((item) => item.key)).toEqual([
      "t2",
      "t3",
      "t4",
      "t5",
    ]);
  });

  it("keeps a non-collapsible surface on screen past the cap", () => {
    // Running out of room must never be the reason a failure is invisible.
    const layout = solveStageLayout(
      [
        intent({ key: "a", priority: 300 }),
        intent({ key: "b", priority: 250 }),
        intent({ key: "must-see", priority: 10, collapsible: false }),
      ],
      { columns: 3, maxFullTiles: 2 },
    );
    expect(layout.tiles.map((tile) => tile.key)).toContain("must-see");
    expect(layout.collapsed).toEqual([]);
  });

  it("is empty and non-throwing with no intents", () => {
    expect(solveStageLayout([], { columns: 3 })).toEqual({
      columns: 3,
      tiles: [],
      collapsed: [],
    });
  });

  it("survives a zero-column request", () => {
    const layout = solveStageLayout([intent()], { columns: 0 });
    expect(layout.columns).toBe(1);
    expect(layout.tiles[0].columns).toBe(1);
  });
});

describe("taskPriority", () => {
  it("puts attention above live work, and live work above finished work", () => {
    const failing = taskPriority({ status: "failed" });
    const blocked = taskPriority({ status: "waiting" });
    const running = taskPriority({ status: "running" });
    const done = taskPriority({ status: "succeeded" });
    expect(failing).toBeGreaterThan(blocked);
    expect(blocked).toBeGreaterThan(running);
    expect(running).toBeGreaterThan(done);
  });

  it("treats requiresAttention as urgently as an outright failure", () => {
    expect(taskPriority({ status: "running", requiresAttention: true })).toBe(
      taskPriority({ status: "failed" }),
    );
  });

  it("lets the user nudge order without inverting the bands", () => {
    // "Prioritise the healthy task" must not bury a failing one.
    const boostedHealthy = taskPriority({ status: "running", priority: 100 });
    expect(boostedHealthy).toBeLessThan(taskPriority({ status: "failed" }));
    expect(boostedHealthy).toBeGreaterThan(taskPriority({ status: "running" }));
  });
});
