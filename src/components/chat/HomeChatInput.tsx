import {
  SendHorizontalIcon,
  StopCircleIcon,
  FolderOpenIcon,
  XIcon,
  Mic,
  MicOff,
  Loader2,
  Lock,
} from "lucide-react";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";

import { useSettings } from "@/hooks/useSettings";
import { homeChatInputValueAtom, homeSelectedAppAtom } from "@/atoms/chatAtoms";
import { useAtom } from "jotai";
import { useState, useEffect, useCallback } from "react";
import { useStreamChat } from "@/hooks/useStreamChat";
import { useAttachments } from "@/hooks/useAttachments";
import { useVoiceToText } from "@/hooks/useVoiceToText";
import { isOrianBuilderProEnabled } from "@/lib/schemas";
import { ipc } from "@/ipc/types";
import { showError } from "@/lib/toast";
import { AttachmentsList } from "./AttachmentsList";
import { DragDropOverlay } from "./DragDropOverlay";
import { FileAttachmentTypeDialog } from "./FileAttachmentTypeDialog";
import { usePostHog } from "posthog-js/react";
import { HomeSubmitOptions } from "@/pages/home";
import { ChatInputControls } from "../ChatInputControls";
import { LexicalChatInput } from "./LexicalChatInput";
import { useChatModeToggle } from "@/hooks/useChatModeToggle";
import { useTypingPlaceholder } from "@/hooks/useTypingPlaceholder";
import { AuxiliaryActionsMenu } from "./AuxiliaryActionsMenu";
import { cn } from "@/lib/utils";
import { useLoadApps } from "@/hooks/useLoadApps";
import { AppSearchDialog } from "../AppSearchDialog";

