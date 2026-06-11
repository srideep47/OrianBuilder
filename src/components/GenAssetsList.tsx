import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { Link, useRouterState } from "@tanstack/react-router";
import { Sparkles, Box } from "lucide-react";
import { useSetAtom } from "jotai";
import { sidebarPanelAtom } from "@/atoms/uiAtoms";

type GenAssetsSection = {
  id: string;
  label: string;
  description: string;
  to: string;
  icon: React.ComponentType<{ className?: string }>;
};

const GEN_ASSETS_SECTIONS: GenAssetsSection[] = [
  {
    id: "media-ai",
    label: "Media AI",
    description: "Image, audio, transcription, video, music",
    to: "/mediaai",
    icon: Sparkles,
  },
  {
    id: "3d-assets",
    label: "3D Assets",
    description: "Text-to-3D and image-to-3D models (TripoSR)",
    to: "/3dassets",
    icon: Box,
  },
];

export function GenAssetsList({ show }: { show: boolean }) {
  const routerState = useRouterState();
  const pathname = routerState.location.pathname;
  const setPanel = useSetAtom(sidebarPanelAtom);

  if (!show) {
    return null;
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-shrink-0 p-4">
        <h2 className="text-lg font-semibold tracking-tight">Gen Assets</h2>
        <p className="text-xs text-muted-foreground mt-1">
          Generate media and 3D assets with local models.
        </p>
      </div>
      <ScrollArea className="flex-grow">
        <div className="space-y-1 p-4 pt-0">
          {GEN_ASSETS_SECTIONS.map((section) => {
            const isActive =
              section.to === pathname || pathname.startsWith(section.to);

            return (
              <Link
                key={section.id}
                to={section.to}
                onClick={() => setPanel(null)}
                className={cn(
                  "w-full flex items-start gap-3 px-3 py-2.5 rounded-3xl text-sm transition-colors",
                  isActive
                    ? "bg-sidebar-accent text-sidebar-accent-foreground font-semibold"
                    : "hover:bg-sidebar-accent",
                )}
              >
                <section.icon className="h-4 w-4 mt-0.5 shrink-0" />
                <div className="flex flex-col gap-0.5 min-w-0">
                  <span className="leading-tight">{section.label}</span>
                  <span className="text-[11px] leading-tight text-muted-foreground font-normal">
                    {section.description}
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
