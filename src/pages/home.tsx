import { useTranslation } from "react-i18next";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useAtom, useSetAtom } from "jotai";
import {
  homeChatInputValueAtom,
  homeChatMessagesAtom,
} from "../atoms/chatAtoms";
import { ipc } from "@/ipc/types";
import { useLoadApps } from "@/hooks/useLoadApps";
import { useSettings } from "@/hooks/useSettings";
import { isPreviewOpenAtom } from "@/atoms/viewAtoms";
import { useState, useEffect, useRef } from "react";
import { useStreamChat } from "@/hooks/useStreamChat";
import { HomeChatInput } from "@/components/chat/HomeChatInput";
import { OrionCommandBar } from "@/components/orion/OrionCommandBar";
import { OrionSessionsPanel } from "@/components/orion/OrionPanels";
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
import {
  ArrowRight,
  ExternalLink,
  FolderKanban,
  Image as ImageIcon,
  Layers3,
  Network,
  Orbit,
  Sparkles,
} from "lucide-react";
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
import { OrianBuilderMarkdownParser } from "@/components/chat/OrianBuilderMarkdownParser";

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
  const [chatMessages, setChatMessages] = useAtom(homeChatMessagesAtom);
  const [isReplying, setIsReplying] = useState(false);
  const [performanceData, setPerformanceData] = useState<any>(undefined);
  const assistantBufferRef = useRef("");
  const replyAbortRef = useRef<AbortController | null>(null);
  const replyCancelledRef = useRef(false);
  const flushTimerRef = useRef<number | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  // Tracks the ID of the persistent "General Chat" app used for non-build conversations.
  const generalChatAppIdRef = useRef<number | null>(null);
  // Sync once when settings loads (settings is fetched asynchronously)
  useEffect(() => {
    if (
      generalChatAppIdRef.current === null &&
      typeof (settings as any)?.generalChatAppId === "number"
    ) {
      generalChatAppIdRef.current = (settings as any)
        .generalChatAppId as number;
    }
  }, [settings]);
  const { streamMessage } = useStreamChat({ hasChatId: false });
  const posthog = usePostHog();
  const appVersion = useAppVersion();
  const [releaseNotesOpen, setReleaseNotesOpen] = useState(false);
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
      replyAbortRef.current?.abort();
    };
  }, []);

  const stopReplyFlush = () => {
    if (flushTimerRef.current) {
      window.clearInterval(flushTimerRef.current);
      flushTimerRef.current = null;
    }
  };

  const updateLastAssistantContent = (content: string) => {
    setChatMessages((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (last?.role === "assistant") {
        next[next.length - 1] = { ...last, content };
      }
      return next;
    });
  };

  const handleCancelReply = () => {
    if (!isReplying) return;
    replyCancelledRef.current = true;
    replyAbortRef.current?.abort();
    replyAbortRef.current = null;
    stopReplyFlush();

    const current = assistantBufferRef.current;
    const stoppedContent = current.trim()
      ? `${current}\n\n_Generation stopped._`
      : "_Generation stopped._";
    assistantBufferRef.current = stoppedContent;
    updateLastAssistantContent(stoppedContent);
    setIsReplying(false);
  };

  const handleSubmit = async (options?: HomeSubmitOptions) => {
    const attachments = options?.attachments || [];
    const selectedApp = options?.selectedApp;

    if (!inputValue.trim() && attachments.length === 0) return;

    // Only invoke the app builder when the message contains a build intent.
    // Typo variant "bulid" is also accepted. Messages without "build" get a
    // plain conversational reply; no createApp, no git init, no builder panel.
    const isBuildRequest = /build|bulid/i.test(inputValue);

    if (!selectedApp && !isBuildRequest) {
      // Route conversational messages through a persistent "General Chat" app so
      // they are saved to the DB and appear in the chat tab view, just like build
      // chats. We create the app once and reuse it for all subsequent conversations.
      try {
        setLoadingMode("existing");
        setIsLoading(true);

        let gcAppId = generalChatAppIdRef.current;

        if (!gcAppId) {
          // Create a blank app to hold general conversations. No template, no git
          // scaffold; it's just a container for the chat records.
          const result = await ipc.app.createApp({
            name: "General Chat",
            initialChatMode: "conversational",
          });
          gcAppId = result.app.id;
          generalChatAppIdRef.current = gcAppId;
          // Persist so we can reuse it across sessions (settings uses .passthrough())
          void updateSettings({ generalChatAppId: gcAppId } as any);
        }

        const chatId = await ipc.chat.createChat({
          appId: gcAppId,
          initialChatMode: "conversational",
        });

        streamMessage({
          prompt: inputValue,
          chatId,
          appId: gcAppId,
          attachments,
          requestedChatMode: "conversational",
        });

        await new Promise((resolve) =>
          setTimeout(resolve, settings?.isTestMode ? 0 : 500),
        );

        setInputValue("");
        setIsPreviewOpen(false);
        posthog.capture("home:chat-submit", {
          existingApp: false,
          conversational: true,
        });
        selectChat({ chatId, appId: gcAppId });

        void refreshApps();
        void invalidateAppQuery(queryClient, { appId: gcAppId });
        void queryClient.invalidateQueries({ queryKey: queryKeys.chats.all });
      } catch (error) {
        console.error("Failed to create conversational chat:", error);
        showError((error as any)?.toString() ?? "Failed to start chat");
        setIsLoading(false);
      }
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

      // Navigate immediately so the user isn't stuck on the loading screen
      // while background data refreshes complete. Refreshes run fire-and-forget.
      posthog.capture("home:chat-submit", { existingApp: !!selectedApp });
      selectChat({ chatId, appId });

      void refreshApps();
      void invalidateAppQuery(queryClient, { appId });
      void queryClient.invalidateQueries({ queryKey: queryKeys.chats.all });
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
                className="w-full h-full border-0 rounded-2xl"
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

  // Landing state: Orion is the single primary surface. Detailed engine/model
  // controls stay available in context without competing with the command box.
  if (chatMessages.length === 0) {
    return (
      <div className="h-full w-full overflow-y-auto">
        {forceCloseDialog}
        <div className="mx-auto flex min-h-full w-full max-w-[1440px] flex-col px-4 py-5 sm:px-6 lg:px-8">
          <header className="flex flex-wrap items-center gap-3 border-b border-border/70 pb-4">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl border border-primary/25 bg-primary/12 text-primary shadow-[0_0_32px_rgba(168,140,255,0.12)]">
              <Orbit className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <h1 className="text-lg font-semibold tracking-tight text-foreground">
                Orion Workspace
              </h1>
              <p className="text-xs text-muted-foreground">
                One conversation for planning, creation, verification, and
                delivery.
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              <Link
                to="/mediaai"
                className="inline-flex h-8 items-center gap-1.5 rounded-xl px-2.5 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
              >
                <ImageIcon className="h-3.5 w-3.5" /> Media
              </Link>
              <Link
                to="/apps"
                className="inline-flex h-8 items-center gap-1.5 rounded-xl px-2.5 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
              >
                <FolderKanban className="h-3.5 w-3.5" /> Projects
              </Link>
              <span className="ml-1 inline-flex items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-1 text-[10px] font-medium text-emerald-300">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />{" "}
                local first
              </span>
            </div>
          </header>

          <div className="grid flex-1 min-w-0 gap-5 pt-5 xl:grid-cols-[minmax(0,1fr)_310px]">
            <main className="flex min-w-0 flex-col justify-center py-6 xl:py-12">
              <div className="mb-6 max-w-3xl">
                <div className="mb-3 inline-flex items-center gap-1.5 rounded-full border border-primary/20 bg-primary/[0.08] px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-primary">
                  <Sparkles className="h-3 w-3" /> Unified local AI workspace
                </div>
                <h2 className="text-balance text-3xl font-semibold leading-tight tracking-[-0.035em] text-foreground sm:text-4xl">
                  What should Orion finish for you?
                </h2>
                <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground sm:text-base">
                  Mix software, design, images, video, audio, research, testing,
                  and deployment in the same command. Orion selects the tools
                  and shows every result in the session.
                </p>
              </div>
              <OrionCommandBar appId={appId ?? undefined} />

              <div className="mt-4 grid gap-2 sm:grid-cols-3">
                {[
                  {
                    label: "Build and verify",
                    detail: "Code · test · preview · ship",
                    icon: Layers3,
                    to: "/apps" as const,
                  },
                  {
                    label: "Create media",
                    detail: "Model-aware local recipes",
                    icon: ImageIcon,
                    to: "/mediaai" as const,
                  },
                  {
                    label: "Use the network",
                    detail: "Share compute and tasks",
                    icon: Network,
                    to: "/network" as const,
                  },
                ].map(({ label, detail, icon: Icon, to }) => (
                  <Link
                    key={label}
                    to={to}
                    className="group flex items-center gap-2.5 rounded-2xl border border-border/70 bg-card/35 px-3 py-2.5 transition-colors hover:border-primary/25 hover:bg-card/60"
                  >
                    <Icon className="h-4 w-4 text-muted-foreground group-hover:text-primary" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs font-medium text-foreground">
                        {label}
                      </span>
                      <span className="block truncate text-[10px] text-muted-foreground">
                        {detail}
                      </span>
                    </span>
                    <ArrowRight className="h-3 w-3 text-muted-foreground/50" />
                  </Link>
                ))}
              </div>
            </main>
            <aside className="min-w-0 border-l border-border/60 pl-5">
              <OrionSessionsPanel />
            </aside>
          </div>
        </div>
        <PrivacyBanner />
        {releaseNotesDialog}
      </div>
    );
  }

  // Chat state: messages exist, standard chat-app layout.
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
                <div className="rounded-[18px] border border-primary/20 bg-primary px-4 py-2.5 max-w-[72%] text-sm text-primary-foreground shadow-[0_12px_32px_rgba(0,122,255,0.22)] whitespace-pre-wrap">
                  {msg.content}
                </div>
              </div>
            ) : (
              <div key={i} className="flex gap-3 items-start">
                <div className="w-7 h-7 rounded-full bg-primary/20 border border-primary/30 flex items-center justify-center flex-shrink-0 mt-0.5 text-xs text-primary font-bold select-none">
                  O
                </div>
                <div className="liquid-glass border border-black/[0.06] text-foreground rounded-[18px] px-4 py-3 max-w-[72%] text-sm leading-relaxed min-h-[2.5rem] prose dark:prose-invert prose-headings:mb-2 prose-p:my-1 prose-pre:my-2 prose-ol:my-2 prose-ul:my-2 prose-li:my-0.5 dark:border-white/[0.08]">
                  {msg.content ? (
                    <OrianBuilderMarkdownParser
                      content={msg.content}
                      chatId={null}
                      isStreaming={isReplying && i === chatMessages.length - 1}
                    />
                  ) : isReplying && i === chatMessages.length - 1 ? (
                    <span className="flex gap-1 items-center h-5">
                      <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:0ms]" />
                      <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:150ms]" />
                      <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:300ms]" />
                    </span>
                  ) : null}
                </div>
              </div>
            ),
          )}
          {/* Scroll anchor */}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input pinned to bottom */}
      <div className="shrink-0 bg-transparent/80 backdrop-blur-sm">
        <div className="w-full max-w-4xl mx-auto px-3 sm:px-6 lg:px-8 py-3">
          <HomeChatInput
            onSubmit={handleSubmit}
            isStreaming={isReplying}
            onCancel={handleCancelReply}
          />
        </div>
      </div>
    </div>
  );
}
