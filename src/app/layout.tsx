import { SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { SidebarPanel } from "@/components/SidebarPanel";
import { ThemeProvider } from "../contexts/ThemeContext";
import { DeepLinkProvider } from "../contexts/DeepLinkContext";
import { Toaster } from "sonner";
import { TitleBar } from "./TitleBar";
import { useEffect, type ReactNode } from "react";
import { useRunApp, useAppOutputSubscription } from "@/hooks/useRunApp";
import { useAtomValue, useSetAtom } from "jotai";
import { useRouterState, useNavigate } from "@tanstack/react-router";
import { GalaxyBackground } from "@/components/GalaxyBackground";
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

  // Redirect to onboarding on first launch
  useEffect(() => {
    const s = settings as typeof settings & { onboardingCompleted?: boolean };
    const pathname = routerState.location.pathname;
    if (s && !s.onboardingCompleted && pathname !== "/onboarding") {
      navigate({ to: "/onboarding", replace: true });
    }
  }, [settings, routerState.location.pathname, navigate]);

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

  useEffect(() => {
    document.body.classList.add("galaxy-mode");
    document.body.setAttribute("data-route", currentRoute);
    return () => {
      document.body.classList.remove("galaxy-mode");
      document.body.removeAttribute("data-route");
    };
  }, [currentRoute]);

  return (
    <>
      <ThemeProvider>
        <DeepLinkProvider>
          <GalaxyBackground />
          <SidebarProvider defaultOpen={false}>
            <TitleBar />
            <AppSidebar />
            <SidebarPanel />
            <div
              id="layout-main-content-container"
              className="flex h-screenish flex-1 min-w-0 overflow-hidden mt-11 mb-2 mr-2 sm:mb-4 sm:mr-4 border border-border rounded-r-lg bg-background"
            >
              {children}
            </div>
            <Toaster
              richColors
              duration={settings?.isTestMode ? 500 : undefined}
            />
          </SidebarProvider>
        </DeepLinkProvider>
      </ThemeProvider>
    </>
  );
}
