import { beforeEach, describe, expect, it } from "vitest";

import { _resetGraphForTests, buildGraph } from "./build_graph";
import {
  _resetRetrievalForTests,
  CORE_ACTIONS,
  selectActions,
} from "./retrieval";

beforeEach(() => {
  _resetGraphForTests();
  _resetRetrievalForTests();
});

/** Assert that `expected` is among the ids retrieved for `query`. */
function expectFound(query: string, expected: string) {
  const ids = selectActions(query).map((a) => a.id);
  expect(ids, `"${query}" should retrieve ${expected}`).toContain(expected);
}

describe("selectActions", () => {
  it("always offers the pinned core, whatever was said", () => {
    for (const query of ["", "hello", "zzzzzz", "what is going on"]) {
      const ids = selectActions(query).map((a) => a.id);
      for (const core of CORE_ACTIONS) expect(ids).toContain(core);
    }
  });

  it("keeps the core in a stable leading position", () => {
    // Predictability matters more than ranking here: a model that learned
    // `app.listApps` is always offered should keep finding it offered.
    const ids = selectActions("commit my changes").map((a) => a.id);
    expect(ids.slice(0, CORE_ACTIONS.length)).toEqual([...CORE_ACTIONS]);
  });

  it("respects the limit", () => {
    const actions = selectActions("generate an image of a coffee cup", 12);
    expect(actions.length).toBeLessThanOrEqual(12);
  });

  it("never returns duplicates", () => {
    // The core is added first and then skipped during search; a regression
    // there would silently duplicate tools in the model's tool list.
    const ids = selectActions("list my projects and apps").map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("finds actions from the words a person would actually use", () => {
    // Each of these is phrased as a request, not as a method name — which is
    // the whole reason the registry carries hand-written summaries.
    expectFound("commit my changes", "git.commitChanges");
    expectFound("what changed in this project", "git.getUncommittedFiles");
    expectFound("start the dev server", "app.runApp");
    expectFound("how much vram is free", "embeddedModel.getGpuStats");
    expectFound("open a terminal", "terminal.create");
    expectFound("take a screenshot of the game", "godot.viewport");
    expectFound("export the game so I can play it", "godot.exportProject");
    expectFound("download a model", "marketplace.startDownload");
    expectFound(
      "what is the mission waiting on",
      "mission.listMissionPermissionRequests",
    );
    expectFound("resume the workflow that stopped", "flow.resumeFlow");
  });

  it("returns only granted actions", () => {
    const granted = new Set(buildGraph().actions.map((a) => a.id));
    for (const query of ["delete everything", "reset the app", "remove file"]) {
      for (const action of selectActions(query)) {
        expect(granted.has(action.id)).toBe(true);
      }
    }
  });

  it("does not surface a withheld action even when asked for it by name", () => {
    // The registry is the gate, not the ranking. Naming `system.resetAll`
    // exactly must still retrieve nothing matching it.
    const ids = selectActions("system resetAll reset all app data").map(
      (a) => a.id,
    );
    expect(ids).not.toContain("system.resetAll");
    expect(ids).not.toContain("system.clearSessionData");
  });

  it("degrades to the core alone for a query too short to match", () => {
    expect(selectActions("hi").map((a) => a.id)).toEqual([...CORE_ACTIONS]);
  });
});
