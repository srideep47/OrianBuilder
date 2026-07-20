import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  Activity,
  ArrowRight,
  Box,
  Boxes,
  Film,
  FolderOpen,
  Layers3,
  Orbit,
  ServerCog,
} from "lucide-react";
import { ipc } from "@/ipc/types";
import { OrionCommandBar } from "@/components/orion/OrionCommandBar";
import { Button } from "@/components/ui/button";

type RuntimeState = "checking" | "ready" | "available" | "setup";

function statusPresentation(
  status: Awaited<ReturnType<typeof ipc.mediaAi.getStatus>> | null,
): {
  state: RuntimeState;
  label: string;
  detail: string;
} {
  if (!status)
    return {
      state: "checking",
      label: "Checking runtime",
      detail: "Reading local media capabilities…",
    };
  if (status.healthy)
    return {
      state: "ready",
      label: "Runtime ready",
      detail: "Local generation backend is online.",
    };
  if (status.venvExists && status.depsInstalled) {
    return {
      state: "available",
      label: "Ready on demand",
      detail: "Orion will start the backend when the recipe runs.",
    };
  }
  return {
    state: "setup",
    label: "Runtime setup needed",
    detail: "Install the local media runtime from Advanced runtime.",
  };
}

const SHORTCUTS = [
  {
    title: "Generation queue",
    detail: "Long-running storyboards and ordered batch jobs.",
    to: "/library/media-queue" as const,
    icon: Layers3,
  },
  {
    title: "Media library",
    detail: "Review, publish, and reuse finished assets.",
    to: "/library" as const,
    icon: FolderOpen,
  },
  {
    title: "Advanced runtime",
    detail: "Downloads, backend lifecycle, diagnostics, and legacy controls.",
    to: "/media-runtime" as const,
    icon: ServerCog,
  },
] as const;

/**
 * The user-facing media page is command-first. Backend management remains
 * available as an advanced route, but no longer dictates which model/options
 * are visible or fragments generation across several separate forms.
 */
export default function MediaStudioPage() {
  const [status, setStatus] = useState<Awaited<
    ReturnType<typeof ipc.mediaAi.getStatus>
  > | null>(null);

  useEffect(() => {
    let active = true;
    ipc.mediaAi
      .getStatus()
      .then((next) => active && setStatus(next))
      .catch(() => active && setStatus(null));
    return () => {
      active = false;
    };
  }, []);

  const runtime = statusPresentation(status);

  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="mx-auto flex min-h-full w-full max-w-[1440px] flex-col px-4 py-5 sm:px-6 lg:px-8">
        <header className="flex flex-wrap items-center gap-3 border-b border-border/70 pb-4">
          <span className="flex h-10 w-10 items-center justify-center rounded-2xl border border-primary/25 bg-primary/12 text-primary">
            <Film className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.16em] text-primary">
              <Orbit className="h-3 w-3" /> Orion create
            </div>
            <h1 className="mt-0.5 text-xl font-semibold tracking-tight text-foreground">
              Media Studio
            </h1>
            <p className="text-sm text-muted-foreground">
              Describe the outcome, tune a model-aware recipe, and receive every
              result in its Orion session.
            </p>
          </div>
          <div className="flex items-center gap-2 rounded-full border border-border bg-card/65 px-3 py-1.5">
            <span
              className={
                "h-2 w-2 rounded-full " +
                (runtime.state === "ready"
                  ? "bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.65)]"
                  : runtime.state === "setup"
                    ? "bg-amber-400"
                    : "bg-primary")
              }
            />
            <span className="text-xs font-medium text-foreground">
              {runtime.label}
            </span>
          </div>
        </header>

        <div className="grid flex-1 gap-5 pt-5 xl:grid-cols-[minmax(0,1fr)_310px]">
          <main className="min-w-0">
            <section className="mb-4 rounded-[22px] border border-primary/15 bg-gradient-to-br from-primary/[0.09] via-card/55 to-card/35 p-5">
              <div className="flex items-start gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-[0_10px_28px_rgba(168,140,255,0.22)]">
                  <Boxes className="h-4 w-4" />
                </div>
                <div>
                  <h2 className="text-base font-semibold text-foreground">
                    One recipe, complete output
                  </h2>
                  <p className="mt-1 max-w-3xl text-sm leading-relaxed text-muted-foreground">
                    Orion keeps only the active model resident. An explicit
                    media recipe skips the LLM planning load, applies the chosen
                    quality and sampling controls, then saves the result to the
                    session and library.
                  </p>
                  <Button
                    as={Link}
                    to="/3dassets"
                    variant="outline"
                    size="sm"
                    className="mt-4"
                  >
                    <Box className="h-3.5 w-3.5" />
                    Open 3D model generation
                    <ArrowRight className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </section>

            <OrionCommandBar initialFocus="media" />
          </main>

          <aside className="space-y-3">
            <section className="rounded-[20px] border border-border bg-card/55 p-4">
              <div className="flex items-center gap-2">
                <Activity className="h-4 w-4 text-primary" />
                <h2 className="text-sm font-semibold text-foreground">
                  Local runtime
                </h2>
              </div>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                {runtime.detail}
              </p>
              <div className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
                <div className="rounded-xl bg-muted/30 p-2.5">
                  <div className="text-muted-foreground">Residency</div>
                  <div className="mt-0.5 font-medium text-foreground">
                    One model
                  </div>
                </div>
                <div className="rounded-xl bg-muted/30 p-2.5">
                  <div className="text-muted-foreground">Preference</div>
                  <div className="mt-0.5 font-medium text-foreground">
                    Local / P2P
                  </div>
                </div>
              </div>
            </section>

            <section className="overflow-hidden rounded-[20px] border border-border bg-card/55">
              <div className="border-b border-border/70 px-4 py-3">
                <h2 className="text-sm font-semibold text-foreground">
                  Workspace
                </h2>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  Management stays nearby without crowding the recipe.
                </p>
              </div>
              <div className="p-1.5">
                {SHORTCUTS.map(({ title, detail, to, icon: Icon }) => (
                  <Link
                    key={title}
                    to={to}
                    className="group flex items-center gap-3 rounded-2xl px-3 py-3 transition-colors hover:bg-muted/40"
                  >
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-border bg-background/50 text-muted-foreground transition-colors group-hover:border-primary/25 group-hover:text-primary">
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs font-medium text-foreground">
                        {title}
                      </span>
                      <span className="mt-0.5 block text-[10px] leading-snug text-muted-foreground">
                        {detail}
                      </span>
                    </span>
                    <ArrowRight className="h-3.5 w-3.5 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5" />
                  </Link>
                ))}
              </div>
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}
