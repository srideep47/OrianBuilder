import { useAtom, useAtomValue } from "jotai";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import { useLoadApps } from "@/hooks/useLoadApps";
import { useRouter } from "@tanstack/react-router";
import { useSettings } from "@/hooks/useSettings";
import { Button } from "@/components/ui/button";
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
      <div className="@container z-11 w-full h-11 pt-3 bg-(--sidebar) absolute top-0 left-0 app-region-drag flex items-center">
        <div className={`${showWindowControls ? "pl-2" : "pl-18"}`}></div>

        <img
          src={logo}
          alt="OrianBuilder Logo"
          className="w-6 h-6 mr-0.5 ml-2"
        />
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                data-testid="title-bar-app-name-button"
                variant="outline"
                size="sm"
                className={`hidden @2xl:block no-app-region-drag text-xs max-w-38 truncate font-medium ${
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

        <TitleBarActions />

        {showWindowControls && <WindowsControls />}
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
    <div className="ml-auto flex -mt-3 no-app-region-drag">
      <button
        className="w-11 h-11 m-0 p-0 flex items-center justify-center hover:bg-white/[0.08] transition-colors text-foreground/80 hover:text-foreground"
        onClick={minimizeWindow}
        aria-label="Minimize"
      >
        <Minus size={14} strokeWidth={2} />
      </button>
      <button
        className="w-11 h-11 m-0 p-0 flex items-center justify-center hover:bg-white/[0.08] transition-colors text-foreground/80 hover:text-foreground"
        onClick={maximizeWindow}
        aria-label="Maximize"
      >
        <Square size={11} strokeWidth={1.6} />
      </button>
      <button
        className="w-11 h-11 m-0 p-0 flex items-center justify-center hover:bg-red-500/90 hover:text-white transition-colors text-foreground/80"
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
  const selectedAppId = useAtomValue(selectedAppIdAtom);
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
    <div
      className="flex items-center gap-0.5 no-app-region-drag mr-2 -mt-3"
      style={{ visibility: selectedAppId ? "visible" : "hidden" }}
    >
      <DropdownMenu>
        <DropdownMenuTrigger
          data-testid="preview-more-options-button"
          className="flex items-center justify-center w-8 h-8 rounded-md text-sm hover:bg-sidebar-accent transition-colors"
        >
          <Wrench size={16} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
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
        "hidden @2xl:block ml-1 no-app-region-drag h-7 bg-indigo-600 text-white dark:bg-indigo-600 dark:text-white text-xs px-2 pt-1 pb-1",
        !isOrianBuilderProEnabled && "bg-zinc-600 dark:bg-zinc-600",
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
      <TooltipTrigger>
        <div className="text-xs pl-1 mt-0.5">{remaining} credits</div>
      </TooltipTrigger>
      <TooltipContent>
        <div>
          <p>Note: there is a slight delay in updating the credit status.</p>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
