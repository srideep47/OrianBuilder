import { Orbit, Sparkles } from "lucide-react";
import { OrionCommandBar } from "@/components/orion/OrionCommandBar";
import { OrionModelConfig } from "@/components/orion/OrionModelConfig";
import {
  ModelEnginePanel,
  OrionSessionsPanel,
  WorkflowsPanel,
  HowItWorksPanel,
} from "@/components/orion/OrionPanels";

export default function OrionPage() {
  return (
    <div className="h-full w-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-8 sm:px-6 lg:px-8">
        <header className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-primary/30 to-fuchsia-500/20 text-primary">
            <Orbit className="h-6 w-6" />
          </div>
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-bold text-white/95">
              Orion
              <Sparkles className="h-4 w-4 text-primary" />
            </h1>
            <p className="text-sm text-white/50">
              Your command center — one prompt, every workflow, hands-free.
            </p>
          </div>
        </header>

        <OrionCommandBar />

        <OrionModelConfig />
        <ModelEnginePanel />
        <OrionSessionsPanel />
        <WorkflowsPanel />
        <HowItWorksPanel />
      </div>
    </div>
  );
}
