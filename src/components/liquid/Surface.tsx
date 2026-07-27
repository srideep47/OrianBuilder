import { forwardRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { material, motion, radius } from "./tokens";

type Elevation = "flat" | "raised" | "floating";
type SurfaceRadius = keyof typeof radius;

export interface SurfaceProps extends Omit<
  React.HTMLAttributes<HTMLDivElement>,
  "title"
> {
  /** Corner radius step. `lg` for page panels, `md` for cards, `sm` for controls. */
  corner?: SurfaceRadius;
  /**
   * `flat` sits in the page, `raised` adds a soft lift, `floating` also blurs
   * whatever scrolls behind it — use it only for chrome that overlaps content.
   */
  elevation?: Elevation;
  /** Brighter lensing fill, for surfaces that need to read as the foreground. */
  strong?: boolean;
  /** Violet-tinted fill and rim, for the selected item in a set. */
  selected?: boolean;
  children?: ReactNode;
}

/**
 * The base Liquid material: a clipped box with a vertical lensing fill (light
 * enters at the top edge), a specular 1px rim, and an inner top highlight.
 *
 * Mirrors `Modifier.liquidGlass` in Android's `core/design/Liquid.kt`.
 */
export const Surface = forwardRef<HTMLDivElement, SurfaceProps>(
  (
    {
      corner = "md",
      elevation = "flat",
      strong = false,
      selected = false,
      className,
      children,
      ...rest
    },
    ref,
  ) => (
    <div
      ref={ref}
      className={cn(
        radius[corner],
        selected
          ? cn(material.fillSelected, material.rimSelected)
          : cn(strong ? material.fillStrong : material.fill, material.rim),
        material.sheen,
        elevation === "raised" && material.liftSm,
        elevation === "floating" && cn(material.blur, material.lift),
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  ),
);
Surface.displayName = "Surface";

export interface PanelProps extends SurfaceProps {
  /** Persistent panel title. Every panel says what it is. */
  title?: ReactNode;
  /** One line of context under the title. */
  subtitle?: ReactNode;
  /** Actions pinned to the right of the header row. */
  actions?: ReactNode;
  /** Icon rendered left of the title. */
  icon?: ReactNode;
  /** Drop the inner padding — for panels whose body is a list or an iframe. */
  flush?: boolean;
  /** Make the body scroll instead of the page. */
  scrollBody?: boolean;
  bodyClassName?: string;
}

/**
 * A titled page-level panel. The header is part of the primitive so no screen
 * has to re-invent the "label + subtitle + actions" row, which is where the old
 * pages diverged most.
 */
export function Panel({
  title,
  subtitle,
  actions,
  icon,
  flush = false,
  scrollBody = false,
  className,
  bodyClassName,
  children,
  corner = "lg",
  ...rest
}: PanelProps) {
  const hasHeader = Boolean(title || actions);
  return (
    <Surface
      corner={corner}
      className={cn("flex min-h-0 min-w-0 flex-col", className)}
      {...rest}
    >
      {hasHeader && (
        <div className="flex min-h-[46px] shrink-0 items-center gap-3 border-b border-white/[0.07] px-4 py-2.5">
          {icon && (
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[10px] bg-primary/12 text-primary [&_svg]:h-3.5 [&_svg]:w-3.5">
              {icon}
            </span>
          )}
          <div className="min-w-0 flex-1">
            {title && (
              <div className="truncate text-[13px] font-semibold leading-tight text-foreground">
                {title}
              </div>
            )}
            {subtitle && (
              <div className="truncate text-[11px] leading-[1.35] text-muted-foreground">
                {subtitle}
              </div>
            )}
          </div>
          {actions && (
            <div className="flex shrink-0 items-center gap-1.5">{actions}</div>
          )}
        </div>
      )}
      <div
        className={cn(
          "min-h-0 min-w-0 flex-1",
          !flush && "p-4",
          scrollBody && "overflow-y-auto",
          bodyClassName,
        )}
      >
        {children}
      </div>
    </Surface>
  );
}

export interface CardProps extends SurfaceProps {
  onSelect?: () => void;
  disabled?: boolean;
}

/**
 * A tappable card. Adds the hover lift and press-scale that Android gets from
 * `Modifier.pressable`, and becomes a real button element when interactive so
 * keyboard and screen-reader users get the same affordance.
 */
export function Card({
  onSelect,
  disabled = false,
  selected = false,
  className,
  children,
  corner = "md",
  ...rest
}: CardProps) {
  const interactive = Boolean(onSelect) && !disabled;
  return (
    <Surface
      corner={corner}
      selected={selected}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-disabled={disabled || undefined}
      onClick={interactive ? onSelect : undefined}
      onKeyDown={
        interactive
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect?.();
              }
            }
          : undefined
      }
      className={cn(
        "text-left",
        interactive && [
          "cursor-pointer outline-none",
          motion.hover,
          "hover:border-primary/30 hover:from-white/[0.12] hover:to-white/[0.04]",
          "active:scale-[0.985] active:duration-[80ms]",
          "focus-visible:ring-2 focus-visible:ring-primary/45 focus-visible:ring-offset-0",
        ],
        disabled && "pointer-events-none opacity-50",
        className,
      )}
      {...rest}
    >
      {children}
    </Surface>
  );
}
