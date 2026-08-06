/**
 * What each surface id actually renders, and where it lives.
 *
 * The *list* of surfaces comes from the capability graph in main — the same one
 * Marta plans against — so the palette and Marta can never disagree about what
 * exists. What main cannot supply is a React component, so that mapping lives
 * here, keyed by the same ids. `surface_catalog.test.tsx` fails if the two ever
 * drift.
 *
 * `needsRouteContext` is the one thing the Stage has to know that the graph does
 * not: a surface reading `useSearch({ from })` can only render as the primary
 * pane, because the router has exactly one location and the secondary pane is
 * by definition not at it. Putting one there would throw inside the page rather
 * than fail visibly here.
 */

import { lazy, type ComponentType, type LazyExoticComponent } from "react";

export interface SurfaceComponentEntry {
  /** The page component. Lazy so the Stage does not pull in every page at boot. */
  component: LazyExoticComponent<ComponentType<Record<string, never>>>;
  /**
   * True when the page reads route state directly and therefore only works in
   * the primary pane.
   */
  needsRouteContext?: boolean;
}

/**
 * Surface id → component. Ids match `src/main/marta/graph/surfaces.ts`.
 */
export const SURFACE_COMPONENTS: Readonly<
  Record<string, SurfaceComponentEntry>
> = {
  "build.workspace": {
    component: lazy(() => import("@/pages/chat")),
    // `useSearch({ from: "/chat" })`.
    needsRouteContext: true,
  },
  "build.projects": { component: lazy(() => import("@/pages/apps")) },
  "build.project": {
    component: lazy(() => import("@/pages/app-details")),
    // `useSearch({ from: "/app-details" })`.
    needsRouteContext: true,
  },
  "build.templates": { component: lazy(() => import("@/pages/hub")) },
  "build.library": { component: lazy(() => import("@/pages/library-home")) },
  "build.prompts": { component: lazy(() => import("@/pages/library")) },
  "build.themes": { component: lazy(() => import("@/pages/themes")) },
  "build.design": {
    component: lazy(() => import("@/pages/design-studio")),
  },

  "game.workbench": { component: lazy(() => import("@/pages/game")) },

  "create.studio": { component: lazy(() => import("@/pages/mediaai")) },
  "create.queue": { component: lazy(() => import("@/pages/media-queue")) },
  "create.gallery": { component: lazy(() => import("@/pages/media")) },
  "create.threed": { component: lazy(() => import("@/pages/threedassets")) },

  "engine.cockpit": { component: lazy(() => import("@/pages/inference")) },
  "engine.models": { component: lazy(() => import("@/pages/models-library")) },
  "engine.marketplace": {
    component: lazy(() => import("@/pages/marketplace")),
  },

  "hub.peers": { component: lazy(() => import("@/pages/network")) },
  "hub.shared": { component: lazy(() => import("@/pages/shared-content")) },
  "hub.digest": { component: lazy(() => import("@/pages/dailyaidigest")) },
  "hub.watchdog": { component: lazy(() => import("@/pages/watchdog")) },

  "app.settings": { component: lazy(() => import("@/pages/settings")) },
};

export function surfaceComponent(
  surfaceId: string,
): SurfaceComponentEntry | null {
  return SURFACE_COMPONENTS[surfaceId] ?? null;
}

export function canRenderInSecondaryPane(surfaceId: string): boolean {
  const entry = surfaceComponent(surfaceId);
  return entry !== null && !entry.needsRouteContext;
}
