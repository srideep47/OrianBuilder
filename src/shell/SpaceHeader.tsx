import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useSurfaceId } from "./stage/SurfaceContext";
import { useSurfaceCatalog } from "./stage/useSurfaceCatalog";

export interface SpaceHeaderProps {
  /** What this surface is. Required now that nothing can infer it from a route. */
  title?: string;
  /** One line saying what it is for. */
  description?: string;
  /** Right-aligned actions that apply to this surface. */
  actions?: ReactNode;
  /** Status chips shown inline after the title. */
  meta?: ReactNode;
  /** Filters or search, on their own line below the title. */
  toolbar?: ReactNode;
  className?: string;
}

/**
 * A surface's own header: what you are looking at, what it is for, and the
 * actions that apply to it.
 *
 * It used to also carry the navigation — a breadcrumb naming the "space" and a
 * segmented switcher between sibling views, both derived from `spaces.ts`. All
 * of that is gone with the Stage: there are no spaces to be in and no siblings
 * to switch between, because a surface is summoned rather than navigated to.
 *
 * The component survived the change, rather than being deleted and replaced,
 * because nineteen pages render it and the header half was never the problem.
 * Its props are unchanged; only the navigation was removed.
 *
 * Thirteen of those pages never passed a `title` — they relied on the route
 * deriving one. They still do not need to: the fallback now comes from the
 * capability graph, via the surface this pane is rendering. That is strictly
 * better than the thirteen hard-coded strings it replaced, because the header,
 * the command palette and Marta then all name a surface identically by
 * construction.
 */
export function SpaceHeader({
  title,
  description,
  actions,
  meta,
  toolbar,
  className,
}: SpaceHeaderProps) {
  // The pane's surface, not the router's location: the secondary pane renders
  // outside the router, and both panes share one location.
  const surfaceId = useSurfaceId();
  const { byId } = useSurfaceCatalog();
  const surface = surfaceId ? byId.get(surfaceId) : undefined;

  const resolvedTitle = title ?? surface?.title ?? "Orion";
  const resolvedDescription = description ?? surface?.summary;

  return (
    <header className={cn("flex flex-col gap-3 py-3.5", className)}>
      <div className="flex min-w-0 items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h1 className="min-w-0 truncate text-xl font-semibold leading-tight tracking-[-0.012em] text-foreground">
              {resolvedTitle}
            </h1>
            {meta}
          </div>
          {resolvedDescription && (
            <p className="mt-1 max-w-[70ch] text-[13px] leading-[1.5] text-muted-foreground">
              {resolvedDescription}
            </p>
          )}
        </div>
        {actions && (
          <div className="flex shrink-0 items-center gap-2 pt-0.5">
            {actions}
          </div>
        )}
      </div>

      {toolbar && <div className="min-w-0">{toolbar}</div>}
    </header>
  );
}
