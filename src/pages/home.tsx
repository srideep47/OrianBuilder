import { useTranslation } from "react-i18next";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useAtom, useSetAtom } from "jotai";
import { homeChatInputValueAtom } from "../atoms/chatAtoms";
import { ipc } from "@/ipc/types";
import { useLoadApps } from "@/hooks/useLoadApps";
import { useSettings } from "@/hooks/useSettings";
import { isPreviewOpenAtom } from "@/atoms/viewAtoms";
import { useState, useEffect, useRef } from "react";
import { useStreamChat } from "@/hooks/useStreamChat";
import { HomeChatInput } from "@/components/chat/HomeChatInput";
import { usePostHog } from "posthog-js/react";
import { PrivacyBanner } from "@/components/TelemetryBanner";
import { useAppVersion } from "@/hooks/useAppVersion";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useTheme } from "@/contexts/ThemeContext";
import { Button } from "@/components/ui/button";
import { ExternalLink } from "lucide-react";
import { showError } from "@/lib/toast";
import { invalidateAppQuery } from "@/hooks/useLoadApp";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";
import { ForceCloseDialog } from "@/components/ForceCloseDialog";
import { useSelectChat } from "@/hooks/useSelectChat";
import type { FileAttachment } from "@/ipc/types";
import type { ListedApp } from "@/ipc/types/app";
import { NEON_TEMPLATE_IDS } from "@/shared/templates";
import { neonTemplateHook } from "@/client_logic/template_hook";
import { getEffectiveDefaultChatMode } from "@/lib/schemas";
import { useFreeAgentQuota } from "@/hooks/useFreeAgentQuota";
import { useInitialChatMode } from "@/hooks/useInitialChatMode";
import {
  streamChatResponse,
  PROXY_MODEL_URL,
  EMBEDDED_MODEL_URL,
} from "@/lib/chatStream";
import { useQuery } from "@tanstack/react-query";
import type { ComputeTarget } from "@/ipc/types/compute";

interface InlineChatMessage {
  role: "user" | "assistant";
  content: string;
}

let hasCheckedReleaseNotes = false;

export interface HomeSubmitOptions {
  attachments?: FileAttachment[];
  selectedApp?: ListedApp;
}

