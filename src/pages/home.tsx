import { useTranslation } from "react-i18next";
import { useNavigate, useSearch } from "@tanstack/react-router";
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
import { OrionAdvanced } from "@/components/orion/OrionAdvanced";
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
import {
  ArrowUpRight,
  Boxes,
  Gamepad2,
  Image as ImageIcon,
  Network,
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
import { SpaceHeader } from "@/shell/SpaceHeader";
import {
  Card,
  LBadge,
  LButton,
  LoadingState,
  PageShell,
  Stack,
} from "@/components/liquid";

let hasCheckedReleaseNotes = false;

export interface HomeSubmitOptions {
  attachments?: FileAttachment[];
  selectedApp?: ListedApp;
}

/**
 * The Orion space — the app's front door.
 *
 * One job: turn a sentence into work. Everything that used to compete with the
 * command box for attention (engine panels, model tiers, storage, workflow
 * catalogue, a second copy of the composer, and a whole duplicate `/orion`
 * page) is either gone or behind the `OrionAdvanced` disclosure. What's left on
 * the page is the composer, four concrete next steps, and the sessions you
 * might want to return to.
 */
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

  const releaseNotesDialog = (
    <Dialog open={releaseNotesOpen} onOpenChange={setReleaseNotesOpen}>
      <DialogContent className="max-w-4xl gap-1 bg-(--docs-bg) pl-4 pr-0 pt-4">
        <DialogHeader>
          <DialogTitle>{t("whatsNew", { version: appVersion })}</DialogTitle>
          <LButton
            tone="ghost"
            size="compact"
            className="absolute right-10 top-2"
            icon={<ArrowUpRight />}
            onClick={() =>
              window.open(
                releaseUrl.replace("?hideHeader=true&theme=" + theme, ""),
                "_blank",
              )
            }
          >
            Open
          </LButton>
        </DialogHeader>
        <div className="flex h-[70vh] flex-col overflow-auto">
          {releaseUrl && (
            <div className="flex-1">
              <iframe
                src={releaseUrl}
                className="h-full w-full rounded-2xl border-0"
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

  if (isLoading) {
    return (
      <PageShell width="content" fill>
        <div className="flex h-full items-center justify-center">
          <LoadingState
            label={
              loadingMode === "existing"
                ? t("creatingNewChat")
                : t("settingUp").replace(/\.$/, "")
            }
          />
        </div>
      </PageShell>
    );
  }

  // Landing state: the command surface is the page.
  if (chatMessages.length === 0) {
    return (
      <>
        <PageShell
          width="wide"
          header={
            <SpaceHeader
              title="What should Orion finish for you?"
              description="Mix software, design, images, video, audio, research, testing and deployment in one command. Orion picks the tools and shows every result in the session."
              meta={
                <LBadge tone="success" dot>
                  local first
                </LBadge>
              }
            />
          }
        >
          {forceCloseDialog}
          <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
            <main className="flex min-w-0 flex-col">
              <Stack gap="base">
                <OrionCommandBar appId={appId ?? undefined} />
                <QuickStart />
                <OrionAdvanced />
              </Stack>
            </main>

            {/* Sessions sit in a rail, not inline: they're a way back into work
                you already started, which is a different intent from starting
                something new and shouldn't interrupt the composer's column. */}
            <aside className="min-w-0 xl:border-l xl:border-white/[0.07] xl:pl-6">
              <OrionSessionsPanel />
            </aside>
          </div>
        </PageShell>
        <PrivacyBanner />
        {releaseNotesDialog}
      </>
    );
  }

  // Conversation state: transcript with the composer pinned to the bottom.
  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      {forceCloseDialog}
      {releaseNotesDialog}

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[860px] flex-col gap-4 px-4 py-6 sm:px-6">
          {chatMessages.map((msg, i) =>
            msg.role === "user" ? (
              <div key={i} className="flex justify-end">
                <div className="max-w-[76%] whitespace-pre-wrap rounded-[18px] rounded-br-[6px] border border-white/25 bg-gradient-to-b from-[var(--cosmos-violet)] to-[var(--cosmos-violet-2)] px-4 py-2.5 text-[13px] leading-[1.55] text-white shadow-[0_10px_28px_rgba(107,79,216,0.28)]">
                  {msg.content}
                </div>
              </div>
            ) : (
              <div key={i} className="flex items-start gap-3">
                <div className="mt-0.5 flex h-7 w-7 shrink-0 select-none items-center justify-center rounded-full border border-primary/30 bg-primary/18 text-[11px] font-bold text-primary">
                  O
                </div>
                <div className="prose prose-sm dark:prose-invert min-h-[2.5rem] max-w-[76%] rounded-[18px] rounded-bl-[6px] border border-white/[0.10] bg-gradient-to-b from-white/[0.075] to-white/[0.025] px-4 py-3 text-[13px] leading-[1.6] text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.09)] prose-headings:mb-2 prose-p:my-1 prose-ol:my-2 prose-ul:my-2 prose-li:my-0.5 prose-pre:my-2">
                  {msg.content ? (
                    <OrianBuilderMarkdownParser
                      content={msg.content}
                      chatId={null}
                      isStreaming={isReplying && i === chatMessages.length - 1}
                    />
                  ) : isReplying && i === chatMessages.length - 1 ? (
                    <span className="flex h-5 items-center gap-1">
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/50 [animation-delay:0ms]" />
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/50 [animation-delay:150ms]" />
                      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/50 [animation-delay:300ms]" />
                    </span>
                  ) : null}
                </div>
              </div>
            ),
          )}
          <div ref={messagesEndRef} />
        </div>
      </div>

      <div className="shrink-0 border-t border-white/[0.07] bg-[color-mix(in_srgb,var(--cosmos-bg)_55%,transparent)] backdrop-blur-[24px]">
        <div className="mx-auto w-full max-w-[860px] px-4 py-3 sm:px-6">
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

/**
 * Four concrete starting points, one per space that can begin work. Named for
 * the outcome rather than the destination — "Create media" says more about what
 * you'll get than "Media Studio" does.
 */
const QUICK_START = [
  {
    to: "/apps",
    label: "Open a project",
    // Detail lines are kept short enough to survive a three-across grid in a
    // 1280px window — the first drafts truncated mid-word at that size, which
    // reads as breakage rather than brevity.
    detail: "Pick up where you left off",
    icon: Boxes,
  },
  {
    to: "/game",
    label: "Make a game",
    detail: "Godot, driven by hand or by Orion",
    icon: Gamepad2,
  },
  {
    to: "/mediaai",
    label: "Create media",
    detail: "Image, video, audio and 3D",
    icon: ImageIcon,
  },
  {
    to: "/network",
    label: "Use the network",
    detail: "Share compute with peers",
    icon: Network,
  },
] as const;

function QuickStart() {
  const navigate = useNavigate();
  return (
    <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-4">
      {QUICK_START.map(({ to, label, detail, icon: Icon }) => (
        <Card
          key={to}
          corner="sm"
          onSelect={() => navigate({ to })}
          className="group flex items-center gap-3 px-3.5 py-3"
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[11px] bg-white/[0.07] text-muted-foreground transition-colors group-hover:bg-primary/15 group-hover:text-primary">
            <Icon className="h-4 w-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium text-foreground">
              {label}
            </span>
            <span className="block truncate text-[11px] text-muted-foreground">
              {detail}
            </span>
          </span>
          <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/45 transition-colors group-hover:text-primary" />
        </Card>
      ))}
    </div>
  );
}
