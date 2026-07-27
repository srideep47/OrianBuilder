import type { ReactNode } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { material, radius } from "./tokens";
import { LButton } from "./Controls";

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  /** Say what to do next, not just that there's nothing here. */
  description?: string;
  action?: ReactNode;
  /** Inline variant for use inside a panel body rather than a whole page. */
  compact?: boolean;
  className?: string;
}

/**
 * The one empty state. Previously every page wrote its own — a bare centred
 * `div`, a bordered card, or a grey paragraph — so "nothing here yet" looked
 * like a different app on every screen.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  compact = false,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center",
        compact ? "gap-2 px-4 py-8" : "gap-3 px-6 py-14",
        className,
      )}
    >
      {icon && (
        <span
          className={cn(
            "flex items-center justify-center text-muted-foreground/70",
            radius.md,
            material.fill,
            material.rim,
            compact
              ? "h-9 w-9 [&_svg]:h-4 [&_svg]:w-4"
              : "h-12 w-12 [&_svg]:h-5 [&_svg]:w-5",
          )}
        >
          {icon}
        </span>
      )}
      <div className="max-w-[46ch]">
        <p
          className={cn(
            "font-semibold text-foreground",
            compact ? "text-[13px]" : "text-sm",
          )}
        >
          {title}
        </p>
        {description && (
          <p className="mt-1 text-[12px] leading-[1.5] text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

export interface LoadingStateProps {
  /** What is loading, e.g. "projects", "model catalog". */
  label?: string;
  compact?: boolean;
  className?: string;
}

/** The one loading state. Text is optional; the spinner carries the meaning. */
export function LoadingState({
  label,
  compact = false,
  className,
}: LoadingStateProps) {
  return (
    <div
      className={cn(
        "flex items-center justify-center gap-2.5 text-muted-foreground",
        compact ? "py-6" : "py-14",
        className,
      )}
      role="status"
      aria-live="polite"
    >
      <Loader2 className="h-4 w-4 animate-spin text-primary" />
      <span className="text-[13px]">
        {label ? `Loading ${label}…` : "Loading…"}
      </span>
    </div>
  );
}

export interface ErrorStateProps {
  title?: string;
  /** The actual failure. Never swallow it — it's what makes the state useful. */
  message: string;
  onRetry?: () => void;
  compact?: boolean;
  className?: string;
}

/** The one error state. Always shows the underlying message plus a way out. */
export function ErrorState({
  title = "Something went wrong",
  message,
  onRetry,
  compact = false,
  className,
}: ErrorStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-3 text-center",
        compact ? "px-4 py-8" : "px-6 py-12",
        className,
      )}
      role="alert"
    >
      <span className="flex h-10 w-10 items-center justify-center rounded-[14px] border border-[var(--cosmos-red)]/30 bg-[var(--cosmos-red)]/12 text-[var(--cosmos-red)]">
        <AlertTriangle className="h-[18px] w-[18px]" />
      </span>
      <div className="max-w-[52ch]">
        <p className="text-sm font-semibold text-foreground">{title}</p>
        <p className="mt-1 break-words text-[12px] leading-[1.5] text-muted-foreground">
          {message}
        </p>
      </div>
      {onRetry && (
        <LButton size="compact" tone="glass" onClick={onRetry}>
          Try again
        </LButton>
      )}
    </div>
  );
}

export interface SkeletonProps {
  className?: string;
}

/** Shape placeholder for content that will arrive. Same material as the rest. */
export function Skeleton({ className }: SkeletonProps) {
  return (
    <div
      className={cn("animate-pulse rounded-[10px] bg-white/[0.07]", className)}
    />
  );
}
