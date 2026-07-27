import { useCallback } from "react";
import { useAtom, useAtomValue } from "jotai";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  AlertTriangle,
  ChevronRight,
  Code,
  Cog,
  Eye,
  Gamepad2,
  GitBranch,
  Globe,
  ListChecks,
  MoreHorizontal,
  PanelRightClose,
  Shield,
  Sparkles,
  SquareTerminal,
  Trash2,
  Wrench,
} from "lucide-react";
import { previewModeAtom, selectedAppIdAtom } from "../../atoms/appAtoms";
import { isPreviewOpenAtom } from "@/atoms/viewAtoms";
import { ipc } from "@/ipc/types";
import { useRunApp } from "@/hooks/useRunApp";
import { useLoadApps } from "@/hooks/useLoadApps";
import { useSettings } from "@/hooks/useSettings";
import { useCheckProblems } from "@/hooks/useCheckProblems";
import { showError, showSuccess } from "@/lib/toast";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { LIconButton, radius } from "@/components/liquid";

export type PreviewMode =
  | "preview"
  | "code"
  | "git"
  | "design"
  | "plan"
  | "problems"
  | "configure"
  | "publish"
  | "security"
  | "game"
  | "terminal";

type DockGroup = "output" | "source" | "delivery";

interface DockPanel {
  mode: PreviewMode;
  label: string;
  /** Shown in the tooltip. Says what the panel is for, not what it is called. */
  hint: string;
  icon: typeof Eye;
  testId: string;
  group: DockGroup;
}

/**
 * The dock's panels, in the order work actually flows: see the result, fix what
 * broke, change the source, then ship it.
 */
const PANELS: ReadonlyArray<DockPanel> = [
  {
    mode: "preview",
    label: "Preview",
    hint: "The running app",
    icon: Eye,
    testId: "preview-mode-button",
    group: "output",
  },
  {
    mode: "problems",
    label: "Problems",
    hint: "Type errors and build failures",
    icon: AlertTriangle,
    testId: "problems-mode-button",
    group: "output",
  },
  {
    mode: "game",
    label: "Game",
    hint: "The running Godot engine and its scene",
    icon: Gamepad2,
    testId: "game-mode-button",
    group: "output",
  },
  {
    mode: "code",
    label: "Files",
    hint: "Browse and edit the source",
    icon: Code,
    testId: "code-mode-button",
    group: "source",
  },
  {
    mode: "terminal",
    label: "Terminal",
    hint: "A real shell in this project's folder",
    icon: SquareTerminal,
    testId: "terminal-mode-button",
    group: "source",
  },
  {
    mode: "git",
    label: "Git",
    hint: "Branches, commits and remotes",
    icon: GitBranch,
    testId: "git-mode-button",
    group: "source",
  },
  {
    mode: "design",
    label: "Design",
    hint: "Open Design studio for this project",
    icon: Sparkles,
    testId: "design-mode-button",
    group: "source",
  },
  {
    mode: "plan",
    label: "Plan",
    hint: "The agent's plan graph and its progress",
    icon: ListChecks,
    testId: "plan-mode-button",
    group: "source",
  },
  {
    mode: "configure",
    label: "Config",
    hint: "Environment variables, run commands, database",
    icon: Wrench,
    testId: "configure-mode-button",
    group: "delivery",
  },
  {
    mode: "security",
    label: "Security",
    hint: "Findings across dependencies and code",
    icon: Shield,
    testId: "security-mode-button",
    group: "delivery",
  },
  {
    mode: "publish",
    label: "Publish",
    hint: "Deploy and share this project",
    icon: Globe,
    testId: "publish-mode-button",
    group: "delivery",
  },
];

/**
 * The tool dock's header: which project you're working on, which panel you're
 * looking at, and the runtime actions that apply to it.
 *
 * Two fixes over the previous version. First, labels used to appear only above
 * `2xl` (1536px) — with the conversation panel taking half the window that
 * threshold was never met, so in practice this was nine unlabelled icons in a
 * row. Now the active panel is always named, and the rest carry labels whenever
 * there's room, falling back to icon-plus-tooltip when there isn't. Second, the
 * project name and the runtime actions moved here from the window titlebar,
 * where they applied to nothing on fifteen of the sixteen old destinations.
 */
