/**
 * The Stage's layout, as a value.
 *
 * The old shell's screen was a function of navigation history: you were looking
 * at whatever you had last clicked, and the only way back was the way you came.
 * Here the screen is a function of state — a `StageLayout` that Marta can emit,
 * the palette can set, and either can snapshot and step back through.
 *
 * That is the difference the plan calls "futuristic usability": not that it
 * looks different, but that what is on screen is data rather than a side effect
 * of a click.
 */

import { atom } from "jotai";

export interface SurfaceRef {
  surfaceId: string;
  /** Route search params, e.g. `{ appId: 3 }`. */
  params?: Record<string, unknown>;
}

export interface StageLayout {
  /**
   * The focused surface. Rendered through the router's `<Outlet/>`, so it keeps
   * full route context — `useSearch`, `useParams` and every existing
   * `useNavigate` call site continue to work untouched.
   */
  primary: SurfaceRef | null;
  /**
   * An optional second surface beside it, for "show me X next to Y".
   * Rendered directly rather than through the router, because a router has one
   * location and this pane is by definition not it. Surfaces that need route
   * context declare it, and the Stage refuses to put them here.
   */
  secondary: SurfaceRef | null;
}

export const EMPTY_LAYOUT: StageLayout = { primary: null, secondary: null };

export const stageLayoutAtom = atom<StageLayout>(EMPTY_LAYOUT);

/**
 * Previous layouts, newest last, for stepping back.
 *
 * Bounded because this is a convenience, not an undo log — and because the
 * layouts hold params that can reference deleted projects, so keeping them
 * forever would slowly accumulate broken states.
 */
export const MAX_SNAPSHOTS = 20;
export const stageHistoryAtom = atom<StageLayout[]>([]);

/** True when nothing is on screen and the Stage should show its resting state. */
export function isEmptyLayout(layout: StageLayout): boolean {
  return layout.primary === null && layout.secondary === null;
}

export function sameSurface(
  a: SurfaceRef | null,
  b: SurfaceRef | null,
): boolean {
  if (a === null || b === null) return a === b;
  if (a.surfaceId !== b.surfaceId) return false;
  return JSON.stringify(a.params ?? {}) === JSON.stringify(b.params ?? {});
}

export function sameLayout(a: StageLayout, b: StageLayout): boolean {
  return (
    sameSurface(a.primary, b.primary) && sameSurface(a.secondary, b.secondary)
  );
}

/**
 * Push `next`, recording `current` so it can be stepped back to.
 *
 * Repeats are dropped: re-summoning the surface you are already looking at is
 * extremely common (Marta does it whenever she reasons about the current
 * screen) and would otherwise fill the history with identical entries, making
 * "go back" appear broken.
 */
export function pushLayout(
  history: StageLayout[],
  current: StageLayout,
  next: StageLayout,
): { history: StageLayout[]; layout: StageLayout } {
  if (sameLayout(current, next)) return { history, layout: current };
  const appended = isEmptyLayout(current) ? history : [...history, current];
  return {
    history: appended.slice(-MAX_SNAPSHOTS),
    layout: next,
  };
}

/** Step back one layout, or return unchanged when there is nowhere to go. */
export function popLayout(history: StageLayout[]): {
  history: StageLayout[];
  layout: StageLayout | null;
} {
  if (history.length === 0) return { history, layout: null };
  const layout = history[history.length - 1];
  return { history: history.slice(0, -1), layout };
}

// ─── Write atoms ─────────────────────────────────────────────────────────────

/** Summon a surface into the primary pane. */
export const showSurfaceAtom = atom(null, (get, set, ref: SurfaceRef) => {
  const current = get(stageLayoutAtom);
  const next: StageLayout = { primary: ref, secondary: current.secondary };
  const result = pushLayout(get(stageHistoryAtom), current, next);
  set(stageHistoryAtom, result.history);
  set(stageLayoutAtom, result.layout);
});

/** Give one surface the whole Stage, used when a task is explicitly focused. */
export const focusSurfaceAtom = atom(null, (get, set, ref: SurfaceRef) => {
  const current = get(stageLayoutAtom);
  const next: StageLayout = { primary: ref, secondary: null };
  const result = pushLayout(get(stageHistoryAtom), current, next);
  set(stageHistoryAtom, result.history);
  set(stageLayoutAtom, result.layout);
});

/** Put a surface beside the current one. */
export const splitSurfaceAtom = atom(null, (get, set, ref: SurfaceRef) => {
  const current = get(stageLayoutAtom);
  const next: StageLayout = { primary: current.primary, secondary: ref };
  const result = pushLayout(get(stageHistoryAtom), current, next);
  set(stageHistoryAtom, result.history);
  set(stageLayoutAtom, result.layout);
});

/** Collapse the split back to one pane. */
export const closeSecondaryAtom = atom(null, (get, set) => {
  const current = get(stageLayoutAtom);
  if (!current.secondary) return;
  const next: StageLayout = { primary: current.primary, secondary: null };
  const result = pushLayout(get(stageHistoryAtom), current, next);
  set(stageHistoryAtom, result.history);
  set(stageLayoutAtom, result.layout);
});

/** Clear the Stage. */
export const clearStageAtom = atom(null, (get, set) => {
  const current = get(stageLayoutAtom);
  if (isEmptyLayout(current)) return;
  const result = pushLayout(get(stageHistoryAtom), current, EMPTY_LAYOUT);
  set(stageHistoryAtom, result.history);
  set(stageLayoutAtom, result.layout);
});

/** Step back to the previous layout. */
export const rewindStageAtom = atom(null, (get, set) => {
  const result = popLayout(get(stageHistoryAtom));
  if (!result.layout) return;
  set(stageHistoryAtom, result.history);
  set(stageLayoutAtom, result.layout);
});

/**
 * Set the primary pane *without* recording a snapshot.
 *
 * Used only by the router sync: a location change has already been recorded by
 * whatever caused it, and recording it again would make one action take two
 * presses of "back".
 */
export const syncPrimaryAtom = atom(
  null,
  (get, set, ref: SurfaceRef | null) => {
    const current = get(stageLayoutAtom);
    if (sameSurface(current.primary, ref)) return;
    set(stageLayoutAtom, { primary: ref, secondary: current.secondary });
  },
);
