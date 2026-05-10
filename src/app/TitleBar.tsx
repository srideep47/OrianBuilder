import { useAtom, useAtomValue } from "jotai";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import { useLoadApps } from "@/hooks/useLoadApps";
import { useRouter, useRouterState } from "@tanstack/react-router";
import { useSettings } from "@/hooks/useSettings";
import { Button } from "@/components/ui/button";
// @ts-ignore
import logo from "../../assets/logo.svg";
import { providerSettingsRoute } from "@/routes/settings/providers/$provider";
import { cn } from "@/lib/utils";
import { useDeepLink } from "@/contexts/DeepLinkContext";
import { useCallback, useEffect, useState } from "react";
import { DyadProSuccessDialog } from "@/components/DyadProSuccessDialog";
import { useTheme } from "@/contexts/ThemeContext";
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
import { Wrench, Cog, Trash2 } from "lucide-react";
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
  const { t } = useTranslation("home");
  const [selectedAppId] = useAtom(selectedAppIdAtom);
  const selectedChatId = useAtomValue(selectedChatIdAtom);
  const { apps } = useLoadApps();
  const { navigate } = useRouter();
  const { refreshSettings } = useSettings();
  const queryClient = useQueryClient();
  const [isSuccessDialogOpen, setIsSuccessDialogOpen] = useState(false);
  const platform = useSystemPlatform();
  const showWindowControls = platform !== null && platform !== "darwin";

  const showDyadProSuccessDialog = () => {
    setIsSuccessDialogOpen(true);
  };

  const { lastDeepLink, clearLastDeepLink } = useDeepLink();
  useEffect(() => {
    const handleDeepLink = async () => {
      if (lastDeepLink?.type === "dyad-pro-return") {
        await refreshSettings();
        // Refetch user budget when OrianBuilder Pro key is set via deep link
        queryClient.invalidateQueries({ queryKey: queryKeys.userBudget.info });
        showDyadProSuccessDialog();
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

  const routerState = useRouterState();
  const isHomeRoute = routerState.location.pathname === "/";

  const handleAppClick = () => {
    if (selectedApp) {
      navigate({ to: "/app-details", search: { appId: selectedApp.id } });
    }
  };

  const ctx = routerState.location.pathname.replace('/', '') || 'apps';

  return (
    <>
      <div className="design-topbar z-11 absolute top-0 left-0 w-full">
        {/* Left padding: macOS needs space for traffic lights, Windows for sidebar icon column */}
        <div style={{ width: showWindowControls ? '64px' : '76px', flexShrink: 0 }} />
        <span className="app-ctx">
          <span className="dot" />
          OrianBuilder · {ctx}
        </span>

        {!isHomeRoute && (
          <div className="flex-1 min-w-0 overflow-hidden">
            <ChatTabs selectedChatId={selectedChatId} />
          </div>
        )}

        {isHomeRoute && (
          <button
            className="win-btn text-[10px] font-medium px-2 whitespace-nowrap"
            style={{ width: 'auto', color: 'rgba(168,140,255,.9)' }}
            onClick={() =>
              navigate({
                to: providerSettingsRoute.id,
                params: { provider: "auto" },
              })
            }
          >
            {t("proBanner.alreadyHavePro")}
          </button>
        )}

        {!isHomeRoute && <TitleBarActions />}

        {showWindowControls && <DesignWindowControls />}
      </div>

      <DyadProSuccessDialog
        isOpen={isSuccessDialogOpen}
        onClose={() => setIsSuccessDialogOpen(false)}
      />
    </>
  );
};

function DesignWindowControls() {
  return (
    <div className="win-btns">
      <button className="win-btn" aria-label="Minimize" onClick={() => ipc.system.minimizeWindow()}>—</button>
      <button className="win-btn" aria-label="Maximize" onClick={() => ipc.system.maximizeWindow()}>⤢</button>
      <button className="win-btn close" aria-label="Close" onClick={() => ipc.system.closeWindow()}>✕</button>
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
      className="flex items-center gap-0.5 no-app-region-drag mr-2"
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

export function DyadProButton({
  isDyadProEnabled,
}: {
  isDyadProEnabled: boolean;
}) {
  const { navigate } = useRouter();
  const { userBudget } = useUserBudgetInfo();
  return (
    <Button
      data-testid="title-bar-dyad-pro-button"
      onClick={() => {
        navigate({
          to: providerSettingsRoute.id,
          params: { provider: "auto" },
        });
      }}
      variant="outline"
      className={cn(
        "hidden @2xl:block ml-1 no-app-region-drag h-7 bg-indigo-600 text-white dark:bg-indigo-600 dark:text-white text-xs px-2 pt-1 pb-1",
        !isDyadProEnabled && "bg-zinc-600 dark:bg-zinc-600",
      )}
      size="sm"
    >
      {isDyadProEnabled
        ? userBudget?.isTrial
          ? "Pro Trial"
          : "Pro"
        : "Pro (off)"}
      {userBudget && isDyadProEnabled && (
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
