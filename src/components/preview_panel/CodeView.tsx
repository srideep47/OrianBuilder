import { useEffect, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { FileCode2, Maximize2, Minimize2, RefreshCw } from "lucide-react";
import { useAtomValue } from "jotai";
import { useTranslation } from "react-i18next";
import { useLoadApp } from "@/hooks/useLoadApp";
import { selectedFileAtom } from "@/atoms/viewAtoms";
import { cn } from "@/lib/utils";
import { EmptyState, LIconButton, LoadingState } from "@/components/liquid";
import { FileEditor } from "./FileEditor";
import { FileTree } from "./FileTree";

interface App {
  id?: number;
  files?: string[];
}

export interface CodeViewProps {
  loading: boolean;
  app: App | null;
}

/**
 * The Files panel: a resizable tree beside the editor.
 *
 * The split used to be hardcoded `w-1/3` / `w-2/3`, which was the wrong ratio
 * at both extremes — deeply nested paths were clipped in a narrow dock, and on a
 * wide monitor a third of the width went to a tree that needed a fifth. Every
 * other split in the app is already draggable via `react-resizable-panels`, so
 * this one now is too, and it persists its position under its own `autoSaveId`.
 */
export const CodeView = ({ loading, app }: CodeViewProps) => {
  const { t } = useTranslation("home");
  const selectedFile = useAtomValue(selectedFileAtom);
  const { refreshApp } = useLoadApp(app?.id ?? null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    if (!isFullscreen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsFullscreen(false);
    };
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isFullscreen]);

  if (loading) {
    return <LoadingState label={t("preview.loadingFiles")} />;
  }

  if (!app) {
    return (
      <EmptyState
        icon={<FileCode2 />}
        title={t("preview.noAppSelected")}
        description="Pick a project from the Sessions panel or the Projects view to browse its files."
      />
    );
  }

  if (!app.files || app.files.length === 0) {
    return (
      <EmptyState
        icon={<FileCode2 />}
        title={t("preview.noFilesFound")}
        description="This project has no files on disk yet. Ask Orion to scaffold it, or import an existing folder."
      />
    );
  }

  return (
    <div
      className={cn(
        "flex flex-col bg-transparent",
        isFullscreen ? "fixed inset-0 z-50 h-screen w-screen" : "h-full",
      )}
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-white/[0.07] px-2.5">
        <LIconButton
          label={t("preview.refreshFiles")}
          size="compact"
          disabled={loading || !app.id}
          onClick={() => refreshApp()}
        >
          <RefreshCw />
        </LIconButton>
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
          {app.files.length} {t("preview.files")}
        </span>
        {/* Breadcrumb of the open file. The editor pane alone never said which
            file you were in once the tree scrolled away from it. */}
        {selectedFile && (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground/70">
            {selectedFile.path}
          </span>
        )}
        <div className="ml-auto shrink-0">
          <LIconButton
            label={
              isFullscreen
                ? t("preview.exitFullScreen")
                : t("preview.enterFullScreen")
            }
            size="compact"
            onClick={() => setIsFullscreen((value) => !value)}
          >
            {isFullscreen ? <Minimize2 /> : <Maximize2 />}
          </LIconButton>
        </div>
      </div>

      <div className="min-h-0 flex-1">
        <PanelGroup autoSaveId="orion.files.split" direction="horizontal">
          <Panel id="file-tree" defaultSize={30} minSize={14} maxSize={55}>
            <div className="flex h-full min-h-0 flex-col overflow-hidden border-r border-white/[0.07]">
              <FileTree appId={app.id ?? null} files={app.files} />
            </div>
          </Panel>
          <PanelResizeHandle className="w-px shrink-0 self-stretch bg-white/[0.07] transition-colors hover:bg-primary/45 data-[resize-handle-active]:bg-primary" />
          <Panel id="file-editor" minSize={30}>
            {selectedFile ? (
              <FileEditor
                key={`${app.id ?? "unknown"}:${selectedFile.path}`}
                appId={app.id ?? null}
                filePath={selectedFile.path}
                initialLine={selectedFile.line ?? null}
              />
            ) : (
              <EmptyState
                compact
                icon={<FileCode2 />}
                title={t("preview.selectFileToView")}
                description="Choose a file in the tree to open it here."
              />
            )}
          </Panel>
        </PanelGroup>
      </div>
    </div>
  );
};
