import {
  SendHorizontalIcon,
  StopCircleIcon,
  FolderOpenIcon,
  XIcon,
  Mic,
  MicOff,
  Loader2,
  CloudUpload,
} from "lucide-react";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { Switch } from "@/components/ui/switch";

import { useSettings } from "@/hooks/useSettings";
import {
  homeChatInputValueAtom,
  homeSelectedAppAtom,
  currentHomePdfTopicAtom,
  homeChatHistoryAtom,
  type HomeChatHistoryEntry,
} from "@/atoms/chatAtoms";
import { useAtom, useSetAtom } from "jotai";
import { useState, useEffect, useCallback } from "react";
import { useAttachments } from "@/hooks/useAttachments";
import { useVoiceToText } from "@/hooks/useVoiceToText";
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
import {
  extractPdfTopic,
  generatePdfContent,
  buildPdf,
  pdfPreviewDataAtom,
} from "@/lib/pdfGenerator";
import { PdfGeneratingMessage } from "./PdfPreviewMessage";
import { isPreviewOpenAtom } from "@/atoms/viewAtoms";
import { useRouter } from "@tanstack/react-router";

export function HomeChatInput({
  onSubmit,
  isStreaming = false,
  onCancel,
}: {
  onSubmit: (options?: HomeSubmitOptions) => void;
  isStreaming?: boolean;
  onCancel?: () => void;
}) {
  const posthog = usePostHog();
  const [inputValue, setInputValue] = useAtom(homeChatInputValueAtom);
  const [selectedApp, setSelectedApp] = useAtom(homeSelectedAppAtom);
  const { settings, updateSettings } = useSettings();
  const isAutoPublishEnabled = !!settings?.autoPublishAfterChecks;
  useChatModeToggle();

  const [appSearchOpen, setAppSearchOpen] = useState(false);
  const { apps } = useLoadApps();
  const [isHomePdfGenerating, setIsHomePdfGenerating] = useState(false);
  const setPdfPreviewData = useSetAtom(pdfPreviewDataAtom);
  const setCurrentHomePdfTopic = useSetAtom(currentHomePdfTopicAtom);
  const setHomeChatHistory = useSetAtom(homeChatHistoryAtom);
  const setIsPreviewOpen = useSetAtom(isPreviewOpenAtom);
  const { navigate } = useRouter();
  const handleTranscription = useCallback(
    (text: string) => {
      setInputValue(text);
    },
    [setInputValue],
  );

  const { isRecording, isTranscribing, toggleRecording } = useVoiceToText({
    enabled: true,
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

    // PDF generation: "create a pdf on <topic>" or "create a pdf on a topic like <topic>"
    const pdfTopic = extractPdfTopic(inputValue.trim());
    if (pdfTopic && !isHomePdfGenerating) {
      setInputValue("");
      setIsHomePdfGenerating(true);
      setCurrentHomePdfTopic(pdfTopic);

      const openRouterKey =
        settings?.providerSettings?.openrouter?.apiKey?.value;

      generatePdfContent(pdfTopic, openRouterKey).then((content) => {
        const dataUri = buildPdf(pdfTopic, content);
        setPdfPreviewData({ topic: pdfTopic, dataUri });
        setIsPreviewOpen(true);
        setIsHomePdfGenerating(false);
        setCurrentHomePdfTopic(null);
        const entry: HomeChatHistoryEntry = {
          id: crypto.randomUUID(),
          title: pdfTopic,
          messages: [],
          createdAt: new Date().toISOString(),
          pdfData: { topic: pdfTopic, dataUri },
        };
        setHomeChatHistory((prev) => [entry, ...prev]);
        navigate({ to: "/chat" });
      });

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
      {isHomePdfGenerating && (
        <div className="mb-3 px-3 py-2 rounded-xl border border-border bg-muted/20">
          <PdfGeneratingMessage />
        </div>
      )}
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

            {/* Voice-to-text mic button */}
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

            {isStreaming ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      onClick={onCancel}
                      aria-label="Cancel generation"
                      className="px-2 py-2 mb-0.5 mr-1 text-muted-foreground hover:text-destructive rounded-lg transition-colors duration-150 cursor-pointer"
                    />
                  }
                >
                  <StopCircleIcon size={22} />
                </TooltipTrigger>
                <TooltipContent>Cancel generation</TooltipContent>
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
            <div className="flex items-center gap-2">
              <ChatInputControls
                showContextFilesPicker={false}
                showProSelector={false}
              />
              {/* Publish toggle — shared with the chat-input bar so users can
                  enable auto-publish before starting a new chat. The actual
                  publish-after-checks logic lives in ChatInput.handleSubmit;
                  this control just persists the global setting. */}
              <Tooltip>
                <TooltipTrigger
                  render={
                    <label
                      htmlFor="home-auto-publish-after-checks"
                      className={cn(
                        "flex items-center gap-1.5 cursor-pointer h-7 rounded-lg px-2 text-[11px] font-medium transition-colors",
                        "border border-white/10 bg-white/[0.04] text-white/65 hover:border-primary/40 hover:bg-primary/10 hover:text-white",
                        isAutoPublishEnabled &&
                          "border-primary/40 bg-primary/15 text-white shadow-[0_0_18px_-10px_rgba(168,140,255,.8)]",
                      )}
                    />
                  }
                >
                  <CloudUpload size={14} />
                  <span>Publish</span>
                  <Switch
                    id="home-auto-publish-after-checks"
                    checked={isAutoPublishEnabled}
                    onCheckedChange={(checked) => {
                      void updateSettings({
                        autoPublishAfterChecks: checked,
                      });
                    }}
                    onClick={(event) => event.stopPropagation()}
                    aria-label="Auto-publish after checks"
                  />
                </TooltipTrigger>
                <TooltipContent>
                  Push to GitHub and deploy to Vercel or Netlify after a
                  successful checked turn.
                </TooltipContent>
              </Tooltip>
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
