import { useState } from "react";
import { ChevronDown, SlidersHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { material, radius, Stack } from "@/components/liquid";
import { OrionSetupPanel } from "./OrionSetupPanel";
import { OrionModelConfig } from "./OrionModelConfig";
import { OrionStoragePanel } from "./OrionStoragePanel";
import {
  ModelEnginePanel,
  WorkflowsPanel,
  HowItWorksPanel,
} from "./OrionPanels";

/**
 * The controls that used to fill a second "Control Center" page at `/orion`.
 *
 * They are real and worth keeping — provider setup, model tiers, storage
 * locations, the live orchestrator, the workflow catalogue — but on the landing
 * page they competed with the one thing the page exists for: the command box.
 * Behind a disclosure they stay one click away without out-shouting it.
 *
 * Collapsed by default and unmounted while collapsed, so the orchestrator and
 * storage panels don't poll IPC for a surface nobody opened.
 */
export function OrionAdvanced() {
  const [open, setOpen] = useState(false);

  return (
    <section
      className={cn("overflow-hidden", radius.md, material.fill, material.rim)}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "flex w-full items-center gap-3 px-4 py-3 text-left outline-none",
          "transition-colors duration-[120ms] hover:bg-white/[0.05]",
          "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40",
        )}
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[10px] bg-primary/12 text-primary">
          <SlidersHorizontal className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-semibold leading-tight text-foreground">
            Setup and runtime
          </span>
          <span className="mt-0.5 block truncate text-[12px] text-muted-foreground">
            Providers, model tiers, storage, live engine and workflows
          </span>
        </span>
        <ChevronDown
          className={cn(
            "h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-[240ms] ease-[var(--ease-macos)]",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <div className="border-t border-white/[0.07] p-4">
          <Stack gap="base">
            <OrionSetupPanel />
            <OrionModelConfig />
            <ModelEnginePanel />
            <OrionStoragePanel />
            <WorkflowsPanel />
            <HowItWorksPanel />
          </Stack>
        </div>
      )}
    </section>
  );
}
