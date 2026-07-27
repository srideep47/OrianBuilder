import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { material, motion, radius } from "./tokens";

export interface GroupProps {
  /** Section label rendered above the container, in the micro caps style. */
  title?: string;
  /** One line explaining the group, below the title. */
  description?: string;
  /** Right-aligned action for the whole group. */
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}

/**
 * iOS-style grouped list: a label outside, a single rounded container inside,
 * rows separated by inset hairlines. Replaces the assorted `space-y-*` stacks of
 * individually-bordered cards that the settings and panel screens used.
 *
 * Mirrors `LiquidGroup` in Android's `core/design/Liquid.kt`.
 */
export function Group({
  title,
  description,
  action,
  className,
  children,
}: GroupProps) {
  return (
    <section className={cn("min-w-0", className)}>
      {(title || action) && (
        <div className="mb-2 flex items-end gap-3 px-1">
          <div className="min-w-0 flex-1">
            {title && (
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                {title}
              </h3>
            )}
            {description && (
              <p className="mt-0.5 text-[12px] leading-[1.4] text-muted-foreground/80">
                {description}
              </p>
            )}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </div>
      )}
      <div
        className={cn(
          "overflow-hidden",
          radius.md,
          material.fill,
          material.rim,
          material.sheen,
          "[&>*+*]:border-t [&>*+*]:border-white/[0.06]",
        )}
      >
        {children}
      </div>
    </section>
  );
}

export interface RowProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Leading icon or avatar. */
  leading?: ReactNode;
  /** Trailing control: switch, select, value, chevron. */
  trailing?: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  /** Tighter vertical padding, for dense lists like file rows or peers. */
  dense?: boolean;
  className?: string;
  /** Extra content below the title block — a progress bar, a chip row. */
  children?: ReactNode;
}

/**
 * A row inside a `Group`. The title/subtitle column always truncates and the
 * trailing slot never shrinks, so a long project path can't push a switch off
 * the edge — the failure mode that made the old settings rows overflow.
 */
export function Row({
  title,
  subtitle,
  leading,
  trailing,
  onClick,
  disabled = false,
  dense = false,
  className,
  children,
}: RowProps) {
  const interactive = Boolean(onClick) && !disabled;
  const Tag = interactive ? "button" : "div";
  return (
    <Tag
      {...(interactive
        ? { type: "button" as const, onClick, disabled }
        : { "aria-disabled": disabled || undefined })}
      className={cn(
        "flex w-full min-w-0 items-center gap-3 px-4 text-left outline-none",
        dense ? "py-2" : "py-3",
        interactive && [
          motion.hover,
          "hover:bg-white/[0.05] focus-visible:bg-white/[0.06]",
          "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40",
        ],
        disabled && "opacity-50",
        className,
      )}
    >
      {leading && (
        <span className="flex shrink-0 items-center justify-center text-muted-foreground [&_svg]:h-4 [&_svg]:w-4">
          {leading}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium leading-tight text-foreground">
          {title}
        </span>
        {subtitle && (
          <span className="mt-0.5 block truncate text-[12px] leading-[1.4] text-muted-foreground">
            {subtitle}
          </span>
        )}
        {children && <span className="mt-2 block">{children}</span>}
      </span>
      {trailing && (
        <span className="flex shrink-0 items-center gap-2 text-[12px] text-muted-foreground">
          {trailing}
        </span>
      )}
    </Tag>
  );
}

export interface StatTileProps {
  label: string;
  value: ReactNode;
  /** Small delta or context line under the value. */
  hint?: ReactNode;
  icon?: ReactNode;
  className?: string;
}

/**
 * A single measurement. Values use the mono face with tabular figures so a row
 * of tiles stays optically aligned as numbers change — the thing that made the
 * old inference and network readouts jitter.
 */
export function StatTile({
  label,
  value,
  hint,
  icon,
  className,
}: StatTileProps) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-1 px-3.5 py-3",
        radius.sm,
        material.fill,
        material.rim,
        className,
      )}
    >
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
        {icon && <span className="[&_svg]:h-3 [&_svg]:w-3">{icon}</span>}
        <span className="truncate">{label}</span>
      </div>
      <div className="truncate font-mono text-[17px] font-semibold leading-tight tabular-nums text-foreground">
        {value}
      </div>
      {hint && (
        <div className="truncate text-[11px] leading-[1.35] text-muted-foreground/80">
          {hint}
        </div>
      )}
    </div>
  );
}
