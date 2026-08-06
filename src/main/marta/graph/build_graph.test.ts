import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { ACTION_REGISTRY } from "./action_registry";
import {
  _resetGraphForTests,
  buildGraph,
  getAction,
  isGranted,
  isScalarWrapped,
  isVoidInput,
  SCALAR_INPUT_KEY,
  toParameterSchema,
  prepareHandlerInput,
} from "./build_graph";
import { allContractIds, lookupContract } from "./contract_sources";
import { requiresConfirmation } from "./types";

beforeEach(() => {
  _resetGraphForTests();
});

describe("toParameterSchema", () => {
  it("turns a void input into an empty object schema", () => {
    // Tool-calling APIs reject a bare `{}`; 132 of the app's contracts take
    // `z.void()`, so this is the single most load-bearing normalisation.
    expect(toParameterSchema(z.void())).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
  });

  it("passes object schemas through, minus the $schema key", () => {
    const schema = toParameterSchema(
      z.object({ name: z.string(), count: z.number().optional() }),
    );
    expect(schema.$schema).toBeUndefined();
    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties as object)).toEqual(["name", "count"]);
    expect(schema.required).toEqual(["name"]);
  });

  it("treats defaulted fields as optional for the caller", () => {
    // `io: "input"` is what makes this true. Without it a field with a default
    // is reported as required and the model is forced to invent a value.
    const schema = toParameterSchema(
      z.object({ mode: z.string().default("auto") }),
    );
    expect(schema.required).toBeUndefined();
  });

  it("wraps a scalar input under `value`", () => {
    expect(toParameterSchema(z.number())).toEqual({
      type: "object",
      properties: { [SCALAR_INPUT_KEY]: { type: "number" } },
      required: [SCALAR_INPUT_KEY],
      additionalProperties: false,
    });
  });

  it("wraps a union input too", () => {
    const schema = toParameterSchema(z.union([z.string(), z.number()]));
    expect(schema.required).toEqual([SCALAR_INPUT_KEY]);
    expect(
      (schema.properties as Record<string, { anyOf: unknown[] }>)[
        SCALAR_INPUT_KEY
      ].anyOf,
    ).toHaveLength(2);
  });

  it("does not throw on z.date(), which the mission contracts use", () => {
    expect(() =>
      toParameterSchema(z.object({ createdAt: z.date() })),
    ).not.toThrow();
  });
});

describe("void inputs", () => {
  it("detects a contract that takes nothing", () => {
    expect(isVoidInput(z.void())).toBe(true);
    expect(isVoidInput(z.undefined())).toBe(true);
    expect(isVoidInput(z.object({ a: z.string() }))).toBe(false);
    // An all-optional object accepts `{}`, so it is not "void" — sending
    // `undefined` to it would be wrong.
    expect(isVoidInput(z.object({ a: z.string().optional() }))).toBe(false);
  });

  it("sends undefined, not {}, to a void contract", () => {
    // Found by a live run: the tool schema advertises an empty object because
    // tool-calling APIs reject a bare `{}` schema, the model dutifully sends
    // `{}`, and `z.void()` rejects it. That broke all 132 no-argument reads.
    expect(isVoidInput(lookupContract("app.listApps")!.contract.input)).toBe(
      true,
    );
    expect(prepareHandlerInput("app.listApps", {})).toBeUndefined();
  });

  it("keeps every granted void action callable", () => {
    // The whole class, not just the one the live run happened to hit.
    for (const action of buildGraph().actions) {
      const input = lookupContract(action.id)!.contract.input;
      if (!isVoidInput(input)) continue;
      const prepared = prepareHandlerInput(action.id, {});
      expect(
        input.safeParse(prepared).success,
        `${action.id} must accept what prepareHandlerInput produces`,
      ).toBe(true);
    }
  });

  it("keeps every granted action's empty-args call schema-valid or explicitly invalid", () => {
    // Guards the inverse mistake: sending `undefined` to a contract that wants
    // an object would fail just as silently.
    for (const action of buildGraph().actions) {
      const input = lookupContract(action.id)!.contract.input;
      const prepared = prepareHandlerInput(action.id, {});
      if (isVoidInput(input)) {
        expect(prepared).toBeUndefined();
      } else if (!isScalarWrapped(input)) {
        expect(prepared).toEqual({});
      }
    }
  });
});

