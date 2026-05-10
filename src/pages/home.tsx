import { useTranslation } from "react-i18next";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { providerSettingsRoute } from "@/routes/settings/providers/$provider";
import { useAtom, useSetAtom } from "jotai";
import { homeChatInputValueAtom } from "../atoms/chatAtoms";
import { ipc } from "@/ipc/types";
import { generateCuteAppName } from "@/lib/utils";
import { useLoadApps } from "@/hooks/useLoadApps";
import { useSettings } from "@/hooks/useSettings";
import { SetupBanner } from "@/components/SetupBanner";
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
import { ImportAppButton } from "@/components/ImportAppButton";
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
import { autoSelectTemplate } from "@/lib/template_auto_select";
import { getEffectiveDefaultChatMode } from "@/lib/schemas";
import { useFreeAgentQuota } from "@/hooks/useFreeAgentQuota";
import { useInitialChatMode } from "@/hooks/useInitialChatMode";

// Track whether we've already checked release notes this session (module-scoped
// so it persists across component unmount/remount cycles).
let hasCheckedReleaseNotes = false;

const QUICK_ACTIONS = [
  { icon: "📋", label: "TODO list app" },
  { icon: "🏠", label: "Landing Page" },
  { icon: "📝", label: "Sign Up Form" },
] as const;