export default function HomePage() {
  const { t } = useTranslation("home");
  const [inputValue, setInputValue] = useAtom(homeChatInputValueAtom);
  const navigate = useNavigate();
  const search = useSearch({ from: "/" });
  const { refreshApps } = useLoadApps();
  const { settings, updateSettings, envVars } = useSettings();
  const { isQuotaExceeded, isLoading: isQuotaLoading } = useFreeAgentQuota();
  const initialChatMode = useInitialChatMode();

  const setIsPreviewOpen = useSetAtom(isPreviewOpenAtom);
  const { selectChat } = useSelectChat();
  const [isLoading, setIsLoading] = useState(false);
  const [loadingMode, setLoadingMode] = useState<"new" | "existing">("new");
  const [forceCloseDialogOpen, setForceCloseDialogOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState<InlineChatMessage[]>([]);
  const [isReplying, setIsReplying] = useState(false);
  const [performanceData, setPerformanceData] = useState<any>(undefined);
  const assistantBufferRef = useRef("");
  const flushTimerRef = useRef<number | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const { streamMessage } = useStreamChat({ hasChatId: false });
  const posthog = usePostHog();
  const appVersion = useAppVersion();
  const [releaseNotesOpen, setReleaseNotesOpen] = useState(false);

  // Use the proxy port when a peer is the active compute target
  const { data: computeTarget } = useQuery<ComputeTarget>({
    queryKey: queryKeys.compute.target,
    queryFn: () => ipc.compute.getTarget(),
  });
  const localModelUrl =
    computeTarget?.mode === "peer" ? PROXY_MODEL_URL : EMBEDDED_MODEL_URL;
  const [releaseUrl, setReleaseUrl] = useState("");
  const { theme } = useTheme();
  const queryClient = useQueryClient();

  useEffect(() => {
    const unsubscribe = ipc.events.system.onForceCloseDetected((data) => {
      setPerformanceData(data.performanceData);
      setForceCloseDialogOpen(true);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    const updateLastVersionLaunched = async () => {
      if (
        hasCheckedReleaseNotes ||
        !appVersion ||
        !settings ||
        settings.lastShownReleaseNotesVersion === appVersion
      ) {
        return;
      }
      hasCheckedReleaseNotes = true;

      const shouldShowReleaseNotes = !!settings.lastShownReleaseNotesVersion;
      await updateSettings({ lastShownReleaseNotesVersion: appVersion });

      if (!shouldShowReleaseNotes) return;

      try {
        const result = await ipc.system.doesReleaseNoteExist({
          version: appVersion,
        });
        if (result.exists && result.url) {
          setReleaseUrl(result.url + "?hideHeader=true&theme=" + theme);
          setReleaseNotesOpen(true);
        }
      } catch (err) {
        console.warn(
          "Unable to check if release note exists for: " + appVersion,
          err,
        );
      }
    };
    updateLastVersionLaunched();
  }, [appVersion, settings, updateSettings, theme]);

  const appId = search.appId ? Number(search.appId) : null;

  useEffect(() => {
    if (appId) {
      navigate({ to: "/app-details", search: { appId } });
    }
  }, [appId, navigate]);

  const hasAppliedDefaultChatMode = useRef(false);
  useEffect(() => {
    if (settings && !hasAppliedDefaultChatMode.current && !isQuotaLoading) {
      hasAppliedDefaultChatMode.current = true;
      const effectiveDefaultMode = getEffectiveDefaultChatMode(
        settings,
        envVars,
        !isQuotaExceeded,
      );
      if (settings.selectedChatMode !== effectiveDefaultMode) {
        updateSettings({ selectedChatMode: effectiveDefaultMode });
      }
    }
  }, [settings, updateSettings, isQuotaExceeded, isQuotaLoading, envVars]);

  // Auto-scroll to latest message
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages]);

  // Clean up streaming interval on unmount
  useEffect(() => {
    return () => {
      if (flushTimerRef.current) window.clearInterval(flushTimerRef.current);
    };
  }, []);

  const handleSubmit = async (options?: HomeSubmitOptions) => {
    const attachments = options?.attachments || [];
    const selectedApp = options?.selectedApp;

    if (!inputValue.trim() && attachments.length === 0) return;

    // Only invoke the app builder when the message contains a build intent.
    // Typo variant "bulid" is also accepted. Messages without "build" get a
    // plain conversational reply — no createApp, no git init, no builder panel.
    const isBuildRequest = /build|bulid/i.test(inputValue);

    if (!selectedApp && !isBuildRequest) {
      if (isReplying) return;

      const userText = inputValue.trim();

      // Build the full conversation for the local model (history + new turn).
      // chatMessages here is the current state — the new user message hasn't
      // been appended yet, so this is safe to use synchronously.
      const apiMessages: { role: string; content: string }[] = [
        {
          role: "system",
          content:
            "You are OrianBuilder Assistant, a helpful AI. Answer questions clearly and concisely.",
        },
        ...chatMessages.map((m) => ({ role: m.role, content: m.content })),
        { role: "user", content: userText },
      ];

      setChatMessages((prev) => [
        ...prev,
        { role: "user", content: userText },
        { role: "assistant", content: "" },
      ]);
      setInputValue("");
      setIsReplying(true);
      assistantBufferRef.current = "";

      if (flushTimerRef.current) {
        window.clearInterval(flushTimerRef.current);
        flushTimerRef.current = null;
      }

      const stopFlush = () => {
        if (flushTimerRef.current) {
          window.clearInterval(flushTimerRef.current);
          flushTimerRef.current = null;
        }
      };

      const commitAssistant = (content: string) => {
        setChatMessages((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last?.role === "assistant") {
            next[next.length - 1] = { ...last, content };
          }
          return next;
        });
        setIsReplying(false);
        stopFlush();
      };

      const openRouterKey =
        settings?.providerSettings?.openrouter?.apiKey?.value;

      streamChatResponse(
        apiMessages,
        openRouterKey,
        {
          onChunk: (delta) => {
            assistantBufferRef.current += delta;
          },
          onEnd: () => commitAssistant(assistantBufferRef.current),
          onError: (msg) => commitAssistant(`⚠️ ${msg}`),
        },
        undefined,
        localModelUrl,
      );

      // Flush buffered chunks to state on a smooth interval
      flushTimerRef.current = window.setInterval(() => {
        setChatMessages((prev) => {
          const last = prev[prev.length - 1];
          if (
            last?.role === "assistant" &&
            last.content !== assistantBufferRef.current
          ) {
            const next = [...prev];
            next[next.length - 1] = {
              ...last,
              content: assistantBufferRef.current,
            };
            return next;
          }
          return prev;
        });
      }, 80);

      return;
    }

    // Clear any previous inline chat before starting a real build.
    setChatMessages([]);

    try {
      setLoadingMode(selectedApp ? "existing" : "new");
      setIsLoading(true);

      let chatId: number;
      let appId: number;
      if (selectedApp) {
        chatId = await ipc.chat.createChat({
          appId: selectedApp.id,
          initialChatMode,
        });
        appId = selectedApp.id;
      } else {
        const templateSelection = await ipc.template.selectTemplateForPrompt({
          prompt: inputValue,
        });
        const result = await ipc.app.createApp({
          name: templateSelection.appName,
          initialChatMode,
          templateId: templateSelection.templateId,
        });
        chatId = result.chatId;
        appId = result.app.id;

        if (NEON_TEMPLATE_IDS.has(templateSelection.templateId)) {
          await neonTemplateHook({
            appId: result.app.id,
            appName: result.app.name,
          });
        }

        if (settings?.selectedThemeId) {
          await ipc.template.setAppTheme({
            appId: result.app.id,
            themeId: settings.selectedThemeId || null,
          });
        }
      }

      streamMessage({
        prompt: inputValue,
        chatId,
        appId,
        attachments,
        requestedChatMode: initialChatMode,
      });
      await new Promise((resolve) =>
        setTimeout(resolve, settings?.isTestMode ? 0 : 2000),
      );

      setInputValue("");
      setIsPreviewOpen(false);
      await refreshApps();
      await invalidateAppQuery(queryClient, { appId });
      await queryClient.invalidateQueries({ queryKey: queryKeys.chats.all });
      posthog.capture("home:chat-submit", { existingApp: !!selectedApp });
      selectChat({ chatId, appId });
    } catch (error) {
      console.error("Failed to create chat:", error);
      showError(
        t(selectedApp ? "failedCreateChat" : "failedCreateApp", {
          error: (error as any).toString(),
        }),
      );
      setIsLoading(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-full w-full">
        <div className="flex flex-col items-center">
          <div className="relative w-20 h-20 mb-6">
            <div className="absolute inset-0 border-8 border-gray-200 dark:border-gray-700 rounded-full" />
            <div className="absolute inset-0 border-8 border-t-primary rounded-full animate-spin" />
          </div>
          <h2 className="text-xl font-bold mb-2 text-gray-800 dark:text-gray-200">
            {loadingMode === "existing" ? t("startingChat") : t("buildingApp")}
          </h2>
          <p className="text-gray-600 dark:text-gray-400 text-center max-w-sm">
            {loadingMode === "existing" ? (
              t("creatingNewChat")
            ) : (
              <>
                {t("settingUp")}
                <br />
                {t("mightTakeMoment")}
              </>
            )}
          </p>
        </div>
      </div>
    );
  }

  const releaseNotesDialog = (
    <Dialog open={releaseNotesOpen} onOpenChange={setReleaseNotesOpen}>
      <DialogContent className="max-w-4xl bg-(--docs-bg) pr-0 pt-4 pl-4 gap-1">
        <DialogHeader>
          <DialogTitle>{t("whatsNew", { version: appVersion })}</DialogTitle>
          <Button
            variant="ghost"
            size="sm"
            className="absolute right-10 top-2 focus-visible:ring-0 focus-visible:ring-offset-0"
            onClick={() =>
              window.open(
                releaseUrl.replace("?hideHeader=true&theme=" + theme, ""),
                "_blank",
              )
            }
          >
            <ExternalLink className="w-4 h-4" />
          </Button>
        </DialogHeader>
        <div className="overflow-auto h-[70vh] flex flex-col">
          {releaseUrl && (
            <div className="flex-1">
              <iframe
                src={releaseUrl}
                className="w-full h-full border-0 rounded-lg"
                title={t("releaseNotesTitle", { version: appVersion })}
              />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );

  const forceCloseDialog = (
    <ForceCloseDialog
      isOpen={forceCloseDialogOpen}
      onClose={() => setForceCloseDialogOpen(false)}
      performanceData={performanceData}
    />
  );

  // Landing state — no messages yet: keep the original centered layout
  if (chatMessages.length === 0) {
    return (
      <div className="flex flex-col h-full w-full items-center justify-center">
        {forceCloseDialog}
        <div className="w-full max-w-4xl px-3 sm:px-6 lg:px-8">
          <HomeChatInput onSubmit={handleSubmit} />
        </div>
        <PrivacyBanner />
        {releaseNotesDialog}
      </div>
    );
  }

  // Chat state — messages exist: standard chat-app layout
  return (
    <div className="flex flex-col h-full w-full overflow-hidden">
      {forceCloseDialog}
      {releaseNotesDialog}

      {/* Scrollable message history */}
      <div className="flex-1 overflow-y-auto">
        <div className="w-full max-w-4xl mx-auto px-3 sm:px-6 lg:px-8 py-6 flex flex-col gap-4">
          {chatMessages.map((msg, i) =>
            msg.role === "user" ? (
              <div key={i} className="flex justify-end">
                <div className="bg-primary/15 border border-primary/25 text-white rounded-2xl px-4 py-2.5 max-w-[72%] text-sm whitespace-pre-wrap">
                  {msg.content}
                </div>
              </div>
            ) : (
              <div key={i} className="flex gap-3 items-start">
                <div className="w-7 h-7 rounded-full bg-primary/20 border border-primary/30 flex items-center justify-center flex-shrink-0 mt-0.5 text-xs text-primary font-bold select-none">
                  O
                </div>
                <div className="bg-white/[0.04] border border-white/10 text-white/85 rounded-2xl px-4 py-3 max-w-[72%] text-sm leading-relaxed whitespace-pre-wrap min-h-[2.5rem]">
                  {msg.content ||
                    (isReplying && i === chatMessages.length - 1 ? (
                      <span className="flex gap-1 items-center h-5">
                        <span className="w-1.5 h-1.5 rounded-full bg-white/50 animate-bounce [animation-delay:0ms]" />
                        <span className="w-1.5 h-1.5 rounded-full bg-white/50 animate-bounce [animation-delay:150ms]" />
                        <span className="w-1.5 h-1.5 rounded-full bg-white/50 animate-bounce [animation-delay:300ms]" />
                      </span>
                    ) : null)}
                </div>
              </div>
            ),
          )}
          {/* Scroll anchor */}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input pinned to bottom */}
      <div className="shrink-0 border-t border-white/[0.08] bg-background/80 backdrop-blur-sm">
        <div className="w-full max-w-4xl mx-auto px-3 sm:px-6 lg:px-8 py-3">
          <HomeChatInput onSubmit={handleSubmit} />
        </div>
      </div>
    </div>
  );
}
