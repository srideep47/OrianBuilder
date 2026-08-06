import { describe, expect, it } from "vitest";
import { createStore } from "jotai";

import {
  clearStageAtom,
  closeSecondaryAtom,
  EMPTY_LAYOUT,
  focusSurfaceAtom,
  isEmptyLayout,
  MAX_SNAPSHOTS,
  popLayout,
  pushLayout,
  rewindStageAtom,
  sameLayout,
  sameSurface,
  showSurfaceAtom,
  splitSurfaceAtom,
  stageHistoryAtom,
  stageLayoutAtom,
  syncPrimaryAtom,
  type StageLayout,
} from "./stage_state";

const A = { surfaceId: "build.projects" };
const B = { surfaceId: "create.studio" };
const C = { surfaceId: "engine.cockpit" };

function layout(
  primary: StageLayout["primary"],
  secondary: StageLayout["secondary"] = null,
): StageLayout {
  return { primary, secondary };
}

describe("comparison", () => {
  it("treats params as part of a surface's identity", () => {
    // Otherwise "show project 3" then "show project 7" would be a no-op and
    // the second request would silently do nothing.
    expect(
      sameSurface(
        { surfaceId: "build.project", params: { appId: 3 } },
        { surfaceId: "build.project", params: { appId: 7 } },
      ),
    ).toBe(false);
    expect(
      sameSurface(
        { surfaceId: "build.project", params: { appId: 3 } },
        { surfaceId: "build.project", params: { appId: 3 } },
      ),
    ).toBe(true);
  });

  it("treats absent and empty params as the same", () => {
    expect(
      sameSurface({ surfaceId: "x" }, { surfaceId: "x", params: {} }),
    ).toBe(true);
  });

  it("compares both panes", () => {
    expect(sameLayout(layout(A, B), layout(A, B))).toBe(true);
    expect(sameLayout(layout(A, B), layout(A, C))).toBe(false);
  });
});

describe("pushLayout", () => {
  it("records the outgoing layout", () => {
    const result = pushLayout([], layout(A), layout(B));
    expect(result.layout).toEqual(layout(B));
    expect(result.history).toEqual([layout(A)]);
  });

  it("drops a repeat rather than filling history with it", () => {
    // Marta re-summons the current surface constantly while reasoning about
    // the screen. Recording each one would make "back" appear broken.
    const result = pushLayout([layout(C)], layout(A), layout(A));
    expect(result.history).toEqual([layout(C)]);
    expect(result.layout).toEqual(layout(A));
  });

  it("does not record the empty layout as somewhere to go back to", () => {
    const result = pushLayout([], EMPTY_LAYOUT, layout(A));
    expect(result.history).toEqual([]);
  });

  it("is bounded", () => {
    let history: StageLayout[] = [];
    let current = EMPTY_LAYOUT;
    for (let i = 0; i < MAX_SNAPSHOTS + 10; i++) {
      const next = layout({ surfaceId: `s${i}` });
      const result = pushLayout(history, current, next);
      history = result.history;
      current = result.layout;
    }
    expect(history).toHaveLength(MAX_SNAPSHOTS);
  });
});

describe("popLayout", () => {
  it("returns the most recent layout", () => {
    const result = popLayout([layout(A), layout(B)]);
    expect(result.layout).toEqual(layout(B));
    expect(result.history).toEqual([layout(A)]);
  });

  it("says so when there is nowhere to go", () => {
    expect(popLayout([]).layout).toBeNull();
  });
});

describe("stage atoms", () => {
  it("summons into the primary pane", () => {
    const store = createStore();
    store.set(showSurfaceAtom, A);
    expect(store.get(stageLayoutAtom)).toEqual(layout(A));
  });

  it("keeps the secondary pane when the primary changes", () => {
    // Splitting then navigating must not silently collapse the split — that
    // would make "show X next to Y" last exactly one action.
    const store = createStore();
    store.set(showSurfaceAtom, A);
    store.set(splitSurfaceAtom, B);
    store.set(showSurfaceAtom, C);
    expect(store.get(stageLayoutAtom)).toEqual(layout(C, B));
  });

  it("gives a focused task the whole Stage", () => {
    const store = createStore();
    store.set(showSurfaceAtom, A);
    store.set(splitSurfaceAtom, B);
    store.set(focusSurfaceAtom, C);
    expect(store.get(stageLayoutAtom)).toEqual(layout(C));
  });

  it("closes the secondary pane", () => {
    const store = createStore();
    store.set(showSurfaceAtom, A);
    store.set(splitSurfaceAtom, B);
    store.set(closeSecondaryAtom);
    expect(store.get(stageLayoutAtom)).toEqual(layout(A));
  });

  it("rewinds through the layouts it recorded", () => {
    const store = createStore();
    store.set(showSurfaceAtom, A);
    store.set(showSurfaceAtom, B);
    store.set(showSurfaceAtom, C);

    store.set(rewindStageAtom);
    expect(store.get(stageLayoutAtom)).toEqual(layout(B));
    store.set(rewindStageAtom);
    expect(store.get(stageLayoutAtom)).toEqual(layout(A));
  });

  it("rewinds a split as one step, not two", () => {
    // The split was one action from the user's side.
    const store = createStore();
    store.set(showSurfaceAtom, A);
    store.set(splitSurfaceAtom, B);
    store.set(rewindStageAtom);
    expect(store.get(stageLayoutAtom)).toEqual(layout(A));
  });

  it("does nothing when there is nothing to rewind to", () => {
    const store = createStore();
    store.set(rewindStageAtom);
    expect(store.get(stageLayoutAtom)).toEqual(EMPTY_LAYOUT);
  });

  it("clears the Stage but keeps it rewindable", () => {
    const store = createStore();
    store.set(showSurfaceAtom, A);
    store.set(clearStageAtom);
    expect(isEmptyLayout(store.get(stageLayoutAtom))).toBe(true);
    store.set(rewindStageAtom);
    expect(store.get(stageLayoutAtom)).toEqual(layout(A));
  });
});

describe("syncPrimaryAtom", () => {
  it("does not record a snapshot", () => {
    // The router sync uses this. Recording here as well would make one
    // navigation take two presses of "back".
    const store = createStore();
    store.set(syncPrimaryAtom, A);
    store.set(syncPrimaryAtom, B);
    expect(store.get(stageLayoutAtom)).toEqual(layout(B));
    expect(store.get(stageHistoryAtom)).toEqual([]);
  });

  it("is a no-op when the surface already matches", () => {
    const store = createStore();
    store.set(showSurfaceAtom, A);
    const before = store.get(stageLayoutAtom);
    store.set(syncPrimaryAtom, { surfaceId: "build.projects" });
    // Same object identity: nothing re-rendered.
    expect(store.get(stageLayoutAtom)).toBe(before);
  });

  it("leaves the secondary pane alone", () => {
    const store = createStore();
    store.set(showSurfaceAtom, A);
    store.set(splitSurfaceAtom, B);
    store.set(syncPrimaryAtom, C);
    expect(store.get(stageLayoutAtom)).toEqual(layout(C, B));
  });
});
