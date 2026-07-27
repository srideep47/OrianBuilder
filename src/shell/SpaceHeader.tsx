import type { ReactNode } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import { material, radius } from "@/components/liquid";
import { spaceForPath, viewForPath, type SpaceView } from "./spaces";

export interface SpaceHeaderProps {
  /** Page title. Defaults to the active view's label. */
  title?: string;
  /** Overrides the view hint. Say what this page is for in one line. */
  description?: string;
  /** Right-aligned page actions. */
  actions?: ReactNode;
  /** Status chips shown inline after the title. */
  meta?: ReactNode;
  /** Filters or search, on their own line below the switcher. */
  toolbar?: ReactNode;
  className?: string;
}

/**
 * Every page's header: which space you are in, which view of it you are looking
 * at, what this view is for, and the actions that apply to it.
 *
 * The view switcher lives here rather than in the nav rail because that is the
 * only place it can be labelled honestly — a rail item can say "Create" but not
 * "Create → Queue", which is why the old shell ended up hiding twelve
 * destinations behind an unlabelled grid popover.
 */
export function SpaceHeader({
  title,
  description,
  actions,
  meta,
  toolbar,
  className,
}: SpaceHeaderProps) {
  const { location } = useRouterState();
  const pathname = location.pathname;
  const space = spaceForPath(pathname);
  const view = space ? viewForPath(space, pathname) : null;

  const resolvedTitle = title ?? view?.label ?? space?.label ?? "Orion";
  const resolvedDescription =
    description ?? view?.hint ?? space?.purpose ?? undefined;

  return (
    <header className={cn("flex flex-col gap-3 py-3.5", className)}>
      <div className="flex min-w-0 items-start gap-3">
        <div className="min-w-0 flex-1">
          {/* Breadcrumb, not a decorative eyebrow: it names the space so the
              title below it can be short. */}
          {space && (
            <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.1em] text-primary/85">
              <space.icon className="h-3 w-3 shrink-0" />
              <span className="truncate">{space.label}</span>
            </div>
          )}
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

      {space && space.views.length > 1 && (
        <ViewSwitcher
          views={space.views}
          activeTo={view?.to ?? space.views[0].to}
        />
      )}

      {toolbar && <div className="min-w-0">{toolbar}</div>}
    </header>
  );
}

/**
 * Segmented control over routes. Real `<Link>`s so middle-click, copy-link and
 * keyboard navigation all work — the previous popover used click handlers, so a
 * destination could not be opened or shared any other way.
 */
function ViewSwitcher({
  views,
  activeTo,
}: {
  views: ReadonlyArray<SpaceView>;
  activeTo: string;
}) {
  return (
    <div
      role="tablist"
      aria-label="Views"
      className={cn(
        "flex w-fit max-w-full items-center gap-0.5 overflow-x-auto p-[3px]",
        radius.pill,
        material.fill,
        material.rim,
        "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
      )}
    >
      {views.map((view) => {
        const active = view.to === activeTo;
        const Icon = view.icon;
        return (
          <Link
            key={view.to}
            to={view.to}
            role="tab"
            aria-selected={active}
            className={cn(
              "inline-flex h-8 shrink-0 items-center gap-1.5 px-3 text-[12px] font-medium outline-none",
              radius.pill,
              "transition-colors duration-[120ms] ease-[var(--ease-macos-control)]",
              active
                ? "border border-white/25 bg-gradient-to-b from-[var(--cosmos-violet)] to-[var(--cosmos-violet-2)] text-white shadow-[0_4px_14px_rgba(107,79,216,0.3)]"
                : "border border-transparent text-muted-foreground hover:bg-white/[0.07] hover:text-foreground",
              "focus-visible:ring-2 focus-visible:ring-primary/45",
            )}
          >
            <Icon className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{view.label}</span>
          </Link>
        );
      })}
    </div>
  );
}