describe("isScalarWrapped / prepareHandlerInput", () => {
  it("detects the wrap", () => {
    expect(isScalarWrapped(z.number())).toBe(true);
    expect(isScalarWrapped(z.object({ appId: z.number() }))).toBe(false);
    expect(isScalarWrapped(z.void())).toBe(false);
  });

  it("unwraps a scalar contract's arguments back to a bare value", () => {
    // `app.getApp` really does take a bare number. Without unwrapping, every
    // scalar-input action fails Zod validation in `createTypedHandler`.
    expect(isScalarWrapped(lookupContract("app.getApp")!.contract.input)).toBe(
      true,
    );
    expect(prepareHandlerInput("app.getApp", { value: 12 })).toBe(12);
  });

  it("leaves object contracts' arguments alone", () => {
    const args = { name: "coffee", initialChatMode: "build" };
    expect(prepareHandlerInput("app.createApp", args)).toBe(args);
  });

  it("passes unknown ids through untouched rather than mangling them", () => {
    const args = { anything: true };
    expect(prepareHandlerInput("does.notExist", args)).toBe(args);
  });
});

describe("buildGraph", () => {
  it("grants exactly the registered contracts and withholds the rest", () => {
    const graph = buildGraph();
    const grantedIds = graph.actions.map((a) => a.id).sort();

    expect(grantedIds).toEqual(Object.keys(ACTION_REGISTRY).sort());
    expect(graph.actions.length + graph.unregistered.length).toBe(
      allContractIds().length,
    );
  });

  it("has no orphaned registry entries", () => {
    // A failure here means the registry names a contract that was renamed or
    // deleted: Marta would be offered a capability the app cannot perform.
    expect(buildGraph().orphaned).toEqual([]);
  });

  it("withholds far more than it grants — default deny is real", () => {
    const graph = buildGraph();
    expect(graph.unregistered.length).toBeGreaterThan(graph.actions.length);
  });

  it("never grants the destructive contracts held back on purpose", () => {
    const graph = buildGraph();
    const granted = new Set(graph.actions.map((a) => a.id));
    for (const forbidden of [
      "system.resetAll",
      "system.clearSessionData",
      "app.deleteApp",
      "chat.deleteChat",
      "marketplace.deleteLocalModel",
      "mediaAi.deleteModel",
      "github.discardChanges",
      "github.deleteBranch",
    ]) {
      expect(granted.has(forbidden)).toBe(false);
    }
  });

  it("gives every action a real channel and an object parameter schema", () => {
    for (const action of buildGraph().actions) {
      const found = lookupContract(action.id);
      expect(found, `${action.id} must resolve to a contract`).not.toBeNull();
      expect(action.channel).toBe(found!.contract.channel);
      expect(action.parameters.type).toBe("object");
    }
  });

  it("derives the confirmation gate from risk and scope", () => {
    // Reading is never gated; reaching outside the app always is.
    expect(getAction("app.listApps")!.confirm).toBe(false);
    expect(getAction("github.push")!.confirm).toBe(true);
    expect(getAction("workspaceFiles.remove")!.confirm).toBe(true);
    expect(getAction("terminal.write")!.confirm).toBe(true);
  });

  it("honours an explicit confirm override", () => {
    // `godot.start` is host-scoped, so the derived default would gate it —
    // but launching the engine is how you look at the game, and gating it
    // would make the game surface unusable by voice.
    expect(ACTION_REGISTRY["godot.start"].stateScope).toBe("host");
    expect(getAction("godot.start")!.confirm).toBe(false);
  });

  it("keeps every registry entry's derived gate consistent with the rule", () => {
    for (const action of buildGraph().actions) {
      expect(action.confirm).toBe(
        requiresConfirmation(ACTION_REGISTRY[action.id]),
      );
    }
  });

  it("memoises", () => {
    expect(buildGraph()).toBe(buildGraph());
  });
});

describe("isGranted", () => {
  it("is the gate a hallucinated action name hits", () => {
    expect(isGranted("app.listApps")).toBe(true);
    expect(isGranted("app.deleteEverything")).toBe(false);
    expect(isGranted("system.resetAll")).toBe(false);
  });
});