export function HomeChatInput({
  onSubmit,
}: {
  onSubmit: (options?: HomeSubmitOptions) => void;
}) {
  const posthog = usePostHog();
  const [inputValue, setInputValue] = useAtom(homeChatInputValueAtom);
  const [selectedApp, setSelectedApp] = useAtom(homeSelectedAppAtom);
  const { settings } = useSettings();
  const { isStreaming } = useStreamChat({ hasChatId: false });
  useChatModeToggle();

  const [appSearchOpen, setAppSearchOpen] = useState(false);
  const { apps } = useLoadApps();
  const isProEnabled = settings ? isOrianBuilderProEnabled(settings) : false;

  const handleTranscription = useCallback(
    (text: string) => {
      setInputValue((prev: string) => (prev.trim() ? prev + " " + text : text));
    },
    [setInputValue],
  );

  const { isRecording, isTranscribing, toggleRecording } = useVoiceToText({
    enabled: isProEnabled,
    onTranscription: handleTranscription,
    onError: (message) => showError(message),
  });

  useEffect(() => {
    if (!settings?.enableSelectAppFromHomeChatInput) {
      setSelectedApp(null);
    }
  }, [settings?.enableSelectAppFromHomeChatInput, setSelectedApp]);

  const typingText = useTypingPlaceholder([
    "an ecommerce store...",
    "an information page...",
    "a landing page...",
  ]);
  const placeholder = selectedApp
    ? `Send a message to ${selectedApp.name}...`
    : `Ask OrianBuilder to build ${typingText ?? ""}`;

  const {
    attachments,
    isDraggingOver,
    pendingFiles,
    handleFileSelect,
    removeAttachment,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    clearAttachments,
    handlePaste,
    confirmPendingFiles,
    cancelPendingFiles,
  } = useAttachments();

  const handleSelectApp = (appId: number) => {
    const app = apps.find((a) => a.id === appId);
    if (app) setSelectedApp(app);
    setAppSearchOpen(false);
  };

  const handleCustomSubmit = async () => {
    if (
      (!inputValue.trim() && attachments.length === 0) ||
      isStreaming ||
      pendingFiles
    ) {
      return;
    }

    onSubmit({ attachments, selectedApp: selectedApp ?? undefined });
    clearAttachments();
    setSelectedApp(null);
    posthog.capture("chat:home_submit", {
      chatMode: settings?.selectedChatMode,
      existingApp: !!selectedApp,
    });
  };

  if (!settings) return null;

  return (
    <>
      <div className="p-2" data-testid="home-chat-input-container">
        <div
          className={cn(
            "relative flex flex-col border border-white/15 rounded-2xl bg-white/[0.04] backdrop-blur-xl shadow-[0_8px_32px_-12px_rgba(0,0,0,0.6)] transition-colors duration-200",
            "hover:border-primary/40",
            "focus-within:border-primary/50 focus-within:ring-1 focus-within:ring-primary/25",
            isDraggingOver && "ring-2 ring-blue-500 border-blue-500",
          )}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <AttachmentsList
            attachments={attachments}
            onRemove={removeAttachment}
          />
          <DragDropOverlay isDraggingOver={isDraggingOver} />
          <FileAttachmentTypeDialog
            pendingFiles={pendingFiles}
            onConfirm={confirmPendingFiles}
            onCancel={cancelPendingFiles}
          />

          <div className="flex items-end gap-1">
            <LexicalChatInput
              value={inputValue}
              onChange={setInputValue}
              onSubmit={handleCustomSubmit}
              onPaste={handlePaste}
              placeholder={placeholder}
              disabled={isStreaming}
              excludeCurrentApp={false}
              disableSendButton={false}
              messageHistory={[]}
              inputClassName="text-[18px] min-h-[72px] max-h-[320px]"
            />

            {/* Voice-to-text mic button (Pro feature) */}
            {isProEnabled ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      onClick={toggleRecording}
                      disabled={isTranscribing}
                      aria-label={
                        isRecording
                          ? "Stop recording"
                          : isTranscribing
                            ? "Transcribing..."
                            : "Voice to text"
                      }
                      className={cn(
                        "px-2 py-2 mb-0.5 text-muted-foreground rounded-lg transition-colors duration-150 cursor-pointer disabled:cursor-default disabled:opacity-30",
                        isRecording &&
                          "text-red-500 hover:text-red-600 animate-pulse",
                        !isRecording && !isTranscribing && "hover:text-primary",
                      )}
                    />
                  }
                >
                  {isTranscribing ? (
                    <Loader2 size={22} className="animate-spin" />
                  ) : isRecording ? (
                    <MicOff size={22} />
                  ) : (
                    <Mic size={22} />
                  )}
                </TooltipTrigger>
                <TooltipContent>
                  {isRecording
                    ? "Stop recording"
                    : isTranscribing
                      ? "Transcribing..."
                      : "Voice to text"}
                </TooltipContent>
              </Tooltip>
            ) : (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      onClick={() =>
                        ipc.system.openExternalUrl(
                          "https://orianbuilder.sh/pro",
                        )
                      }
                      aria-label="Voice to text (Pro)"
                      className="px-2 py-2 mb-0.5 text-muted-foreground hover:text-primary rounded-lg transition-colors duration-150 cursor-pointer relative"
                    />
                  }
                >
                  <Mic size={22} />
                  <Lock size={10} className="absolute -top-0.5 -right-0.5" />
                </TooltipTrigger>
                <TooltipContent>Voice to text (requires Pro)</TooltipContent>
              </Tooltip>
            )}

            {isStreaming ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      aria-label="Cancel generation (unavailable here)"
                      className="px-2 py-2 mb-0.5 mr-1 text-muted-foreground rounded-lg opacity-50 cursor-not-allowed transition-colors duration-150"
                    />
                  }
                >
                  <StopCircleIcon size={22} />
                </TooltipTrigger>
                <TooltipContent>
                  Cancel generation (unavailable here)
                </TooltipContent>
              </Tooltip>
            ) : (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      onClick={handleCustomSubmit}
                      disabled={!inputValue.trim() && attachments.length === 0}
                      aria-label="Send message"
                      className="px-2 py-2 mb-0.5 mr-1 text-muted-foreground hover:text-primary rounded-lg transition-colors duration-150 disabled:opacity-30 disabled:hover:text-muted-foreground cursor-pointer disabled:cursor-default"
                    />
                  }
                >
                  <SendHorizontalIcon size={22} />
                </TooltipTrigger>
                <TooltipContent>Send message</TooltipContent>
              </Tooltip>
            )}
          </div>

          <div className="px-2 flex items-center justify-between pb-1 pt-0.5">
            <div className="flex items-center">
              <ChatInputControls
                showContextFilesPicker={false}
                showProSelector={false}
              />
              {settings?.enableSelectAppFromHomeChatInput && (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        onClick={() => setAppSearchOpen(true)}
                        className={cn(
                          "cursor-pointer px-2 py-1 ml-1.5 text-xs font-medium rounded-lg transition-colors flex items-center gap-1",
                          selectedApp
                            ? "bg-primary/10 text-primary hover:bg-primary/15"
                            : "text-foreground/80 hover:text-foreground hover:bg-muted/60",
                        )}
                        data-testid="home-app-selector"
                      />
                    }
                  >
                    <FolderOpenIcon size={14} />
                    <span className="truncate max-w-[150px]">
                      {selectedApp ? selectedApp.name : "No app selected"}
                    </span>
                    {selectedApp && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedApp(null);
                        }}
                        className="hover:bg-primary/20 rounded-sm p-0.5 transition-colors"
                        aria-label="Deselect app"
                        data-testid="home-app-selector-clear"
                      >
                        <XIcon size={12} />
                      </button>
                    )}
                  </TooltipTrigger>
                  <TooltipContent>
                    {selectedApp
                      ? "Change selected app"
                      : "Select an existing app"}
                  </TooltipContent>
                </Tooltip>
              )}
            </div>

            <AuxiliaryActionsMenu
              onFileSelect={handleFileSelect}
              hideContextFilesPicker
            />
          </div>
        </div>
      </div>

      {appSearchOpen && (
        <AppSearchDialog
          open={appSearchOpen}
          onOpenChange={setAppSearchOpen}
          onSelectApp={handleSelectApp}
          disableShortcut
          allApps={apps.map((a) => ({
            id: a.id,
            name: a.name,
            createdAt: a.createdAt,
            matchedChatTitle: null,
            matchedChatMessage: null,
          }))}
        />
      )}
    </>
  );
}
