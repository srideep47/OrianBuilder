import { forwardRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
  control,
  material,
  motion,
  radius,
  status,
  type StatusTone,
} from "./tokens";

type Size = keyof typeof control;

/* ────────────────────────────── Button ────────────────────────────── */

export type ButtonTone = "primary" | "glass" | "ghost" | "destructive";

export interface LButtonProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "children"
> {
  tone?: ButtonTone;
  size?: Size;
  /** Leading icon. Sized by the button, so pass a bare lucide element. */
  icon?: ReactNode;
  /** Trailing icon — chevrons, external-link marks. */
  trailing?: ReactNode;
  /** Stretch to the container width. */
  block?: boolean;
  children?: ReactNode;
}

const buttonTone: Record<ButtonTone, string> = {
  primary:
    "bg-gradient-to-b from-[var(--cosmos-violet)] to-[var(--cosmos-violet-2)] text-white border border-white/25 shadow-[0_8px_22px_rgba(107,79,216,0.32)] hover:brightness-[1.06]",
  glass: cn(
    material.fillStrong,
    material.rim,
    material.sheen,
    "text-foreground hover:from-white/[0.18] hover:to-white/[0.07]",
  ),
  ghost:
    "border border-transparent text-muted-foreground hover:bg-white/[0.07] hover:text-foreground",
  destructive:
    "bg-gradient-to-b from-[#ff6b76] to-[#d8404c] text-white border border-white/25 shadow-[0_8px_22px_rgba(216,64,76,0.3)] hover:brightness-[1.06]",
};

const buttonPad: Record<Size, string> = {
  compact: "px-2.5 text-[12px]",
  base: "px-3.5 text-[13px]",
  prominent: "px-5 text-sm",
};

const iconSize: Record<Size, string> = {
  compact: "[&_svg]:h-3.5 [&_svg]:w-3.5",
  base: "[&_svg]:h-4 [&_svg]:w-4",
  prominent: "[&_svg]:h-4 [&_svg]:w-4",
};

/**
 * The standard action. A pill with a gradient fill and a specular rim for
 * primary/destructive, the glass material for secondary, and nothing but a
 * hover wash for tertiary — three clearly ranked weights, so a screen can show
 * its hierarchy without inventing new styles.
 */
export const LButton = forwardRef<HTMLButtonElement, LButtonProps>(
  (
    {
      tone = "glass",
      size = "base",
      icon,
      trailing,
      block = false,
      className,
      children,
      ...rest
    },
    ref,
  ) => (
    <button
      ref={ref}
      type="button"
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center gap-2 font-medium outline-none",
        radius.pill,
        control[size],
        buttonPad[size],
        iconSize[size],
        buttonTone[tone],
        motion.hover,
        "active:scale-[0.97] active:duration-[80ms]",
        "focus-visible:ring-2 focus-visible:ring-primary/45",
        "disabled:pointer-events-none disabled:opacity-45",
        block && "w-full",
        className,
      )}
      {...rest}
    >
      {icon}
      {children && <span className="truncate">{children}</span>}
      {trailing}
    </button>
  ),
);
LButton.displayName = "LButton";

/* ──────────────────────────── IconButton ──────────────────────────── */

export interface LIconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required — an icon alone is never self-describing. */
  label: string;
  size?: Size;
  tone?: ButtonTone;
  /** Violet fill, for a toggle that is currently on. */
  active?: boolean;
  children: ReactNode;
}

const iconBoxSize: Record<Size, string> = {
  compact: "h-7 w-7",
  base: "h-[34px] w-[34px]",
  prominent: "h-10 w-10",
};

/** Square icon-only control. Always carries an accessible name via `label`. */
export const LIconButton = forwardRef<HTMLButtonElement, LIconButtonProps>(
  (
    {
      label,
      size = "base",
      tone = "ghost",
      active = false,
      className,
      children,
      ...rest
    },
    ref,
  ) => (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active || undefined}
      className={cn(
        "inline-flex shrink-0 items-center justify-center outline-none",
        radius.pill,
        iconBoxSize[size],
        iconSize[size],
        active
          ? "bg-gradient-to-b from-[var(--cosmos-violet)] to-[var(--cosmos-violet-2)] text-white border border-white/25"
          : buttonTone[tone],
        motion.hover,
        "active:scale-[0.94] active:duration-[80ms]",
        "focus-visible:ring-2 focus-visible:ring-primary/45",
        "disabled:pointer-events-none disabled:opacity-45",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  ),
);
LIconButton.displayName = "LIconButton";

/* ─────────────────────────────── Chip ─────────────────────────────── */

export interface ChipProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "children" | "value"
> {
  selected?: boolean;
  icon?: ReactNode;
  /** Right-aligned count or value, rendered in the mono face. */
  value?: ReactNode;
  children?: ReactNode;
}

/** Small selectable pill: filters, tags, mode switches, suggestion seeds. */
export function Chip({
  selected = false,
  icon,
  value,
  className,
  children,
  ...rest
}: ChipProps) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        "inline-flex h-7 shrink-0 select-none items-center gap-1.5 px-3 text-[12px] font-medium outline-none",
        radius.pill,
        selected
          ? "border border-primary/55 bg-primary/20 text-primary"
          : cn(
              material.fill,
              material.rim,
              "text-foreground/80 hover:text-foreground hover:from-white/[0.12]",
            ),
        motion.hover,
        "active:scale-[0.96] active:duration-[80ms]",
        "focus-visible:ring-2 focus-visible:ring-primary/45",
        "disabled:pointer-events-none disabled:opacity-45",
        "[&_svg]:h-3.5 [&_svg]:w-3.5",
        className,
      )}
      {...rest}
    >
      {icon}
      {children && <span className="truncate">{children}</span>}
      {value != null && (
        <span className="font-mono text-[11px] tabular-nums opacity-70">
          {value}
        </span>
      )}
    </button>
  );
}

