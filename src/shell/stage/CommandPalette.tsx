/**
 * The keyboard twin of talking to Marta.
 *
 * It resolves through the *same* capability graph she plans against — the same
 * surfaces, the same summaries, the same ids — so keyboard and voice can never
 * drift into offering different things. That is the whole reason this is not
 * just a list of routes: a route list would be a second source of truth, and
 * the first thing it would do is go stale.
 *
 * Deliberately surfaces-only. Actions are not offered here even though the
 * graph has 117 of them: a palette entry that silently deletes a file is a
 * different and much worse product than one that puts something on screen, and
 * the approval flow belongs with Marta where there is room to explain.
 */

import { useEffect, useState } from "react";
import { useSetAtom } from "jotai";
import { Columns2, CornerDownLeft } from "lucide-react";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { showSurfaceAtom, splitSurfaceAtom } from "./stage_state";
import { canRenderInSecondaryPane } from "./surface_catalog";
import { useSurfaceCatalog } from "./useSurfaceCatalog";
import {
  fluidSurfacesAtom,
  taskDeckCollapsedAtom,
  type FluidSurfaceId,
} from "./workspace_state";

const INSTRUMENTS: ReadonlyArray<{
  id: FluidSurfaceId;
  title: string;
  summary: string;
}> = [
  {
    id: "gpu",
    title: "GPU statistics",
    summary: "VRAM, backend and Marta placement",
  },
  {
    id: "pc",
    title: "PC statistics",
    summary: "CPU, memory and machine profile",
  },
  {
    id: "models",
    title: "Model statistics",
    summary: "Companion tier and inference runtime",
  },
  {
    id: "timeline",
    title: "Task timeline",
    summary: "Durable execution milestones",
  },
  { id: "research", title: "Research", summary: "Evidence and web findings" },
];

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const { surfaces } = useSurfaceCatalog();
  const showSurface = useSetAtom(showSurfaceAtom);
  const splitSurface = useSetAtom(splitSurfaceAtom);
  const setFluidSurfaces = useSetAtom(fluidSurfacesAtom);
  const setTaskDeckCollapsed = useSetAtom(taskDeckCollapsedAtom);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      className="w-[min(680px,calc(100vw-32px))] max-w-none border-white/[0.14] bg-[color-mix(in_srgb,var(--cosmos-deep)_82%,transparent)] shadow-[0_32px_100px_rgba(0,0,0,0.58)] backdrop-blur-[48px]"
    >
      <CommandInput placeholder="Go to…" />
      <CommandList className="max-h-[min(62vh,560px)]">
        <CommandEmpty>Nothing matches that.</CommandEmpty>
        <CommandGroup heading="Surfaces">
          {surfaces.map((surface) => (
            <CommandItem
              key={surface.id}
              // A stable hook for tests and for anything that needs to point at
              // a specific entry: the visible text is not unique, because one
              // surface's summary routinely contains another's title.
              data-surface-id={surface.id}
              // Keywords come from the graph, so "gallery" finds the media
              // surface even though the title says "Gallery" and the user
              // typed "images".
              value={`${surface.title} ${surface.summary} ${(surface.keywords ?? []).join(" ")}`}
              onSelect={() => {
                setOpen(false);
                showSurface({ surfaceId: surface.id });
              }}
              className="flex items-center gap-3"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] text-foreground">
                  {surface.title}
                </span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {surface.summary}
                </span>
              </span>
              {canRenderInSecondaryPane(surface.id) && (
                <button
                  type="button"
                  title="Open beside the current surface"
                  aria-label={`Open ${surface.title} beside the current surface`}
                  onClick={(event) => {
                    // Without this the CommandItem's own select fires too and
                    // the surface replaces the pane it was meant to sit beside.
                    event.stopPropagation();
                    setOpen(false);
                    splitSurface({ surfaceId: surface.id });
                  }}
                  className="shrink-0 rounded-[6px] p-1 text-muted-foreground/70 hover:bg-white/[0.07] hover:text-foreground"
                >
                  <Columns2 className="h-3.5 w-3.5" />
                </button>
              )}
              <CornerDownLeft className="h-3 w-3 shrink-0 text-muted-foreground/40" />
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="Instruments">
          {INSTRUMENTS.map((instrument) => (
            <CommandItem
              key={instrument.id}
              data-fluid-surface-id={instrument.id}
              value={`${instrument.title} ${instrument.summary}`}
              onSelect={() => {
                setOpen(false);
                setTaskDeckCollapsed(false);
                setFluidSurfaces((previous) =>
                  previous.some(
                    (surface) =>
                      surface.id === instrument.id && !surface.taskId,
                  )
                    ? previous
                    : [...previous, { id: instrument.id }],
                );
              }}
              className="flex items-center gap-3"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] text-foreground">
                  {instrument.title}
                </span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {instrument.summary}
                </span>
              </span>
              <CornerDownLeft className="h-3 w-3 shrink-0 text-muted-foreground/40" />
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
