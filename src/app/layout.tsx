import { SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { SidebarPanel } from "@/components/SidebarPanel";
import { ThemeProvider } from "../contexts/ThemeContext";
import { DeepLinkProvider } from "../contexts/DeepLinkContext";
import { Toaster } from "sonner";
import { TitleBar } from "./TitleBar";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { useRunApp, useAppOutputSubscription } from "@/hooks/useRunApp";
import { useAtomValue, useSetAtom } from "jotai";
import { useRouterState, useNavigate } from "@tanstack/react-router";
import {
  appConsoleEntriesAtom,
  previewModeAtom,
  selectedAppIdAtom,
} from "@/atoms/appAtoms";
import { useSettings } from "@/hooks/useSettings";
import { DEFAULT_ZOOM_LEVEL } from "@/lib/schemas";
import { selectedComponentsPreviewAtom } from "@/atoms/previewAtoms";
import { usePlanEvents } from "@/hooks/usePlanEvents";
import { useZoomShortcuts } from "@/hooks/useZoomShortcuts";
import { useQueueProcessor } from "@/hooks/useQueueProcessor";
import { useMissionAutoResume } from "@/hooks/useMissionAutoResume";
import i18n from "@/i18n";
import { LanguageSchema } from "@/lib/schemas";
import { ipc, type GeneratedMediaItem } from "@/ipc/types";
import { PublishToInstagramDialog } from "@/components/PublishToInstagramDialog";

export default function RootLayout({ children }: { children: ReactNode }) {
  const { refreshAppIframe } = useRunApp();
  // Subscribe to app output events once at the root level to avoid duplicates
  useAppOutputSubscription();
  const previewMode = useAtomValue(previewModeAtom);
  const { settings } = useSettings();
  const routerState = useRouterState();
  const navigate = useNavigate();
  const currentRoute = routerState.location.pathname.split("/")[1] || "home";
  const setSelectedComponentsPreview = useSetAtom(
    selectedComponentsPreviewAtom,
  );
  const selectedAppId = useAtomValue(selectedAppIdAtom);
  const setConsoleEntries = useSetAtom(appConsoleEntriesAtom);

  // Initialize plan events listener
  usePlanEvents();

  // Redirect to onboarding only on the very first load (no settings yet)
  useEffect(() => {
    const s = settings as typeof settings & {
      onboardingCompleted?: boolean;
      isTestMode?: boolean;
    };
    const pathname = routerState.location.pathname;
    // Only redirect if settings are loaded and onboarding was never completed
    // and we're currently on the root path (don't interrupt other navigation)
    if (
      s &&
      s.onboardingCompleted === false &&
      s.isTestMode !== true &&
      pathname === "/"
    ) {
      navigate({ to: "/onboarding", replace: true });
    }
  }, [settings]);

  // Zoom keyboard shortcuts (Ctrl/Cmd + =/- /0)
  useZoomShortcuts();

  // Process queued messages globally (even when not on chat page)
  useQueueProcessor();

  // Trigger auto-resume of interrupted missions once after app load.
  useMissionAutoResume();

  useEffect(() => {
    const zoomLevel = settings?.zoomLevel ?? DEFAULT_ZOOM_LEVEL;
    const zoomFactor = Number(zoomLevel) / 100;

    const electronApi = (
      window as Window & {
        electron?: {
          webFrame?: {
            setZoomFactor: (factor: number) => void;
          };
        };
      }
    ).electron;

    if (electronApi?.webFrame?.setZoomFactor) {
      electronApi.webFrame.setZoomFactor(zoomFactor);

      return () => {
        electronApi.webFrame?.setZoomFactor(Number(DEFAULT_ZOOM_LEVEL) / 100);
      };
    }

    return () => {};
  }, [settings?.zoomLevel]);

  // Sync i18n language with persisted user setting
  useEffect(() => {
    const parsed = LanguageSchema.safeParse(settings?.language);
    const language = parsed.success ? parsed.data : "en";
    if (i18n.language !== language) {
      i18n.changeLanguage(language);
    }
  }, [settings?.language]);

  // Global keyboard listener for refresh events
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Check for Ctrl+R (Windows/Linux) or Cmd+R (macOS)
      if (event.key === "r" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault(); // Prevent default browser refresh
        if (previewMode === "preview") {
          refreshAppIframe(); // Use our custom refresh function instead
        }
      }
    };

    // Add event listener to document
    document.addEventListener("keydown", handleKeyDown);

    // Cleanup function to remove event listener
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [refreshAppIframe, previewMode]);

  useEffect(() => {
    setSelectedComponentsPreview([]);
    setConsoleEntries([]);
  }, [selectedAppId]);

  // When a scheduled Instagram job fires (the engine can't auto-upload IG),
  // open the share-assist dialog so the user finishes in two clicks.
  const [firedIgItem, setFiredIgItem] = useState<GeneratedMediaItem | null>(
    null,
  );
  useEffect(() => {
    const unsub = ipc.events.schedule.onFired(async (p) => {
      if (p.platform !== "instagram") return;
      try {
        const items = await ipc.generatedMedia.list(undefined);
        const item = items.find((i) => i.fileName === p.fileName);
        if (item) setFiredIgItem(item);
      } catch {
        // List failed — silently ignore; the desktop notif still showed.
      }
    });
    return unsub;
  }, []);

  useEffect(() => {
    document.body.setAttribute("data-route", currentRoute);
    return () => {
      document.body.removeAttribute("data-route");
    };
  }, [currentRoute]);

  return (
    <>
      <ThemeProvider>
        <DeepLinkProvider>
          <SidebarProvider
            defaultOpen={true}
            style={{ "--sidebar-width": "5.5rem" } as CSSProperties}
          >
            <TitleBar />
            <AppSidebar />
            <SidebarPanel />
            <div
              id="layout-main-content-container"
              className="liquid-glass flex h-screenish flex-1 min-w-0 overflow-hidden relative z-0 mt-[var(--app-titlebar-height)] mb-2 mr-2 rounded-[24px] border border-black/[0.06] bg-card/80 shadow-[0_24px_80px_rgba(15,23,42,0.08)] dark:border-white/[0.08] dark:bg-card/70 dark:shadow-[0_24px_80px_rgba(0,0,0,0.4)] sm:mb-3 sm:mr-3"
            >
              {children}
            </div>
            <Toaster
              richColors
              duration={settings?.isTestMode ? 500 : undefined}
            />
            {firedIgItem && (
              <PublishToInstagramDialog
                item={firedIgItem}
                open={true}
                onOpenChange={(o) => {
                  if (!o) setFiredIgItem(null);
                }}
              />
            )}
          </SidebarProvider>
        </DeepLinkProvider>
      </ThemeProvider>
    </>
  );
}