/* ───────────────────────────── Segmented ──────────────────────────── */

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
  /** Count badge — used for Problems, queue depth, peer count. */
  badge?: number;
}

export interface SegmentedProps<T extends string> {
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  size?: Exclude<Size, "prominent">;
  /** Equal-width segments. Off by default so long labels don't get squeezed. */
  stretch?: boolean;
  className?: string;
  "aria-label": string;
}

/**
 * iOS-style segmented control on glass. The selected segment gets the violet
 * lens; the track is a single pill so the group reads as one control instead of
 * a row of loose buttons.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  size = "base",
  stretch = false,
  className,
  "aria-label": ariaLabel,
}: SegmentedProps<T>) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 p-[3px]",
        radius.pill,
        material.fill,
        material.rim,
        size === "compact" ? "h-8" : "h-10",
        stretch && "flex w-full",
        className,
      )}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(option.value)}
            className={cn(
              "relative inline-flex h-full min-w-0 items-center justify-center gap-1.5 px-3 font-medium outline-none",
              radius.pill,
              size === "compact" ? "text-[12px]" : "text-[13px]",
              active
                ? "bg-gradient-to-b from-[var(--cosmos-violet)] to-[var(--cosmos-violet-2)] text-white border border-white/25 shadow-[0_4px_14px_rgba(107,79,216,0.3)]"
                : "border border-transparent text-muted-foreground hover:bg-white/[0.07] hover:text-foreground",
              motion.hover,
              "focus-visible:ring-2 focus-visible:ring-primary/45",
              "[&_svg]:h-3.5 [&_svg]:w-3.5",
              stretch && "flex-1",
            )}
          >
            {option.icon}
            <span className="truncate">{option.label}</span>
            {option.badge != null && option.badge > 0 && (
              <span
                className={cn(
                  "ml-0.5 min-w-4 rounded-full px-1 text-center font-mono text-[10px] leading-4 tabular-nums",
                  active
                    ? "bg-white/25 text-white"
                    : "bg-[var(--cosmos-red)]/22 text-[var(--cosmos-red)]",
                )}
              >
                {option.badge > 99 ? "99+" : option.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/* ─────────────────────────────── Badge ────────────────────────────── */

export interface LBadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: StatusTone;
  /** Show a leading state dot — for live/idle/running style labels. */
  dot?: boolean;
  children: ReactNode;
}

/** Compact state label. One shape for every status in the app. */
export function LBadge({
  tone = "neutral",
  dot = false,
  className,
  children,
  ...rest
}: LBadgeProps) {
  const s = status[tone];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium",
        s.bg,
        s.border,
        s.text,
        className,
      )}
      {...rest}
    >
      {dot && <span className={cn("h-1.5 w-1.5 rounded-full", s.dot)} />}
      {children}
    </span>
  );
}

/* ────────────────────────────── Progress ──────────────────────────── */

export interface LProgressProps {
  /** 0–1. Omit for an indeterminate sweep. */
  value?: number;
  tone?: StatusTone;
  className?: string;
  label?: string;
}

/** Thin gradient bar — the only progress indicator in the app. */
export function LProgress({
  value,
  tone = "accent",
  className,
  label,
}: LProgressProps) {
  const pct = value == null ? null : Math.max(0, Math.min(1, value)) * 100;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuenow={pct ?? undefined}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cn(
        "h-1.5 w-full overflow-hidden rounded-full bg-white/[0.09]",
        className,
      )}
    >
      <div
        className={cn(
          "h-full rounded-full",
          tone === "accent"
            ? "bg-gradient-to-r from-[var(--cosmos-violet-2)] to-[var(--cosmos-violet)]"
            : status[tone].dot,
          pct == null
            ? "w-1/3 animate-[liquid-indeterminate_1.4s_ease-in-out_infinite]"
            : "transition-[width] duration-300 ease-[var(--ease-macos)]",
        )}
        style={pct == null ? undefined : { width: `${pct}%` }}
      />
    </div>
  );
}

/* ─────────────────────────────── Input ────────────────────────────── */

export interface LInputProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "size"
> {
  icon?: ReactNode;
  /** Trailing control — a clear button, a unit label, a picker trigger. */
  trailing?: ReactNode;
  size?: Exclude<Size, "compact">;
  wrapperClassName?: string;
}

/**
 * Text field on the glass material. The icon and trailing slots are part of the
 * primitive so search fields stop being hand-assembled per page.
 */
export const LInput = forwardRef<HTMLInputElement, LInputProps>(
  (
    { icon, trailing, size = "base", className, wrapperClassName, ...rest },
    ref,
  ) => (
    <div
      className={cn(
        "flex min-w-0 items-center gap-2 px-3",
        radius.sm,
        control[size],
        material.fill,
        material.rim,
        "focus-within:border-primary/45 focus-within:ring-2 focus-within:ring-primary/20",
        motion.hover,
        "[&>svg]:h-4 [&>svg]:w-4 [&>svg]:shrink-0 [&>svg]:text-muted-foreground",
        wrapperClassName,
      )}
    >
      {icon}
      <input
        ref={ref}
        className={cn(
          "min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground/70",
          className,
        )}
        {...rest}
      />
      {trailing}
    </div>
  ),
);
LInput.displayName = "LInput";
