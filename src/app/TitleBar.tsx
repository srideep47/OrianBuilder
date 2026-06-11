import { useAtom, useAtomValue } from "jotai";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import { useLoadApps } from "@/hooks/useLoadApps";
import { useRouter } from "@tanstack/react-router";
import { useSettings } from "@/hooks/useSettings";
import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
// @ts-ignore
import logo from "../../assets/logo.svg";
import { providerSettingsRoute } from "@/routes/settings/providers/$provider";
import { cn } from "@/lib/utils";
import { useDeepLink } from "@/contexts/DeepLinkContext";
import { useCallback, useEffect, useState } from "react";
import { OrianBuilderProSuccessDialog } from "@/components/OrianBuilderProSuccessDialog";
import { ipc } from "@/ipc/types";
import { useSystemPlatform } from "@/hooks/useSystemPlatform";
import { useUserBudgetInfo } from "@/hooks/useUserBudgetInfo";
import type { UserBudgetInfo } from "@/ipc/types";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ChatTabs } from "@/components/chat/ChatTabs";
import { selectedChatIdAtom } from "@/atoms/chatAtoms";
import { Wrench, Cog, Trash2, Minus, Square, X as XIcon } from "lucide-react";
import { NotificationsDrawer } from "@/components/network/NotificationsDrawer";
import { ComputeRoutingPopover } from "@/components/ComputeRoutingPopover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useRunApp } from "@/hooks/useRunApp";
import { showError, showSuccess } from "@/lib/toast";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";
import { useTranslation } from "react-i18next";

export const TitleBar = () => {
  const [selectedAppId] = useAtom(selectedAppIdAtom);
  const selectedChatId = useAtomValue(selectedChatIdAtom);
  const { apps } = useLoadApps();
  const { navigate } = useRouter();
  const { refreshSettings } = useSettings();
  const queryClient = useQueryClient();
  const [isSuccessDialogOpen, setIsSuccessDialogOpen] = useState(false);
  const platform = useSystemPlatform();
  const showWindowControls = platform !== null && platform !== "darwin";

  const showOrianBuilderProSuccessDialog = () => {
    setIsSuccessDialogOpen(true);
  };

  const { lastDeepLink, clearLastDeepLink } = useDeepLink();
  useEffect(() => {
    const handleDeepLink = async () => {
      if (lastDeepLink?.type === "orianbuilder-pro-return") {
        await refreshSettings();
        // Refetch user budget when OrianBuilder Pro key is set via deep link
        queryClient.invalidateQueries({ queryKey: queryKeys.userBudget.info });
        showOrianBuilderProSuccessDialog();
        clearLastDeepLink();
      }
    };
    handleDeepLink();
  }, [lastDeepLink?.timestamp]);

  // Get selected app name
  const selectedApp = apps.find((app) => app.id === selectedAppId);
  const displayText = selectedApp
    ? `App: ${selectedApp.name}`
    : "(no app selected)";

  const handleAppClick = () => {
    if (selectedApp) {
      navigate({ to: "/app-details", search: { appId: selectedApp.id } });
    }
  };

  return (
    <>
      <div className="@container liquid-glass-thick absolute top-0 left-0 z-50 flex h-[var(--app-titlebar-height)] w-full items-center gap-2 border-b border-black/[0.06] px-3.5 py-2 shadow-[0_10px_32px_rgba(15,23,42,0.05)] transition-colors dark:border-white/[0.08] dark:shadow-[0_10px_32px_rgba(0,0,0,0.28)] app-region-drag">
        <div className={showWindowControls ? "w-1" : "w-18"} />

        <SidebarTrigger className="h-9 w-9 rounded-full no-app-region-drag" />

        <img src={logo} alt="OrianBuilder Logo" className="ml-1 h-7 w-7" />
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                data-testid="title-bar-app-name-button"
                variant="outline"
                size="sm"
                className={`hidden @2xl:flex no-app-region-drag h-9 max-w-[11.5rem] items-center justify-start rounded-full border-white/60 bg-white/60 px-3 text-xs font-medium shadow-[inset_0_1px_0_rgba(255,255,255,0.65)] dark:border-white/10 dark:bg-white/[0.06] ${
                  selectedApp ? "cursor-pointer" : ""
                }`}
                onClick={handleAppClick}
              />
            }
          >
            {displayText}
          </TooltipTrigger>
          <TooltipContent>
            {selectedApp ? selectedApp.name : "No app selected"}
          </TooltipContent>
        </Tooltip>

        <div className="flex-1 min-w-0 overflow-hidden no-app-region-drag">
          <ChatTabs selectedChatId={selectedChatId} />
        </div>

        <div className="ml-auto flex items-center gap-1 no-app-region-drag">
          <ComputeRoutingPopover />
          <NotificationsDrawer />
          <TitleBarActions />
          {showWindowControls && <WindowsControls />}
        </div>
      </div>

      <OrianBuilderProSuccessDialog
        isOpen={isSuccessDialogOpen}
        onClose={() => setIsSuccessDialogOpen(false)}
      />
    </>
  );
};

