/**
 * Builds the capability graph by joining generated contract metadata against
 * the hand-curated permission list.
 *
 * The generated half means the catalogue cannot drift from the app: rename a
 * contract's input field and Marta's parameter schema changes with it, with no
 * second file to remember. The curated half means new contracts are invisible
 * until someone decides they should not be — which is the correct default when
 * the caller is a language model with a microphone.
 *
 * Two shapes need normalising before a tool-calling API will accept them, and
 * both are common in this codebase (measured: 132 void, 27 scalar/union out of
 * 457 contracts):
 *
 *   `z.void()`   → an empty object schema. Tool APIs require an object.
 *   `z.number()` → `{ value: number }`, unwrapped again at invoke time by
 *                  `unwrapScalarInput`. Roughly 30 contracts take a bare id.
 *
 * Building is memoised: the graph is derived from module constants, so it
 * cannot change at runtime, and rebuilding it per turn would waste ~450 Zod
 * conversions for nothing.
 */

import { z } from "zod";
import log from "electron-log";

import { ACTION_REGISTRY } from "./action_registry";
import { CONTRACT_SOURCES, lookupContract } from "./contract_sources";
import { DELEGATES } from "./delegates";
import { SURFACES } from "./surfaces";
import {
  requiresConfirmation,
  type ActionNode,
  type JsonSchema,
  type MartaGraph,
} from "./types";

const logger = log.scope("marta-graph");

/** The key a scalar contract input is wrapped under. */
export const SCALAR_INPUT_KEY = "value";

const EMPTY_OBJECT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

/**
 * Convert a contract's Zod input into a JSON Schema a tool-calling API accepts.
 *
 * `io: "input"` matters: it emits the schema of what a *caller* must supply, so
 * fields with `.default()` come out optional rather than required.
 * `unrepresentable: "any"` keeps `z.date()` (used across the mission contracts)
 * from throwing — the model sends a string and the handler's own Zod
 * validation is what actually enforces the type at the boundary.
 */
export function toParameterSchema(input: z.ZodType): JsonSchema {
  let schema: JsonSchema;
  try {
    schema = z.toJSONSchema(input, {
      io: "input",
      unrepresentable: "any",
    }) as JsonSchema;
  } catch (error) {
    // A schema Zod cannot express as JSON Schema at all. Better to expose the
    // action with no parameters than to drop it from the graph silently —
    // dropping it would look, from Marta's side, exactly like the feature not
    // existing.
    logger.warn("Falling back to an empty schema for an input:", error);
    return { ...EMPTY_OBJECT_SCHEMA };
  }

  delete schema.$schema;

  // `z.void()` and `z.undefined()` both flatten to `{}`.
  if (Object.keys(schema).length === 0) return { ...EMPTY_OBJECT_SCHEMA };

  if (schema.type === "object") return schema;

  return {
    type: "object",
    properties: { [SCALAR_INPUT_KEY]: schema },
    required: [SCALAR_INPUT_KEY],
    additionalProperties: false,
  };
}

/** True when `toParameterSchema` wrapped a non-object input. */
export function isScalarWrapped(input: z.ZodType): boolean {
  const schema = toParameterSchema(input);
  const properties = schema.properties as Record<string, unknown> | undefined;
  return (
    Array.isArray(schema.required) &&
    schema.required.length === 1 &&
    schema.required[0] === SCALAR_INPUT_KEY &&
    properties !== undefined &&
    Object.keys(properties).length === 1
  );
}

/** True when the contract takes no input at all (`z.void()` / `z.undefined()`). */
export function isVoidInput(input: z.ZodType): boolean {
  return input.safeParse(undefined).success && !input.safeParse({}).success;
}

/**
 * Turn the arguments the model sent into what the handler actually expects.
 *
 * The tool schema and the contract disagree by construction, in two ways, and
 * both had to be normalised for the schema to be callable at all:
 *
 *   `z.void()` (132 contracts) is advertised as an empty object because
 *   tool-calling APIs reject a bare `{}` schema. The model dutifully sends
 *   `{}`, and `z.void()` rejects it — "expected void, received object". That
 *   silently broke every no-argument read Marta has.
 *
 *   A bare scalar (27 contracts) is advertised wrapped under `value`, because
 *   tool arguments must be an object. `app.getApp` wants the number itself.
 *
 * Getting either wrong fails inside `createTypedHandler`'s Zod check, which
 * from the model's side looks like the tool being broken — so it retries,
 * identically, until the round cap.
 */
export function prepareHandlerInput(
  actionId: string,
  args: Record<string, unknown>,
): unknown {
  const found = lookupContract(actionId);
  if (!found) return args;
  if (isVoidInput(found.contract.input)) return undefined;
  if (isScalarWrapped(found.contract.input)) return args[SCALAR_INPUT_KEY];
  return args;
}

// ---------------------------------------------------------------------------
// Graph construction
// ---------------------------------------------------------------------------

let cached: MartaGraph | null = null;

export function buildGraph(): MartaGraph {
  if (cached) return cached;

  const actions: ActionNode[] = [];
  const unregistered: string[] = [];
  const seen = new Set<string>();

  for (const [domain, contracts] of Object.entries(CONTRACT_SOURCES)) {
    for (const [method, contract] of Object.entries(contracts)) {
      const id = `${domain}.${method}`;
      seen.add(id);

      const entry = ACTION_REGISTRY[id];
      if (!entry) {
        unregistered.push(id);
        continue;
      }

      actions.push({
        ...entry,
        kind: "action",
        id,
        domain,
        method,
        channel: contract.channel,
        parameters: toParameterSchema(contract.input),
        confirm: requiresConfirmation(entry),
      });
    }
  }

  // A registry entry naming a contract that no longer exists is a real bug:
  // Marta would be told about a capability the app cannot perform, and would
  // "fail" a request it should have routed elsewhere. Surfaced, not swallowed.
  const orphaned = Object.keys(ACTION_REGISTRY).filter((id) => !seen.has(id));
  if (orphaned.length > 0) {
    logger.error(
      `Action registry names ${orphaned.length} contract(s) that do not exist: ${orphaned.join(", ")}`,
    );
  }

  cached = {
    actions: actions.sort((a, b) => a.id.localeCompare(b.id)),
    surfaces: [...SURFACES],
    delegates: [...DELEGATES],
    unregistered: unregistered.sort(),
    orphaned: orphaned.sort(),
  };

  logger.info(
    `Capability graph: ${cached.actions.length} actions granted, ` +
      `${cached.unregistered.length} contracts withheld, ` +
      `${cached.surfaces.length} surfaces, ${cached.delegates.length} delegates.`,
  );

  return cached;
}

/** Test seam. The graph is derived from constants; nothing else invalidates it. */
export function _resetGraphForTests(): void {
  cached = null;
}

/** Resolve one granted action, or null if it is unknown or withheld. */
export function getAction(actionId: string): ActionNode | null {
  return buildGraph().actions.find((a) => a.id === actionId) ?? null;
}

/** True when Marta is permitted to invoke this contract at all. */
export function isGranted(actionId: string): boolean {
  return ACTION_REGISTRY[actionId] !== undefined;
}
