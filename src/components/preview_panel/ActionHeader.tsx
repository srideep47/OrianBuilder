import { useCallback } from "react";
import { useAtom, useAtomValue } from "jotai";
import { useMutation } from "@tanstack/react-query";
import {
  AlertTriangle,
  Code,
  Cog,
  Eye,
  GitBranch,
  Globe,
  ListChecks,
  MoreHorizontal,
  Shield,
  Sparkles,
  Trash2,
  Wrench,
} from "lucide-react";
import { previewModeAtom, selectedAppIdAtom } from "../../atoms/appAtoms";
import { isPreviewOpenAtom } from "@/atoms/viewAtoms";
import { ipc } from "@/ipc/types";
import { useRunApp } from "@/hooks/useRunApp";
import { useSettings } from "@/hooks/useSettings";
import { useCheckProblems } from "@/hooks/useCheckProblems";
import { showError, showSuccess } from "@/lib/toast";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export type PreviewMode =
  | "preview"
  | "code"
  | "git"
  | "design"
  | "plan"
  | "problems"
  | "configure"
  | "publish"
  | "security";

const PANELS: ReadonlyArray<{
  mode: PreviewMode;
  label: string;
  icon: typeof Eye;
  testId: string;
  group: "output" | "workspace" | "delivery";
}> = [
  {
    mode: "preview",
    label: "Preview",
    icon: Eye,
    testId: "preview-mode-button",
    group: "output",
  },
  {
    mode: "problems",
    label: "Problems",
    icon: AlertTriangle,
    testId: "problems-mode-button",
    group: "output",
  },
  {
    mode: "code",
    label: "Files",
    icon: Code,
    testId: "code-mode-button",
    group: "workspace",
  },
  {
    mode: "git",
    label: "Git",
    icon: GitBranch,
    testId: "git-mode-button",
    group: "workspace",
  },
  {
    mode: "design",
    label: "Design",
    icon: Sparkles,
    testId: "design-mode-button",
    group: "workspace",
  },
  {
    mode: "plan",
    label: "Plan",
    icon: ListChecks,
    testId: "plan-mode-button",
    group: "workspace",
  },
  {
    mode: "configure",
    label: "Configure",
    icon: Wrench,
    testId: "configure-mode-button",
    group: "delivery",
  },
  {
    mode: "security",
    label: "Security",
    icon: Shield,
    testId: "security-mode-button",
    group: "delivery",
  },
  {
    mode: "publish",
    label: "Publish",
    icon: Globe,
    testId: "publish-mode-button",
    group: "delivery",
  },
];

/** One compact contextual toolbar replaces the duplicated preview header + rail. */
export const ActionHeader = () => {
  const [previewMode, setPreviewMode] = useAtom(previewModeAtom);
  const [isPreviewOpen, setIsPreviewOpen] = useAtom(isPreviewOpenAtom);
  const selectedAppId = useAtomValue(selectedAppIdAtom);
  const { problemReport } = useCheckProblems(selectedAppId);
  const { restartApp, refreshAppIframe } = useRunApp();
  const { settings } = useSettings();
  const problemCount = problemReport?.problems.length ?? 0;

  const selectPanel = (panel: PreviewMode) => {
    if (previewMode === panel) setIsPreviewOpen(!isPreviewOpen);
    else {
      setPreviewMode(panel);
      setIsPreviewOpen(true);
    }
  };

  const clearSession = useMutation({
    mutationFn: () => ipc.system.clearSessionData(),
    onSuccess: async () => {
      await refreshAppIframe();
      showSuccess("Preview data cleared");
    },
    onError: (error) => showError(`Error clearing preview data: ${error}`),
  });

  const onCleanRestart = useCallback(
    () => restartApp({ removeNodeModules: true }),
    [restartApp],
  );

  return (
    <div className="flex h-11 shrink-0 items-center gap-1 border-b border-border/70 bg-card/55 px-2 backdrop-blur-xl">
      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {PANELS.map(({ mode, label, icon: Icon, testId, group }, index) => {
          const previous = PANELS[index - 1];
          const active = previewMode === mode && isPreviewOpen;
          const badge = mode === "problems" && problemCount > 0;
          return (
            <div key={mode} className="contents">
              {previous && previous.group !== group && (
                <span className="mx-1 h-5 w-px shrink-0 bg-border" />
              )}
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      data-testid={testId}
                      onClick={() => selectPanel(mode)}
                      className={cn(
                        "no-app-region-drag relative inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs font-medium transition-colors",
                        active
                          ? "bg-primary/15 text-primary"
                          : "text-muted-foreground hover:bg-muted/55 hover:text-foreground",
                      )}
                    />
                  }
                >
                  <Icon className="h-3.5 w-3.5" />
                  <span className="hidden 2xl:inline">{label}</span>
                  {badge && (
                    <span className="absolute -right-0.5 -top-0.5 min-w-3.5 rounded-full bg-destructive px-1 text-center text-[9px] leading-3.5 text-destructive-foreground">
                      {problemCount > 99 ? "99+" : problemCount}
                    </span>
                  )}
                </TooltipTrigger>
                <TooltipContent>{label}</TooltipContent>
              </Tooltip>
            </div>
          );
        })}
      </div>

      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger
            render={
              <DropdownMenuTrigger
                data-testid="preview-more-options-button"
                className="no-app-region-drag flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/55 hover:text-foreground"
              />
            }
          >
            <MoreHorizontal className="h-4 w-4" />
          </TooltipTrigger>
          <TooltipContent>Runtime actions</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuItem onClick={onCleanRestart}>
            <Cog className="h-4 w-4" />
            <div>
              <div>Clean rebuild</div>
              <div className="text-xs text-muted-foreground">
                Reinstall dependencies and restart
              </div>
            </div>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => clearSession.mutate()}>
            <Trash2 className="h-4 w-4" />
            <div>
              <div>Clear preview data</div>
              <div className="text-xs text-muted-foreground">
                Reset cookies and local storage
              </div>
            </div>
          </DropdownMenuItem>
          {settings?.runtimeMode2 === "cloud" && (
            <DropdownMenuItem
              onClick={() => restartApp({ recreateSandbox: true })}
            >
              <Cog className="h-4 w-4" /> Recreate cloud sandbox
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};
