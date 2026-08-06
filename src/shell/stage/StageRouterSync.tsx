/**
 * Keeps the Stage's layout and the router's location in step.
 *
 * Two directions, and they must not fight:
 *
 *   location → Stage   Something inside a page navigated (there are ~100 such
 *                      call sites, and rewriting them all was never worth it).
 *                      The primary pane follows, *without* recording a
 *                      snapshot: whatever caused the navigation already
 *                      recorded one, and recording it twice would make a
 *                      single action take two presses of "back".
 *
 *   Stage → location   Marta or the palette summoned a surface. The router is
 *                      told so deep links, `useSearch` and the pages' own
 *                      navigation stay coherent.
 *
 * The loop terminates because each direction is a no-op when the two already
 * agree — `syncPrimaryAtom` bails on an identical surface, and the navigate is
 * skipped when the location already matches.
 */

import { useEffect, useRef } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useAtomValue, useSetAtom } from "jotai";

import { selectedAppIdAtom } from "@/atoms/appAtoms";
import { useLoadApps } from "@/hooks/useLoadApps";
import { ipc } from "@/ipc/types";
import { stageLayoutAtom, syncPrimaryAtom } from "./stage_state";
import { useSurfaceCatalog } from "./useSurfaceCatalog";

/** Route search params, as a plain object, from whatever the router holds. */
function searchToParams(search: unknown): Record<string, unknown> | undefined {
  if (!search || typeof search !== "object") return undefined;
  const entries = Object.entries(search as Record<string, unknown>).filter(
    ([, value]) => value !== undefined,
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function StageRouterSync() {
  const navigate = useNavigate();
  const { location } = useRouterState();
  const layout = useAtomValue(stageLayoutAtom);
  const syncPrimary = useSetAtom(syncPrimaryAtom);
  const { byId, byRoute, isLoading } = useSurfaceCatalog();

  /**
   * The location this component last drove. Without it, the Stage→location
   * effect re-fires on its own navigation and can undo a params change the
   * page made for itself.
   */
  const drivenHref = useRef<string | null>(null);

  // ── Stage → main ──
  // Marta's world-state digest is rebuilt every turn and needs to know what is
  // on screen and which project it belongs to. Main cannot ask synchronously,
  // so it is pushed on change.
  const selectedAppId = useAtomValue(selectedAppIdAtom);
  const { apps } = useLoadApps();
  useEffect(() => {
    const app = apps?.find((a) => a.id === selectedAppId);
    void ipc.marta
      .setStageState({
        surfaceId: layout.primary?.surfaceId ?? null,
        params: layout.primary?.params,
        alsoShowing: layout.secondary
          ? [layout.secondary.surfaceId]
          : undefined,
        activeProject: app ? { id: app.id, name: app.name } : null,
      })
      .catch(() => {
        // Best effort. A failed push costs her one turn of context, not the
        // turn itself — `collectWorldState` reports the section as degraded.
      });
  }, [layout.primary, layout.secondary, selectedAppId, apps]);

  // ── location → Stage ──
  useEffect(() => {
    if (isLoading) return;
    const surface = byRoute.get(location.pathname);
    syncPrimary(
      surface
        ? {
            surfaceId: surface.id,
            params: searchToParams(location.search),
          }
        : // A route with no surface — `/onboarding`, `/marta-debug` — still
          // renders through the Outlet. It simply is not something Marta can
          // summon, so the Stage holds no reference to it.
          null,
    );
  }, [location.pathname, location.search, byRoute, isLoading, syncPrimary]);

  // ── Stage → location ──
  useEffect(() => {
    if (isLoading) return;
    const primary = layout.primary;
    if (!primary) return;
    const surface = byId.get(primary.surfaceId);
    if (!surface) return;
    if (surface.route === location.pathname) return;

    const href = `${surface.route}:${JSON.stringify(primary.params ?? {})}`;
    if (drivenHref.current === href) return;
    drivenHref.current = href;

    void navigate({
      to: surface.route,
      search: (primary.params ?? {}) as never,
    }).catch(() => {
      // A surface naming a route the router does not have. `drift.test.ts`
      // guards against it, so this is a last resort rather than a path we
      // expect to take.
      drivenHref.current = null;
    });
  }, [layout.primary, byId, isLoading, location.pathname, navigate]);

  return null;
}
