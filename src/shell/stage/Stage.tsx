/**
 * The Stage: the whole window, and the only screen.
 *
 * It renders zero, one, or two surfaces and nothing else — no rail, no tabs, no
 * breadcrumb. There is deliberately no way to reach a surface by knowing where
 * it lives; you ask Marta, or you use the palette, and both resolve through the
 * same capability graph.
 *
 * The primary pane is the router's `<Outlet/>` rather than a directly-rendered
 * component. That is what lets ~100 existing `useNavigate` and `<Link>` call
 * sites inside the pages keep working untouched: a navigation from anywhere
 * changes the location, `StageRouterSync` maps that to a surface, and the Stage
 * follows. The router became the deep-link mechanism; it stopped being the
 * navigation *model*.
 */

import { Suspense, useMemo, type ReactNode } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { X } from "lucide-react";

import { LoadingState, material, radius } from "@/components/liquid";
import { cn } from "@/lib/utils";
import {
  closeSecondaryAtom,
  isEmptyLayout,
  stageLayoutAtom,
  type SurfaceRef,
} from "./stage_state";
import { SurfaceScope } from "./SurfaceContext";
import { surfaceComponent } from "./surface_catalog";
import { useSurfaceCatalog } from "./useSurfaceCatalog";

export function Stage({ children }: { children: ReactNode }) {
  const layout = useAtomValue(stageLayoutAtom);
  const closeSecondary = useSetAtom(closeSecondaryAtom);
  const { byId } = useSurfaceCatalog();
  const empty = isEmptyLayout(layout);
  const secondaryTitle = layout.secondary
    ? byId.get(layout.secondary.surfaceId)?.title
    : undefined;

  return (
    <div
      id="stage"
      // The composer floats over the Stage rather than docking beside it, so
      // the Stage has to give back the height it occupies — otherwise every
      // surface's last row sits permanently underneath it.
      className="relative z-0 flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-hidden p-3 min-[1101px]:flex-row"
    >
      <StagePane primary>
        {/* Always mounted, even when the Stage reads as empty: unmounting the
            router's Outlet would tear down the focused page's state every time
            Marta cleared the screen to say something. */}
        <SurfaceScope surfaceId={layout.primary?.surfaceId ?? null}>
          <div
            className={cn("h-full", empty && "pointer-events-none opacity-0")}
          >
            {children}
          </div>
        </SurfaceScope>
        {empty && <RestingState />}
      </StagePane>

      {layout.secondary && (
        <StagePane
          onClose={() => closeSecondary()}
          label={secondaryTitle ?? layout.secondary.surfaceId}
        >
          <SurfaceScope surfaceId={layout.secondary.surfaceId}>
            <SecondarySurface surface={layout.secondary} />
          </SurfaceScope>
        </StagePane>
      )}
    </div>
  );
}

/**
 * One pane of glass. The rounded, translucent frame that used to wrap the whole
 * content area now wraps each pane, so a split reads as two things rather than
 * one thing with a line down it.
 */
function StagePane({
  children,
  primary,
  onClose,
  label,
}: {
  children: React.ReactNode;
  primary?: boolean;
  onClose?: () => void;
  label?: string;
}) {
  return (
    <section
      className={cn(
        "relative flex min-w-0 flex-col overflow-hidden",
        primary
          ? "min-h-[220px] min-w-0 flex-[1.15_1_0%]"
          : "min-h-[200px] flex-[0.85_1_0%] min-[1101px]:w-[42%] min-[1101px]:min-w-[380px]",
        radius.md,
        material.rim,
        material.rimStrong,
        "bg-[color-mix(in_srgb,var(--cosmos-bg)_58%,transparent)]",
        material.blurThick,
        material.sheen,
        "shadow-[0_22px_80px_rgba(0,0,0,0.34)]",
      )}
    >
      {onClose && (
        <div className="flex shrink-0 items-center justify-between border-b border-white/[0.07] px-3 py-1.5">
          <span className="truncate text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
            {label}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close pane"
            className="rounded-full p-1 text-muted-foreground transition-colors hover:bg-white/[0.07] hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </section>
  );
}

function SecondarySurface({ surface }: { surface: SurfaceRef }) {
  const entry = surfaceComponent(surface.surfaceId);

  // Memoised on the id alone: `lazy()` components must be referentially stable
  // or React remounts them on every parent render, which would restart the
  // page's data fetching continuously.
  const Component = useMemo(() => entry?.component, [entry]);

  if (!Component) {
    return (
      <PaneMessage>
        Nothing knows how to render “{surface.surfaceId}”.
      </PaneMessage>
    );
  }
  if (entry?.needsRouteContext) {
    // Guarded rather than attempted: the page would throw inside `useSearch`,
    // and a blank pane with a stack trace in the console is far worse than a
    // sentence explaining why.
    return (
      <PaneMessage>
        This surface can only be shown in the main pane.
      </PaneMessage>
    );
  }

  return (
    <Suspense fallback={<LoadingState label="Opening…" />}>
      <Component {...({} as Record<string, never>)} />
    </Suspense>
  );
}

function PaneMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center px-6 text-center text-[13px] text-muted-foreground">
      {children}
    </div>
  );
}

/**
 * What you see when nothing is on screen.
 *
 * Almost nothing, on purpose. The composer below has the focus and the prompt;
 * repeating a call to action here would just be two things asking to be read
 * first. The suggestions are there because a blank screen with no affordance is
 * a usability failure, not a minimalist virtue.
 */
function RestingState() {
  const { surfaces } = useSurfaceCatalog();
  const shortcut =
    typeof navigator !== "undefined" && /mac/i.test(navigator.platform)
      ? "⌘K"
      : "Ctrl K";

  return (
    <div className="pointer-events-none absolute inset-0 grid place-items-center overflow-hidden px-8 text-center">
      <div
        aria-hidden="true"
        className="absolute h-[min(54vw,540px)] w-[min(54vw,540px)] rounded-full bg-[radial-gradient(circle,rgba(168,140,255,0.15)_0%,rgba(120,180,255,0.07)_32%,transparent_70%)] blur-2xl"
      />
      <div className="relative flex max-w-[48ch] flex-col items-center gap-3">
        <span className="h-2 w-2 rounded-full bg-[var(--cosmos-violet)] shadow-[0_0_22px_rgba(168,140,255,0.9)]" />
        <p className="text-lg font-semibold tracking-[-0.012em] text-foreground/95">
          Ask for anything.
        </p>
        <p className="text-[13px] leading-[1.6] text-foreground/70">
          Marta knows every project, model, tool and pipeline on this machine.
          Describe the outcome and she will pick the way there.
        </p>
        {surfaces.length > 0 && (
          <p className="mt-2 text-[11px] text-foreground/55">
            Press <Kbd>{shortcut}</Kbd> to search {surfaces.length} places by
            name.
          </p>
        )}
      </div>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded-[6px] border border-white/15 bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px]">
      {children}
    </kbd>
  );
}
