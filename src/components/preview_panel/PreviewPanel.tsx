import { useAtom, useAtomValue } from "jotai";
import {
  appConsoleEntriesAtom,
  previewModeAtom,
  previewPanelKeyAtom,
  selectedAppIdAtom,
} from "../../atoms/appAtoms";
import {
  pdfPreviewDataAtom,
  PDF_GENERATING_SENTINEL,
} from "@/lib/pdfGenerator";
import {
  PdfPreviewMessage,
  PdfGeneratingMessage,
} from "@/components/chat/PdfPreviewMessage";

import { CodeView } from "./CodeView";
import { ElectronPreviewPanel } from "./ElectronPreviewPanel";
import { ExpoPreviewPanel } from "./ExpoPreviewPanel";
import { PreviewIframe } from "./PreviewIframe";
import { Problems } from "./Problems";
import { ConfigurePanel } from "./ConfigurePanel";
import { ChevronDown, ChevronUp, Logs } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { PanelGroup, Panel, PanelResizeHandle } from "react-resizable-panels";
import { Console } from "./Console";
import { useRunApp } from "@/hooks/useRunApp";
import { PublishPanel } from "./PublishPanel";
import { SecurityPanel } from "./SecurityPanel";
import { PlanPanel } from "./PlanPanel";
import { useSupabase } from "@/hooks/useSupabase";
import { useTranslation } from "react-i18next";
import { ipc } from "@/ipc/types";
import { EmptyState, LoadingState } from "@/components/liquid";
import { GitBranch } from "lucide-react";
import { ActionHeader } from "./ActionHeader";

const LazyGitHubConnector = lazy(() =>
  import("@/components/GitHubConnector").then((module) => ({
    default: module.GitHubConnector,
  })),
);
const LazyDesignStudio = lazy(() => import("@/pages/design-studio"));
// Lazy: pulls in the viewport poller and scene tree, which nobody needs until
// they actually open a game.
const LazyGamePanel = lazy(() =>
  import("./GamePanel").then((m) => ({ default: m.GamePanel })),
);
// Lazy: xterm plus its CSS is ~250 KB, and most sessions never open a shell.
const LazyTerminalPanel = lazy(() =>
  import("./TerminalPanel").then((m) => ({ default: m.TerminalPanel })),
);

function PanelLoading({ label }: { label: string }) {
  return (
    <div className="flex h-full items-center justify-center">
      <LoadingState label={label} />
    </div>
  );
}

interface ConsoleHeaderProps {
  isOpen: boolean;
  onToggle: () => void;
  latestMessage?: string;
  entryCount: number;
}

/**
 * The console drawer's handle. Doubles as a status line when collapsed: the
 * latest message and a count, so you can tell whether opening it is worth it.
 * Previously the collapsed state clipped the message at a fixed 200px with no
 * count, which made it noise rather than information.
 */
const ConsoleHeader = ({
  isOpen,
  onToggle,
  latestMessage,
  entryCount,
}: ConsoleHeaderProps) => {
  const { t } = useTranslation("home");
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={isOpen}
      className="flex h-9 w-full shrink-0 items-center gap-2 border-t border-white/[0.07] px-3 text-left outline-none transition-colors hover:bg-white/[0.05] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40"
    >
      <Logs size={14} className="shrink-0 text-muted-foreground" />
      <span className="shrink-0 text-[12px] font-medium text-foreground">
        {t("preview.systemMessages")}
      </span>
      {entryCount > 0 && (
        <span className="shrink-0 rounded-full bg-white/[0.09] px-1.5 font-mono text-[10px] leading-4 tabular-nums text-muted-foreground">
          {entryCount > 999 ? "999+" : entryCount}
        </span>
      )}
      {!isOpen && latestMessage && (
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground/80">
          {latestMessage}
        </span>
      )}
      <span className="ml-auto shrink-0 text-muted-foreground">
        {isOpen ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
      </span>
    </button>
  );
};

