import { SidebarProvider } from "@/components/ui/sidebar";
import { NavRail } from "@/shell/NavRail";
import { ContextPanel } from "@/shell/ContextPanel";
import { CosmicBackdrop } from "@/components/liquid";
import { ThemeProvider } from "../contexts/ThemeContext";
import { DeepLinkProvider } from "../contexts/DeepLinkContext";
import { Toaster } from "sonner";
import { TitleBar } from "@/shell/TitleBar";
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
          {/* The nebula sits behind everything, so the Liquid surfaces above it
              have something real to refract. */}
          <CosmicBackdrop />
          <SidebarProvider
            defaultOpen={true}
            // `bg-transparent` overrides the provider's own `bg-sidebar`, which
            // is a 72%-opaque near-black spanning the whole viewport — it sat on
            // top of the nebula and was the reason the app read as flat black
            // however translucent everything above it was. The rail and the
            // context panel carry their own translucent backgrounds, so the
            // wrapper doesn't need one.
            className="bg-transparent"
            style={
              { "--sidebar-width": "var(--shell-rail-width)" } as CSSProperties
            }
          >
            <TitleBar />
            <NavRail />
            <ContextPanel />
            <div
              id="layout-main-content-container"
              className="relative z-0 mt-[var(--app-titlebar-height)] flex h-screenish min-w-0 flex-1 overflow-hidden rounded-tl-[20px] border-l border-t border-white/[0.07] bg-[color-mix(in_srgb,var(--cosmos-bg)_72%,transparent)] shadow-[0_18px_70px_rgba(0,0,0,0.32)] backdrop-blur-[28px]"
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