export const ActionHeader = () => {
  const [previewMode, setPreviewMode] = useAtom(previewModeAtom);
  const [isPreviewOpen, setIsPreviewOpen] = useAtom(isPreviewOpenAtom);
  const selectedAppId = useAtomValue(selectedAppIdAtom);
  const { problemReport } = useCheckProblems(selectedAppId);
  const { restartApp, refreshAppIframe } = useRunApp();
  const { apps } = useLoadApps();
  const { settings } = useSettings();
  const navigate = useNavigate();
  const problemCount = problemReport?.problems.length ?? 0;
  const selectedApp = apps.find((app) => app.id === selectedAppId);

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
    <div className="flex shrink-0 flex-col border-b border-white/[0.07] bg-[color-mix(in_srgb,var(--cosmos-deep)_45%,transparent)] backdrop-blur-[24px]">
      {/* Identity row — what the dock below is acting on. Without it the panels
          are anonymous: nothing on screen said which project's files, git or
          deployment you were looking at. */}
      <div className="flex h-9 items-center gap-2 px-2.5">
        <button
          type="button"
          disabled={!selectedApp}
          onClick={() =>
            selectedApp &&
            navigate({ to: "/app-details", search: { appId: selectedApp.id } })
          }
          className={cn(
            "group flex min-w-0 items-center gap-1.5 rounded-[9px] px-1.5 py-1 text-left outline-none",
            "transition-colors duration-[120ms]",
            selectedApp
              ? "hover:bg-white/[0.07] focus-visible:ring-2 focus-visible:ring-primary/40"
              : "cursor-default",
          )}
        >
          <span className="truncate text-[12px] font-semibold text-foreground">
            {selectedApp?.name ?? "No project selected"}
          </span>
          {selectedApp && (
            <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5" />
          )}
        </button>

        <div className="ml-auto flex shrink-0 items-center gap-1">
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger
                render={
                  <DropdownMenuTrigger
                    data-testid="preview-more-options-button"
                    className="no-app-region-drag flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-white/[0.08] hover:text-foreground"
                  />
                }
              >
                <MoreHorizontal className="h-4 w-4" />
              </TooltipTrigger>
              <TooltipContent>Runtime actions</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" className="w-72">
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
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => restartApp({ recreateSandbox: true })}
                  >
                    <Cog className="h-4 w-4" />
                    <div>
                      <div>Recreate cloud sandbox</div>
                      <div className="text-xs text-muted-foreground">
                        Destroys the current sandbox and starts a new one
                      </div>
                    </div>
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          <LIconButton
            label={isPreviewOpen ? "Collapse the dock" : "Expand the dock"}
            size="compact"
            onClick={() => setIsPreviewOpen(!isPreviewOpen)}
          >
            <PanelRightClose
              className={cn(
                "transition-transform duration-[240ms]",
                !isPreviewOpen && "rotate-180",
              )}
            />
          </LIconButton>
        </div>
      </div>

      {/* Panel row. Groups are separated by a hairline so "see the result",
          "change the source" and "ship it" read as three intents rather than
          nine equally-weighted buttons. */}
      <div
        role="tablist"
        aria-label="Workspace panels"
        className="flex min-w-0 items-center gap-0.5 overflow-x-auto px-2 pb-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {PANELS.map(
          ({ mode, label, hint, icon: Icon, testId, group }, index) => {
            const previous = PANELS[index - 1];
            const active = previewMode === mode && isPreviewOpen;
            const badge = mode === "problems" ? problemCount : 0;
            return (
              <div key={mode} className="contents">
                {previous && previous.group !== group && (
                  <span
                    aria-hidden
                    className="mx-1.5 h-4 w-px shrink-0 bg-white/[0.12]"
                  />
                )}
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        role="tab"
                        aria-selected={active}
                        data-testid={testId}
                        onClick={() => selectPanel(mode)}
                        className={cn(
                          "no-app-region-drag relative inline-flex h-7 shrink-0 items-center gap-1.5 px-2 text-[12px] font-medium outline-none",
                          radius.pill,
                          "transition-colors duration-[120ms] ease-[var(--ease-macos-control)]",
                          active
                            ? "border border-primary/40 bg-primary/18 text-primary"
                            : "border border-transparent text-muted-foreground hover:bg-white/[0.07] hover:text-foreground",
                          "focus-visible:ring-2 focus-visible:ring-primary/45",
                        )}
                      />
                    }
                  >
                    <Icon className="h-3.5 w-3.5 shrink-0" />
                    {/* The active panel is always named; the others reveal their
                      labels as the dock gets wider. */}
                    <span className={active ? "inline" : "hidden xl:inline"}>
                      {label}
                    </span>
                    {badge > 0 && (
                      <span className="min-w-4 rounded-full bg-[var(--cosmos-red)]/22 px-1 text-center font-mono text-[10px] leading-4 tabular-nums text-[var(--cosmos-red)]">
                        {badge > 99 ? "99+" : badge}
                      </span>
                    )}
                  </TooltipTrigger>
                  <TooltipContent>
                    <span className="font-medium">{label}</span>
                    <span className="mt-0.5 block text-xs opacity-80">
                      {hint}
                    </span>
                  </TooltipContent>
                </Tooltip>
              </div>
            );
          },
        )}
      </div>
    </div>
  );
};
