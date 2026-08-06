/**
 * The Stage's layout, solved rather than branched.
 *
 * The deck used to express intent with three CSS classes: a `large` tile took the
 * whole row, a `focus` tile took two rows, everything else was one cell of an
 * auto-fit grid. That reads fine with two tasks and falls apart at six — the
 * emphasised tile grows, nothing else shrinks, and the tiles that matter least
 * push the ones that matter most off the bottom of a scroll container.
 *
 * So placement is computed from declared intent: priority decides who is on
 * screen, focus weight decides how much room they get, and anything that does not
 * fit is *collapsed and counted* rather than silently pushed out of view. A
 * layout that quietly drops a failing task is worse than one that admits it ran
 * out of room.
 *
 * Pure, and therefore testable: "does asking for a bigger task one actually
 * shrink the others" is a question about this function, not about a screenshot.
 */

export type SurfaceKind = "task" | "instrument" | "flow" | "status";

export interface SurfaceIntent {
  /** Stable identity across renders; also the React key. */
  key: string;
  kind: SurfaceKind;
  /**
   * Who gets the screen when there is not enough of it. Failing and blocked
   * work outranks healthy work, which outranks finished work.
   */
  priority: number;
  /** 1 is a normal tile. 2 is "make it bigger". 4 is "just show me this". */
  focusWeight: number;
  /** Below this the tile is unreadable, so it collapses instead of shrinking. */
  minColumns: number;
  preferredColumns: number;
  /** False for anything the user must not lose sight of. */
  collapsible: boolean;
  taskId?: string;
}

export interface SolvedTile {
  key: string;
  taskId?: string;
  kind: SurfaceKind;
  /** Grid column span. */
  columns: number;
  /** Grid row span; only a focused tile asks for more than one. */
  rows: number;
}

export interface SolvedLayout {
  /** Total columns in the grid. */
  columns: number;
  tiles: SolvedTile[];
  /** Intents that did not fit, in priority order, so the UI can name them. */
  collapsed: SurfaceIntent[];
}

/** Wide enough for the metric row to read; narrower and it wraps to nonsense. */
export const MIN_TILE_PX = 245;
/**
 * Beyond this many full tiles the deck is a list, not a dashboard.
 *
 * Chosen from the content, not the pixels: each task tile carries five metrics
 * and six instrument buttons, and past four of them nothing is legible at a
 * glance — which is the only thing the deck is for.
 */
export const MAX_FULL_TILES = 4;

/** How many columns a deck of `widthPx` can hold. */
export function columnsForWidth(widthPx: number): number {
  return Math.max(1, Math.min(3, Math.floor(widthPx / MIN_TILE_PX)));
}

/**
 * Solve placement for a set of intents.
 *
 * `maxFullTiles` is a cap on *tiles*, not on work: everything above it is
 * returned in `collapsed` so the caller can render a compact, honest summary.
 */
export function solveStageLayout(
  intents: ReadonlyArray<SurfaceIntent>,
  options: { columns: number; maxFullTiles?: number },
): SolvedLayout {
  const columns = Math.max(1, Math.trunc(options.columns));
  const maxFullTiles = Math.max(1, options.maxFullTiles ?? MAX_FULL_TILES);

  // Stable sort: priority decides, and original order breaks ties so a tile does
  // not jump position every time a status update rewrites `updatedAt`.
  const ordered = intents
    .map((intent, index) => ({ intent, index }))
    .sort(
      (left, right) =>
        right.intent.priority - left.intent.priority ||
        left.index - right.index,
    )
    .map((entry) => entry.intent);

  const kept: SurfaceIntent[] = [];
  const collapsed: SurfaceIntent[] = [];
  for (const intent of ordered) {
    // A non-collapsible intent is always kept, even past the cap: "you have run
    // out of room" must never be the reason a failure is invisible.
    if (kept.length < maxFullTiles || !intent.collapsible) {
      kept.push(intent);
    } else {
      collapsed.push(intent);
    }
  }

  const tiles: SolvedTile[] = kept.map((intent) => {
    const requested = Math.round(intent.preferredColumns * intent.focusWeight);
    return {
      key: intent.key,
      taskId: intent.taskId,
      kind: intent.kind,
      columns: Math.max(
        Math.min(intent.minColumns, columns),
        Math.min(requested, columns),
      ),
      // Extra height is reserved for a genuinely focused surface. A merely
      // "larger" tile gets width, because width is what its content needs.
      rows: intent.focusWeight >= 4 ? 2 : 1,
    };
  });

  return { columns, tiles, collapsed };
}

/** Visual weight, as the layout commands express it. */
export type TaskEmphasis = "normal" | "large" | "focus";

export function focusWeightFor(emphasis: TaskEmphasis): number {
  return emphasis === "focus" ? 4 : emphasis === "large" ? 2 : 1;
}

/**
 * Priority for one task, from its own state.
 *
 * Attention first, then live work, then finished work. Encoded here rather than
 * inside the component so the ordering rule is one testable statement instead of
 * a comparator buried in a render.
 */
export function taskPriority(task: {
  status: string;
  requiresAttention?: boolean;
  priority?: number;
}): number {
  const base =
    task.requiresAttention || task.status === "failed"
      ? 400
      : task.status === "waiting"
        ? 300
        : task.status === "running" || task.status === "queued"
          ? 200
          : 100;
  // The user's own reprioritisation is a nudge inside a band, not an override of
  // it: a deprioritised failure still outranks a healthy running task.
  return base + Math.max(-50, Math.min(50, task.priority ?? 0));
}
