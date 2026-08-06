import { useState, useRef, useEffect } from "react";
import {
  PanelGroup,
  Panel,
  PanelResizeHandle,
  type ImperativePanelHandle,
} from "react-resizable-panels";
import { ChatPanel } from "../components/ChatPanel";
import { PreviewPanel } from "../components/preview_panel/PreviewPanel";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { isPreviewOpenAtom, isChatPanelHiddenAtom } from "@/atoms/viewAtoms";
import { useChats } from "@/hooks/useChats";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import { selectedChatIdAtom } from "@/atoms/chatAtoms";
import { usePlanImplementation } from "@/hooks/usePlanImplementation";
import { useSurfaceId } from "@/shell/stage/SurfaceContext";
import { focusedTaskIdAtom } from "@/shell/stage/task_state";
import { useQuery } from "@tanstack/react-query";
import { ipc } from "@/ipc/types";
import { queryKeys } from "@/lib/queryKeys";
import { CheckCircle2, CircleAlert, Loader2 } from "lucide-react";
import { TaskWorkspace } from "@/shell/stage/TaskWorkspace";

const DEFAULT_CHAT_PANEL_SIZE = 50;

export default function ChatPage() {
  const surfaceId = useSurfaceId();
  return surfaceId === "build.workspace" ? (
    <OrchestratedWorkspace />
  ) : (
    <LegacyChatPage />
  );
}