// Main PreviewPanel component
export function PreviewPanel() {
  const [previewMode] = useAtom(previewModeAtom);
  const selectedAppId = useAtomValue(selectedAppIdAtom);
  const [isConsoleOpen, setIsConsoleOpen] = useState(false);
  const { runApp, loading, app } = useRunApp();
  const key = useAtomValue(previewPanelKeyAtom);
  const consoleEntries = useAtomValue(appConsoleEntriesAtom);
  const [pdfPreviewData, setPdfPreviewData] = useAtom(pdfPreviewDataAtom);

  const latestMessage =
    consoleEntries.length > 0
      ? consoleEntries[consoleEntries.length - 1]?.message
      : undefined;

  // Notify backend about app selection changes (for garbage collection tracking)
  const notifyAppSelected = useCallback(async (appId: number | null) => {
    try {
      await ipc.app.selectAppForPreview({ appId });
    } catch (error) {
      console.error("Failed to notify app selection:", error);
    }
  }, []);

  useSupabase({
    edgeLogsProjectId: app?.supabaseProjectId,
    edgeLogsOrganizationSlug: app?.supabaseOrganizationSlug,
    edgeLogsAppId: app?.id,
  });

  useEffect(() => {
    let cancelled = false;

    const handleAppSelection = async () => {
      // Notify backend which app is currently selected (for GC tracking)
      await notifyAppSelected(selectedAppId);

      // If the effect was cleaned up while awaiting, don't proceed
      if (cancelled) return;

      // Start the app if it's selected
      // The backend will handle the case where the app is already running
      if (selectedAppId !== null) {
        console.debug(
          "Running app (will start if not already running)",
          selectedAppId,
        );
        runApp(selectedAppId);
      }
    };

    handleAppSelection();

    return () => {
      cancelled = true;
      // Notify backend that no app is being previewed so GC can reclaim idle apps
      notifyAppSelected(null);
    };
    // Note: We no longer stop apps when switching. The backend garbage collector
    // will stop apps that haven't been viewed in 10 minutes.
    // Apps are only stopped explicitly when:
    // 1. User manually stops them
    // 2. App is deleted
    // 3. Garbage collector determines they've been idle too long
  }, [selectedAppId, runApp, notifyAppSelected]);

  // Note: We no longer stop all apps on unmount. The garbage collector
  // will handle cleanup of idle apps, and users may want apps to keep
  // running in the background.

  return (
    <div className="flex flex-col h-full">
      <ActionHeader />
      <div className="flex-1 overflow-hidden">
        <PanelGroup direction="vertical">
          <Panel id="content" minSize={30}>
            <div className="h-full overflow-y-auto">
              {pdfPreviewData ? (
                <div className="h-full flex flex-col">
                  <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-muted/30 shrink-0">
                    <span className="text-sm font-medium truncate">
                      {pdfPreviewData.topic === PDF_GENERATING_SENTINEL
                        ? "Generating PDF…"
                        : pdfPreviewData.topic}
                    </span>
                    <button
                      type="button"
                      onClick={() => setPdfPreviewData(null)}
                      aria-label="Close PDF preview"
                      className="text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer ml-3 shrink-0"
                    >
                      ✕
                    </button>
                  </div>
                  <div className="flex-1 overflow-hidden">
                    {pdfPreviewData.topic === PDF_GENERATING_SENTINEL ? (
                      <div className="p-6">
                        <PdfGeneratingMessage />
                      </div>
                    ) : (
                      <PdfPreviewMessage
                        topic={pdfPreviewData.topic}
                        dataUri={pdfPreviewData.dataUri}
                      />
                    )}
                  </div>
                </div>
              ) : previewMode === "preview" ? (
                app?.frameworkType === "expo" && app.id ? (
                  <ExpoPreviewPanel appId={app.id} />
                ) : app?.frameworkType === "electron" && app.id ? (
                  <ElectronPreviewPanel appId={app.id} />
                ) : (
                  <PreviewIframe key={key} loading={loading} />
                )
              ) : previewMode === "code" ? (
                <CodeView loading={loading} app={app} />
              ) : previewMode === "git" ? (
                app?.id ? (
                  <div className="mx-auto w-full max-w-[840px] p-4">
                    <Suspense
                      fallback={<PanelLoading label="source control" />}
                    >
                      <LazyGitHubConnector
                        appId={app.id}
                        folderName={app.path}
                        expanded
                      />
                    </Suspense>
                  </div>
                ) : (
                  <EmptyState
                    icon={<GitBranch />}
                    title="No project selected"
                    description="Open a project to manage its branches, commits and remotes."
                  />
                )
              ) : previewMode === "terminal" ? (
                <Suspense fallback={<PanelLoading label="the terminal" />}>
                  <LazyTerminalPanel />
                </Suspense>
              ) : previewMode === "game" ? (
                <Suspense fallback={<PanelLoading label="the game engine" />}>
                  <LazyGamePanel />
                </Suspense>
              ) : previewMode === "design" ? (
                <Suspense fallback={<PanelLoading label="Open Design" />}>
                  <LazyDesignStudio embedded />
                </Suspense>
              ) : previewMode === "configure" ? (
                <ConfigurePanel />
              ) : previewMode === "publish" ? (
                <PublishPanel />
              ) : previewMode === "security" ? (
                <SecurityPanel />
              ) : previewMode === "plan" ? (
                <PlanPanel />
              ) : (
                <Problems />
              )}
            </div>
          </Panel>
          {isConsoleOpen && (
            <>
              <PanelResizeHandle className="h-px shrink-0 cursor-row-resize bg-white/[0.07] transition-colors hover:bg-primary/45 data-[resize-handle-active]:bg-primary" />
              <Panel id="console" minSize={12} defaultSize={30}>
                <div className="flex h-full flex-col">
                  <ConsoleHeader
                    isOpen={true}
                    onToggle={() => setIsConsoleOpen(false)}
                    latestMessage={latestMessage}
                    entryCount={consoleEntries.length}
                  />
                  <Console />
                </div>
              </Panel>
            </>
          )}
        </PanelGroup>
      </div>
      {!isConsoleOpen && (
        <ConsoleHeader
          isOpen={false}
          onToggle={() => setIsConsoleOpen(true)}
          latestMessage={latestMessage}
          entryCount={consoleEntries.length}
        />
      )}
    </div>
  );
}