// Adding an export for attachments
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
  const [performanceData, setPerformanceData] = useState<any>(undefined);
  const { streamMessage } = useStreamChat({ hasChatId: false });
  const posthog = usePostHog();
  const appVersion = useAppVersion();
  const [releaseNotesOpen, setReleaseNotesOpen] = useState(false);
  const [releaseUrl, setReleaseUrl] = useState("");
  const { theme } = useTheme();
  const queryClient = useQueryClient();

  // Listen for force-close events
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
      await updateSettings({
        lastShownReleaseNotesVersion: appVersion,
      });
      // It feels spammy to show release notes if it's
      // the users very first time.
      if (!shouldShowReleaseNotes) {
        return;
      }

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

  // Get the appId from search params
  const appId = search.appId ? Number(search.appId) : null;

  // Redirect to app details page if appId is present
  useEffect(() => {
    if (appId) {
      navigate({ to: "/app-details", search: { appId } });
    }
  }, [appId, navigate]);

  // Apply default chat mode when navigating to home page
  // Wait for quota status to load to avoid race condition where we default to Basic Agent
  // before knowing if quota is actually exceeded
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

  const handleSubmit = async (options?: HomeSubmitOptions) => {
    const attachments = options?.attachments || [];
    const selectedApp = options?.selectedApp;

    if (!inputValue.trim() && attachments.length === 0) return;

    try {
      setLoadingMode(selectedApp ? "existing" : "new");
      setIsLoading(true);

      let chatId: number;
      let appId: number;
      if (selectedApp) {
        // Existing app flow: create a new chat in the selected app
        chatId = await ipc.chat.createChat({
          appId: selectedApp.id,
          initialChatMode,
        });
        appId = selectedApp.id;
      } else {
        // New app flow (default behavior)
        const autoTemplateId = autoSelectTemplate(inputValue);
        const result = await ipc.app.createApp({
          name: generateCuteAppName(),
          initialChatMode,
          templateId: autoTemplateId,
        });
        chatId = result.chatId;
        appId = result.app.id;

        if (NEON_TEMPLATE_IDS.has(autoTemplateId)) {
          await neonTemplateHook({
            appId: result.app.id,
            appName: result.app.name,
          });
        }

        // Apply selected theme to the new app (if one is set)
        if (settings?.selectedThemeId) {
          await ipc.template.setAppTheme({
            appId: result.app.id,
            themeId: settings.selectedThemeId || null,
          });
        }
      }

      // Stream the message with attachments
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
      // Invalidate chats so ChatTabs picks up the new chat immediately.
      await queryClient.invalidateQueries({ queryKey: queryKeys.chats.all });
      posthog.capture("home:chat-submit", { existingApp: !!selectedApp });
      // Select newly created first chat so it appears first in tabs.
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

  // Loading overlay for app creation
  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center max-w-3xl m-auto p-8">
        <div className="w-full flex flex-col items-center">
          {/* Loading Spinner */}
          <div className="relative w-24 h-24 mb-8">
            <div className="absolute top-0 left-0 w-full h-full border-8 border-gray-200 dark:border-gray-700 rounded-full"></div>
            <div className="absolute top-0 left-0 w-full h-full border-8 border-t-primary rounded-full animate-spin"></div>
          </div>
          <h2 className="text-2xl font-bold mb-2 text-gray-800 dark:text-gray-200">
            {loadingMode === "existing" ? t("startingChat") : t("buildingApp")}
          </h2>
          <p className="text-gray-600 dark:text-gray-400 text-center max-w-md mb-8">
            {loadingMode === "existing" ? (
              t("creatingNewChat")
            ) : (
              <>
                {t("settingUp")} <br />
                {t("mightTakeMoment")}
              </>
            )}
          </p>
        </div>
      </div>
    );
  }

  // Main Home Page Content — Design: AppsPage layout
  return (
    <div className="apps-stage">
      <ForceCloseDialog
        isOpen={forceCloseDialogOpen}
        onClose={() => setForceCloseDialogOpen(false)}
        performanceData={performanceData}
      />

      <div className="orbital">
        <div className="orbital-rings" aria-hidden />

        {/* Hero */}
        <div className="apps-hero">
          <span className="eyebrow">Mission Control · Setup</span>
          <h1>Setup OrianBuilder</h1>
        </div>

        {/* Setup wizard: video card + step cards (real logic) */}
        <SetupBanner />

        {/* Import + Prompt block */}
        <div style={{ display: 'flex', justifyContent: 'center', margin: '14px 0' }}>
          <ImportAppButton className="btn primary" />
        </div>

        <div className="glass" style={{ borderRadius: 12, padding: 14 }}>
          <HomeChatInput onSubmit={handleSubmit} />

          <div className="chip-row">
            {QUICK_ACTIONS.map((item) => (
              <span
                key={item.label}
                className="chip"
                onClick={() => setInputValue(item.label)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === 'Enter' && setInputValue(item.label)}
              >
                {item.icon} {item.label}
              </span>
            ))}
          </div>
        </div>

        {/* Promo */}
        <div className="promo">
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, color: '#5fdfa3', fontWeight: 500 }}>
              {t("proBanner.upTo3xCheaper")}
            </div>
            <div style={{ fontSize: 10, color: 'rgba(95,223,163,.65)' }}>
              {t("proBanner.byUsingSmartContext")}
            </div>
          </div>
          <button
            className="btn sm"
            style={{ background: 'rgba(60,200,140,.18)', borderColor: 'rgba(60,200,140,.35)', color: '#5fdfa3' }}
            onClick={() => navigate({ to: providerSettingsRoute.id, params: { provider: "auto" } })}
          >
            {t("proBanner.getDyadPro")} →
          </button>
        </div>

        <PrivacyBanner />

        {/* Release Notes Dialog */}
        <Dialog open={releaseNotesOpen} onOpenChange={setReleaseNotesOpen}>
          <DialogContent className="max-w-4xl bg-(--docs-bg) pr-0 pt-4 pl-4 gap-1">
            <DialogHeader>
              <DialogTitle>
                {t("whatsNew", { version: appVersion })}
              </DialogTitle>
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
      </div>
    </div>
  );
}

function PromoBanner() {
  const { t } = useTranslation("home");
  const navigate = useNavigate();

  return (
    <div className="galaxy-promo-banner flex items-center gap-3 px-4 py-3 rounded-lg border border-emerald-500/20 bg-emerald-500/10 w-fit mt-4 mb-2">
      <div>
        <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400">
          {t("proBanner.upTo3xCheaper")}
        </p>
        <p className="text-xs text-emerald-700/70 dark:text-emerald-400/70">
          {t("proBanner.byUsingSmartContext")}
        </p>
      </div>
      <button
        onClick={() =>
          navigate({
            to: providerSettingsRoute.id,
            params: { provider: "auto" },
          })
        }
        className="px-3 py-1.5 text-xs font-medium text-white bg-emerald-600 rounded-md hover:bg-emerald-700 transition-colors whitespace-nowrap dark:bg-emerald-600 dark:hover:bg-emerald-700"
      >
        {t("proBanner.getDyadPro")}
      </button>
    </div>
  );
}
