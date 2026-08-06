/**
 * Drift guards.
 *
 * The capability graph is only trustworthy if it stays a complete, accurate
 * picture of the app. Two ways it can quietly stop being one:
 *
 *   1. Someone adds a domain to the `ipc` namespace and forgets
 *      `CONTRACT_SOURCES`. The feature becomes invisible to Marta — which
 *      looks, from a user's side, exactly like the feature not existing.
 *   2. Someone renames or removes a route. A surface then points at nothing
 *      and summoning it falls through to `NotFoundRedirect`. This has already
 *      happened once: `spaces.ts` pointed the 3D nav item at `/threedassets`
 *      while the route is `/3dassets`, and nothing caught it.
 *
 * Both are checked here by reading the real sources rather than by convention.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { CONTRACT_SOURCES } from "./contract_sources";
import { SURFACES } from "./surfaces";

const SRC = path.resolve(__dirname, "../../..");

/**
 * Domains in `ipc` that this mirror deliberately skips: the streams and the
 * event bus, which have no `*Contracts` object; and `marta` herself, since
 * granting her her own graph-inspection endpoints would be circular.
 */
const NON_CONTRACT_IPC_KEYS = new Set([
  "chatStream",
  "helpStream",
  "designStudioStream",
  "events",
  "marta",
]);

function readSource(relative: string): string {
  return fs.readFileSync(path.join(SRC, relative), "utf8");
}

/**
 * Parse the `ipc` object's keys straight out of `src/ipc/types/index.ts`.
 *
 * Reading the source rather than importing it: the module builds every client
 * at import time and the point of this test is to catch a *missing* wiring, so
 * it should not depend on that wiring succeeding.
 */
function ipcNamespaceKeys(): string[] {
  const source = readSource("ipc/types/index.ts");
  const start = source.indexOf("export const ipc = {");
  expect(
    start,
    "`export const ipc = {` must exist in index.ts",
  ).toBeGreaterThan(-1);
  const body = source.slice(start, source.indexOf("\n} as const;", start));

  const keys: string[] = [];
  for (const line of body.split("\n")) {
    // Top-level entries only: exactly two spaces of indent, `key: value,`.
    const match = /^ {2}([a-zA-Z][a-zA-Z0-9]*): [a-zA-Z]/.exec(line);
    if (match) keys.push(match[1]);
  }
  return keys;
}

/** Every `path: "..."` declared in `src/routes/`. */
function declaredRoutes(): Set<string> {
  const dir = path.join(SRC, "routes");
  const routes = new Set<string>();

  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      const source = fs.readFileSync(full, "utf8");
      for (const match of source.matchAll(/^\s+path:\s*"([^"]+)"/gm)) {
        routes.add(match[1]);
      }
    }
  };
  walk(dir);
  return routes;
}

describe("contract source drift", () => {
  it("mirrors every invoke-contract domain in the `ipc` namespace", () => {
    const expected = ipcNamespaceKeys().filter(
      (key) => !NON_CONTRACT_IPC_KEYS.has(key),
    );

    expect(expected.length).toBeGreaterThan(40);

    const sources = CONTRACT_SOURCES as Record<string, unknown>;
    const missing = expected.filter((key) => sources[key] === undefined);
    expect(
      missing,
      `These domains are reachable from the renderer but invisible to Marta. ` +
        `Add them to CONTRACT_SOURCES: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("uses the same key the renderer uses, so `domain.method` is a real call site", () => {
    const ipcKeys = new Set(ipcNamespaceKeys());
    const extras = Object.keys(CONTRACT_SOURCES).filter(
      (key) => !ipcKeys.has(key),
    );
    // Only the two documented exceptions may be present.
    expect(extras.sort()).toEqual(["orionAuth", "plan"]);
  });
});

describe("surface drift", () => {
  const routes = declaredRoutes();

  it("finds the routes it is checking against", () => {
    expect(routes.size).toBeGreaterThan(20);
    expect(routes.has("/chat")).toBe(true);
  });

  it("points every surface at a route that exists", () => {
    const broken = SURFACES.filter((s) => !routes.has(s.route));
    expect(
      broken,
      `These surfaces name routes that do not exist and would redirect home: ` +
        broken.map((s) => `${s.id} -> ${s.route}`).join(", "),
    ).toEqual([]);
  });

  it("uses `/3dassets`, the bug that motivated this test", () => {
    const threed = SURFACES.find((s) => s.id === "create.threed");
    expect(threed?.route).toBe("/3dassets");
    expect(routes.has("/threedassets")).toBe(false);
  });

  it("gives every surface a unique id", () => {
    const ids = SURFACES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("does not host the same route from two surfaces", () => {
    // Two surfaces on one route is the old `spaces.ts` failure: the same
    // content reachable two ways, with nothing saying they are the same thing.
    const seen = new Map<string, string>();
    for (const surface of SURFACES) {
      const previous = seen.get(surface.route);
      expect(
        previous,
        `${surface.id} and ${previous} both host ${surface.route}`,
      ).toBeUndefined();
      seen.set(surface.route, surface.id);
    }
  });
});
