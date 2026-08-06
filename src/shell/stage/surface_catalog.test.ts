/**
 * The renderer's surface components and main's surface graph must agree.
 *
 * They are two halves of one list that cannot live in one file: main owns the
 * ids, routes and summaries (Marta plans against them); the renderer owns the
 * React components (main cannot hold one). Nothing in the type system connects
 * them, so a surface added to one and not the other would compile cleanly and
 * then render an apology at runtime.
 */

import { describe, expect, it } from "vitest";

import { SURFACES } from "@/main/marta/graph/surfaces";
import {
  canRenderInSecondaryPane,
  SURFACE_COMPONENTS,
  surfaceComponent,
} from "./surface_catalog";

describe("surface catalog", () => {
  it("has a component for every surface in the graph", () => {
    const missing = SURFACES.filter((s) => !surfaceComponent(s.id)).map(
      (s) => s.id,
    );
    expect(
      missing,
      `These surfaces are in the graph — so Marta and the palette will offer ` +
        `them — but nothing renders them: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("has no component for a surface the graph does not define", () => {
    const known = new Set(SURFACES.map((s) => s.id));
    const orphans = Object.keys(SURFACE_COMPONENTS).filter(
      (id) => !known.has(id),
    );
    expect(
      orphans,
      `These components are unreachable — no graph surface names them: ` +
        orphans.join(", "),
    ).toEqual([]);
  });

  it("marks exactly the route-context surfaces as primary-only", () => {
    // These two read `useSearch({ from })`, which throws outside their own
    // route. The Stage checks this flag before putting anything in the
    // secondary pane; getting it wrong is a blank pane and a console trace.
    const primaryOnly = Object.entries(SURFACE_COMPONENTS)
      .filter(([, entry]) => entry.needsRouteContext)
      .map(([id]) => id)
      .sort();
    expect(primaryOnly).toEqual(["build.project", "build.workspace"]);

    expect(canRenderInSecondaryPane("build.workspace")).toBe(false);
    expect(canRenderInSecondaryPane("create.gallery")).toBe(true);
  });

  it("reports an unknown id rather than throwing", () => {
    expect(surfaceComponent("not.a.surface")).toBeNull();
    expect(canRenderInSecondaryPane("not.a.surface")).toBe(false);
  });
});