function OrchestratedWorkspace() {
  const focusedTaskId = useAtomValue(focusedTaskIdAtom);
  const { data } = useQuery({
    queryKey: queryKeys.marta.tasks(),
    queryFn: () => ipc.marta.listTasks({ includeCompleted: true, limit: 30 }),
    refetchInterval: 1_000,
  });
  const task = data?.tasks.find((candidate) => candidate.id === focusedTaskId);
  const fallbackTask = data?.tasks[0];

  if (task || focusedTaskId === null) {
    return <TaskWorkspace task={task} />;
  }

  {
    // Accesses are guarded by `fallbackTask &&` in the JSX below.
    const task = fallbackTask!;
    return (
      <div className="flex h-full min-w-0 flex-col">
        {fallbackTask && (
          <div className="flex shrink-0 items-center gap-3 border-b border-white/[0.07] bg-white/[0.025] px-3 py-2">
            <span className="grid h-7 w-7 place-items-center rounded-[9px] bg-primary/10 text-primary">
              {fallbackTask.status === "running" ||
              fallbackTask.status === "queued" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : fallbackTask.status === "failed" ? (
                <CircleAlert className="h-3.5 w-3.5 text-[var(--cosmos-red)]" />
              ) : (
                <CheckCircle2 className="h-3.5 w-3.5" />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12px] font-medium text-foreground">
                {fallbackTask.title}
              </span>
              <span className="block truncate text-[10px] text-muted-foreground">
                {task.workerLabel} · {task.model ?? "default model"} ·{" "}
                {task.phase}
              </span>
            </span>
            <span className="rounded-full bg-white/[0.055] px-2 py-1 font-mono text-[9px] uppercase text-foreground/55">
              {fallbackTask.status}
            </span>
          </div>
        )}
        <div className="min-h-0 flex-1">
          <PreviewPanel />
        </div>
      </div>
    );
  }
}

function LegacyChatPage() {
  const { id: chatId } = useSearch({ from: "/chat" });
  const navigate = useNavigate();
  const [isPreviewOpen, setIsPreviewOpen] = useAtom(isPreviewOpenAtom);
  const [isChatPanelHidden, setIsChatPanelHidden] = useAtom(
    isChatPanelHiddenAtom,
  );
  const setSelectedChatId = useSetAtom(selectedChatIdAtom);
  const [isResizing, setIsResizing] = useState(false);
  const selectedAppId = useAtomValue(selectedAppIdAtom);
  const setSelectedAppId = useSetAtom(selectedAppIdAtom);
  const { chats, loading } = useChats(selectedAppId);
  const previousSizeRef = useRef<number>(DEFAULT_CHAT_PANEL_SIZE);
  const isInitialMountRef = useRef(true);

  // Sync selectedChatIdAtom with the chatId from the URL
  useEffect(() => {
    setSelectedChatId(chatId ?? null);
  }, [chatId, setSelectedChatId]);

  // Handle plan implementation when a plan is accepted
  usePlanImplementation();

  useEffect(() => {
    if (!chatId && chats.length && !loading) {
      // Not a real navigation, just a redirect, when the user navigates to /chat
      // without a chatId, we redirect to the first chat
      setSelectedAppId(chats[0].appId);
      navigate({ to: "/chat", search: { id: chats[0].id }, replace: true });
    }
  }, [chatId, chats, loading, navigate]);

  useEffect(() => {
    // Defer to next frame so any autoSaveId size restoration completes first;
    // otherwise the restored size overrides our collapse() on initial mount.
    const rafId = requestAnimationFrame(() => {
      if (isPreviewOpen) {
        ref.current?.expand();
      } else {
        ref.current?.collapse();
      }
    });
    return () => cancelAnimationFrame(rafId);
  }, [isPreviewOpen]);
  const ref = useRef<ImperativePanelHandle>(null);
  const chatPanelRef = useRef<ImperativePanelHandle>(null);

  // Keep chat panel size in sync with hidden state (from toolbar button / other views)
  useEffect(() => {
    if (!chatPanelRef.current) return;
    // Skip the initial mount to preserve persisted panel size from autoSaveId
    if (isInitialMountRef.current) {
      isInitialMountRef.current = false;
      return;
    }
    if (isChatPanelHidden) {
      // Save current size before collapsing
      const currentSize = chatPanelRef.current.getSize();
      if (currentSize > 5) {
        previousSizeRef.current = currentSize;
      }
      // Visually collapsed but keep a sliver so the handle is usable
      chatPanelRef.current.resize(1);
    } else {
      // Restore to previous size when re-opened via button
      chatPanelRef.current.resize(previousSizeRef.current);
    }
  }, [isChatPanelHidden]);

  return (
    <PanelGroup autoSaveId="persistence" direction="horizontal">
      <Panel
        id="chat-panel"
        ref={chatPanelRef}
        collapsible
        minSize={1}
        className={cn(!isResizing && "transition-all duration-100 ease-in-out")}
      >
        <div className="h-full w-full">
          {!isChatPanelHidden && (
            <ChatPanel
              chatId={chatId}
              isPreviewOpen={isPreviewOpen}
              onTogglePreview={() => {
                setIsPreviewOpen(!isPreviewOpen);
                if (isPreviewOpen) {
                  ref.current?.collapse();
                } else {
                  ref.current?.expand();
                }
              }}
            />
          )}
        </div>
      </Panel>
      <PanelResizeHandle
        onDragging={(isDragging) => {
          setIsResizing(isDragging);
          // When dragging ends, sync the hidden state based on final width
          if (!isDragging) {
            // Small delay to let the panel settle
            requestAnimationFrame(() => {
              const panel = document.getElementById("chat-panel");
              if (panel) {
                const panelWidth = panel.getBoundingClientRect().width;
                const containerWidth =
                  panel.parentElement?.getBoundingClientRect().width || 1;
                const percentage = (panelWidth / containerWidth) * 100;
                // Consider hidden if panel is less than 5% width
                setIsChatPanelHidden(percentage < 5);
              }
            });
          }
        }}
        // Wider when collapsed so the handle stays grabbable once the
        // conversation is squeezed to a sliver, and it lights up in the accent
        // colour while dragging so the interaction is visible rather than
        // guessed at.
        className={cn(
          "relative shrink-0 cursor-col-resize self-stretch bg-white/[0.07] transition-colors",
          "hover:bg-primary/45 data-[resize-handle-active]:bg-primary",
          isChatPanelHidden ? "w-1.5" : "w-px",
        )}
      />

      <Panel
        collapsible
        ref={ref}
        id="preview-panel"
        minSize={20}
        className={cn(!isResizing && "transition-all duration-100 ease-in-out")}
      >
        <PreviewPanel />
      </Panel>
    </PanelGroup>
  );
}
