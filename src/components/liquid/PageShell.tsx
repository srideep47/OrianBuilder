import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { material, pageWidth } from "./tokens";

export interface PageShellProps {
  /**
   * Content width class. `content` for most pages, `wide` for galleries,
   * `prose` for reading-led pages, `full` for tool docks.
   *
   * This is the only place a page width is decided — the old pages each picked
   * their own (`max-w-4xl`, `5xl`, `6xl`, `1440px`), so the app never settled.
   */
  width?: keyof typeof pageWidth;
  /** Header rendered above the scroll area and pinned while the body scrolls. */
  header?: ReactNode;
  /** Fill the pane and let children manage their own scrolling (docks, splits). */
  fill?: boolean;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}

/**
 * Every page's outer frame: one scroll container, one width, one padding scale,
 * and a sticky header slot. Pages supply content, never geometry.
 */
export function PageShell({
  width = "content",
  header,
  fill = false,
  className,
  bodyClassName,
  children,
}: PageShellProps) {
  if (fill) {
    return (
      <div className={cn("flex h-full min-h-0 w-full flex-col", className)}>
        {header}
        <div className={cn("min-h-0 flex-1", bodyClassName)}>{children}</div>
      </div>
    );
  }

  return (
    <div className={cn("flex h-full min-h-0 w-full flex-col", className)}>
      {header && (
        <div
          className={cn(
            "shrink-0 border-b border-white/[0.07]",
            material.blur,
            "bg-[color-mix(in_srgb,var(--cosmos-bg)_62%,transparent)]",
          )}
        >
          <div className={cn("mx-auto w-full px-4 sm:px-6", pageWidth[width])}>
            {header}
          </div>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div
          className={cn(
            "mx-auto w-full px-4 py-4 sm:px-6 sm:py-5",
            pageWidth[width],
            bodyClassName,
          )}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

export interface PageHeaderProps {
  title: string;
  /** One line stating what the page is for. Not decoration — it sets scope. */
  description?: string;
  icon?: ReactNode;
  /** Primary + secondary actions, right-aligned on the title row. */
  actions?: ReactNode;
  /** A view switcher or filter row rendered on its own line under the title. */
  toolbar?: ReactNode;
  /** Status chips shown inline after the title. */
  meta?: ReactNode;
  className?: string;
}

/**
 * The page title block. Fixed sizes across the whole app so no two pages
 * disagree about how big a page title is — the old ones ranged from `text-lg` to
 * `text-3xl` with and without a `page-title` class.
 */
export function PageHeader({
  title,
  description,
  icon,
  actions,
  toolbar,
  meta,
  className,
}: PageHeaderProps) {
  return (
    <div className={cn("flex flex-col gap-3 py-4", className)}>
      <div className="flex min-w-0 items-start gap-3">
        {icon && (
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-[13px] border border-primary/25 bg-primary/12 text-primary [&_svg]:h-[18px] [&_svg]:w-[18px]">
            {icon}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h1 className="min-w-0 truncate text-xl font-semibold leading-tight tracking-[-0.012em] text-foreground">
              {title}
            </h1>
            {meta}
          </div>
          {description && (
            <p className="mt-1 max-w-[68ch] text-[13px] leading-[1.5] text-muted-foreground">
              {description}
            </p>
          )}
        </div>
        {actions && (
          <div className="flex shrink-0 items-center gap-2">{actions}</div>
        )}
      </div>
      {toolbar && <div className="min-w-0">{toolbar}</div>}
    </div>
  );
}

export interface SectionProps {
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}

/**
 * A titled block inside a page. Sections are separated by 24px and their titles
 * sit at one rank below the page title, so scanning a long page is a single
 * consistent rhythm rather than a pile of competing headings.
 */
export function Section({
  title,
  description,
  action,
  className,
  children,
}: SectionProps) {
  return (
    <section className={cn("min-w-0", className)}>
      <div className="mb-3 flex min-w-0 items-end gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] font-semibold leading-tight tracking-[-0.006em] text-foreground">
            {title}
          </h2>
          {description && (
            <p className="mt-0.5 max-w-[72ch] text-[12px] leading-[1.45] text-muted-foreground">
              {description}
            </p>
          )}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {children}
    </section>
  );
}

export interface StackProps {
  /** Vertical spacing step between children. */
  gap?: "tight" | "row" | "base" | "section" | "major";
  className?: string;
  children: ReactNode;
}

const stackGap = {
  tight: "gap-2",
  row: "gap-3",
  base: "gap-4",
  section: "gap-6",
  major: "gap-8",
} as const;

/** Vertical stack on the rhythm scale. Keeps ad-hoc margins out of pages. */
export function Stack({ gap = "section", className, children }: StackProps) {
  return (
    <div className={cn("flex min-w-0 flex-col", stackGap[gap], className)}>
      {children}
    </div>
  );
}

export interface ToolbarProps {
  /** Left-aligned group: view switchers, filters, search. */
  children: ReactNode;
  /** Right-aligned group: actions. */
  end?: ReactNode;
  className?: string;
}

/** A single-line control strip. Wraps rather than overflowing off-screen. */
export function Toolbar({ children, end, className }: ToolbarProps) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-2 pb-3",
        className,
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {children}
      </div>
      {end && (
        <div className="ml-auto flex shrink-0 items-center gap-2">{end}</div>
      )}
    </div>
  );
}
