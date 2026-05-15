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
  const [performanceData, setPerformanceData] = useState<any>(undefined);
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
        const result = await ipc.system.doesReleaseNoteExist({ version: appVersion });
        if (result.exists && result.url) {
          setReleaseUrl(result.url + "?hideHeader=true&theme=" + theme);
          setReleaseNotesOpen(true);
        }
      } catch (err) {
        console.warn("Unable to check if release note exists for: " + appVersion, err);
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
        chatId = await ipc.chat.createChat({ appId: selectedApp.id, initialChatMode });
        appId = selectedApp.id;
      } else {
        const templateSelection = await ipc.template.selectTemplateForPrompt({ prompt: inputValue });
        const result = await ipc.app.createApp({
          name: templateSelection.appName,
          initialChatMode,
          templateId: templateSelection.templateId,
        });
        chatId = result.chatId;
        appId = result.app.id;

        if (NEON_TEMPLATE_IDS.has(templateSelection.templateId)) {
          await neonTemplateHook({ appId: result.app.id, appName: result.app.name });
        }

        if (settings?.selectedThemeId) {
          await ipc.template.setAppTheme({ appId: result.app.id, themeId: settings.selectedThemeId || null });
        }
      }

      streamMessage({ prompt: inputValue, chatId, appId, attachments, requestedChatMode: initialChatMode });
      await new Promise((resolve) => setTimeout(resolve, settings?.isTestMode ? 0 : 2000));

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
            {loadingMode === "existing" ? t("creatingNewChat") : (
              <>{t("settingUp")}<br />{t("mightTakeMoment")}</>
            )}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full w-full items-center justify-center">
      <ForceCloseDialog
        isOpen={forceCloseDialogOpen}
        onClose={() => setForceCloseDialogOpen(false)}
        performanceData={performanceData}
      />

      {/* Centered input — the only persistent UI on the home page */}
      <div className="w-full max-w-4xl px-3 sm:px-6 lg:px-8">
        <HomeChatInput onSubmit={handleSubmit} />
      </div>

      <PrivacyBanner />

      <Dialog open={releaseNotesOpen} onOpenChange={setReleaseNotesOpen}>
        <DialogContent className="max-w-4xl bg-(--docs-bg) pr-0 pt-4 pl-4 gap-1">
          <DialogHeader>
            <DialogTitle>{t("whatsNew", { version: appVersion })}</DialogTitle>
            <Button
              variant="ghost"
              size="sm"
              className="absolute right-10 top-2 focus-visible:ring-0 focus-visible:ring-offset-0"
              onClick={() =>
                window.open(releaseUrl.replace("?hideHeader=true&theme=" + theme, ""), "_blank")
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
  );
}