function WindowsControls() {
  const minimizeWindow = () => {
    ipc.system.minimizeWindow();
  };

  const maximizeWindow = () => {
    ipc.system.maximizeWindow();
  };

  const closeWindow = () => {
    ipc.system.closeWindow();
  };

  return (
    <div className="flex h-9 overflow-hidden rounded-[14px] border border-black/[0.06] bg-white/50 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] dark:border-white/[0.06] dark:bg-white/[0.04] no-app-region-drag">
      <button
        className="flex h-9 w-10 items-center justify-center p-0 text-foreground/72 transition-colors hover:bg-black/[0.05] hover:text-foreground dark:hover:bg-white/[0.08]"
        onClick={minimizeWindow}
        aria-label="Minimize"
      >
        <Minus size={14} strokeWidth={2} />
      </button>
      <button
        className="flex h-9 w-10 items-center justify-center p-0 text-foreground/72 transition-colors hover:bg-black/[0.05] hover:text-foreground dark:hover:bg-white/[0.08]"
        onClick={maximizeWindow}
        aria-label="Maximize"
      >
        <Square size={11} strokeWidth={1.6} />
      </button>
      <button
        className="flex h-9 w-10 items-center justify-center p-0 text-foreground/72 transition-colors hover:bg-[#ff453a] hover:text-white"
        onClick={closeWindow}
        aria-label="Close"
      >
        <XIcon size={14} strokeWidth={2} />
      </button>
    </div>
  );
}

function TitleBarActions() {
  const { t } = useTranslation("home");
  const { restartApp, refreshAppIframe } = useRunApp();
  const { settings } = useSettings();
  const isCloudSandboxMode = settings?.runtimeMode2 === "cloud";

  const onCleanRestart = useCallback(() => {
    restartApp({ removeNodeModules: true });
  }, [restartApp]);

  const useClearSessionData = () => {
    return useMutation({
      mutationFn: () => {
        return ipc.system.clearSessionData();
      },
      onSuccess: async () => {
        await refreshAppIframe();
        showSuccess("Preview data cleared");
      },
      onError: (error) => {
        showError(`Error clearing preview data: ${error}`);
      },
    });
  };

  const { mutate: clearSessionData } = useClearSessionData();

  const onClearSessionData = useCallback(() => {
    clearSessionData();
  }, [clearSessionData]);

  const onRecreateSandbox = useCallback(() => {
    restartApp({ recreateSandbox: true });
  }, [restartApp]);

  return (
    <div className="mr-1 flex items-center gap-1 no-app-region-drag">
      <DropdownMenu>
        <DropdownMenuTrigger
          data-testid="preview-more-options-button"
          className="liquid-glass-thin flex h-9 w-9 items-center justify-center rounded-full border border-black/[0.05] text-sm transition-colors hover:bg-black/[0.04] dark:border-white/[0.08] dark:hover:bg-white/[0.08]"
        >
          <Wrench size={16} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60 p-1.5">
          <DropdownMenuItem onClick={onCleanRestart}>
            <Cog size={16} />
            <div className="flex flex-col">
              <span>{t("preview.rebuild")}</span>
              <span className="text-xs text-muted-foreground">
                {t("preview.rebuildDescription")}
              </span>
            </div>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onClearSessionData}>
            <Trash2 size={16} />
            <div className="flex flex-col">
              <span>{t("preview.clearCache")}</span>
              <span className="text-xs text-muted-foreground">
                {t("preview.clearCacheDescription")}
              </span>
            </div>
          </DropdownMenuItem>
          {isCloudSandboxMode && (
            <DropdownMenuItem onClick={onRecreateSandbox}>
              <Cog size={16} />
              <div className="flex flex-col">
                <span>Recreate Sandbox</span>
                <span className="text-xs text-muted-foreground">
                  Destroys the current sandbox and creates a new one
                </span>
              </div>
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export function OrianBuilderProButton({
  isOrianBuilderProEnabled,
}: {
  isOrianBuilderProEnabled: boolean;
}) {
  const { navigate } = useRouter();
  const { userBudget } = useUserBudgetInfo();
  return (
    <Button
      data-testid="title-bar-orianbuilder-pro-button"
      onClick={() => {
        navigate({
          to: providerSettingsRoute.id,
          params: { provider: "auto" },
        });
      }}
      variant="outline"
      className={cn(
        "hidden @2xl:flex ml-1 h-8 items-center rounded-full border-none bg-primary px-3 text-xs text-primary-foreground shadow-[0_12px_24px_rgba(0,122,255,0.24)] no-app-region-drag dark:shadow-[0_12px_24px_rgba(10,132,255,0.24)]",
        !isOrianBuilderProEnabled &&
          "bg-secondary text-secondary-foreground shadow-none",
      )}
      size="sm"
    >
      {isOrianBuilderProEnabled
        ? userBudget?.isTrial
          ? "Pro Trial"
          : "Pro"
        : "Pro (off)"}
      {userBudget && isOrianBuilderProEnabled && (
        <AICreditStatus userBudget={userBudget} />
      )}
    </Button>
  );
}

export function AICreditStatus({
  userBudget,
}: {
  userBudget: NonNullable<UserBudgetInfo>;
}) {
  const remaining = Math.round(
    userBudget.totalCredits - userBudget.usedCredits,
  );
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div className="ml-1 rounded-full bg-white/18 px-2 py-0.5 text-[11px] font-medium text-primary-foreground/90" />
        }
      >
        {remaining} credits
      </TooltipTrigger>
      <TooltipContent>
        <div>
          <p>Note: there is a slight delay in updating the credit status.</p>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
