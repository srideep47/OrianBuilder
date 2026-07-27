import { useEffect, useState } from "react";
import { useAtom, useAtomValue } from "jotai";
import { useRouterState } from "@tanstack/react-router";
import { Minus, PanelLeftOpen, Square, X as XIcon } from "lucide-react";
// @ts-ignore — SVG import handled by the Vite asset pipeline.
import logo from "../../assets/logo.svg";
import { cn } from "@/lib/utils";
import { ipc } from "@/ipc/types";
import { useSettings } from "@/hooks/useSettings";
import { useSystemPlatform } from "@/hooks/useSystemPlatform";
import { useDeepLink } from "@/contexts/DeepLinkContext";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";
import { selectedChatIdAtom } from "@/atoms/chatAtoms";
import { ChatTabs } from "@/components/chat/ChatTabs";
import { NotificationsDrawer } from "@/components/network/NotificationsDrawer";
import { ComputeRoutingPopover } from "@/components/ComputeRoutingPopover";
import { OrianBuilderProSuccessDialog } from "@/components/OrianBuilderProSuccessDialog";
import { LIconButton } from "@/components/liquid";
import { spaceForPath } from "./spaces";
import { contextPanelOpenAtom } from "./ContextPanel";

/**
 * The window chrome.
 *
 * Cut down from the previous version, which carried a sidebar trigger, the
 * wordmark, an "App: <name>" pill, the chat tab strip, a compute popover, a
 * notifications bell, a runtime-actions wrench and the window buttons — nine
 * controls competing in 60px, several of which duplicated things the page below
 * already showed. What's left is what genuinely belongs to the *window* rather
 * than to a page:
 *
 *  - identity (logo);
 *  - the context-panel toggle, but only in the space that has one;
 *  - open sessions, which span pages;
 *  - compute routing and notifications, which are global and always-relevant;
 *  - the window buttons.
 *
 * The runtime-actions wrench moved into the Build workspace's dock header,
 * where the runtime it acts on actually lives — it did nothing on 15 of the 16
 * old destinations.
 */
export function TitleBar() {
  const platform = useSystemPlatform();
  const showWindowControls = platform !== null && platform !== "darwin";
  const selectedChatId = useAtomValue(selectedChatIdAtom);
  const { location } = useRouterState();
  const space = spaceForPath(location.pathname);
  const [panelOpen, setPanelOpen] = useAtom(contextPanelOpenAtom);
  const canTogglePanel = space?.id === "build";

  const { refreshSettings } = useSettings();
  const queryClient = useQueryClient();
  const { lastDeepLink, clearLastDeepLink } = useDeepLink();
  const [proDialogOpen, setProDialogOpen] = useState(false);

  useEffect(() => {
    if (lastDeepLink?.type !== "orianbuilder-pro-return") return;
    void (async () => {
      await refreshSettings();
      queryClient.invalidateQueries({ queryKey: queryKeys.userBudget.info });
      setProDialogOpen(true);
      clearLastDeepLink();
    })();
  }, [lastDeepLink?.timestamp]);

  return (
    <>
      <div
        className={cn(
          "app-region-drag absolute left-0 top-0 z-50 flex w-full items-center gap-2",
          "h-[var(--app-titlebar-height)] px-3 py-2",
          "border-b border-white/[0.07] bg-[color-mix(in_srgb,var(--cosmos-bg)_58%,transparent)]",
          "backdrop-blur-[40px] backdrop-saturate-[180%]",
        )}
      >
        {/* macOS puts its own traffic lights here; on Windows/Linux the space is
            ours, so only reserve it when we aren't drawing the buttons. */}
        <div className={showWindowControls ? "w-1" : "w-[68px] shrink-0"} />

        <img
          src={logo}
          alt="Orion"
          className="ml-0.5 h-6 w-6 shrink-0 select-none"
          draggable={false}
        />

        {canTogglePanel && !panelOpen && (
          <div className="no-app-region-drag shrink-0">
            <LIconButton
              label="Show sessions and projects"
              size="compact"
              onClick={() => setPanelOpen(true)}
            >
              <PanelLeftOpen />
            </LIconButton>
          </div>
        )}

        {/* Open sessions live in the window because they outlive any one page.
            Empty on non-Build spaces, where it collapses to nothing. */}
        <div className="no-app-region-drag min-w-0 flex-1 overflow-hidden">
          <ChatTabs selectedChatId={selectedChatId} />
        </div>

        <div className="no-app-region-drag flex shrink-0 items-center gap-1.5">
          <ComputeRoutingPopover />
          <NotificationsDrawer />
          {showWindowControls && <WindowControls />}
        </div>
      </div>

      <OrianBuilderProSuccessDialog
        isOpen={proDialogOpen}
        onClose={() => setProDialogOpen(false)}
      />
    </>
  );
}

/**
 * Windows/Linux window buttons. Grouped in one rounded shell rather than three
 * loose icons, and close is the only one that takes a colour — a destructive
 * hover state on minimise would be a lie.
 */
function WindowControls() {
  return (
    <div className="ml-1 flex h-8 overflow-hidden rounded-[12px] border border-white/[0.09] bg-white/[0.045]">
      <button
        type="button"
        aria-label="Minimize"
        onClick={() => ipc.system.minimizeWindow()}
        className="flex h-8 w-9 items-center justify-center text-foreground/70 transition-colors hover:bg-white/[0.09] hover:text-foreground"
      >
        <Minus size={14} strokeWidth={2} />
      </button>
      <button
        type="button"
        aria-label="Maximize"
        onClick={() => ipc.system.maximizeWindow()}
        className="flex h-8 w-9 items-center justify-center text-foreground/70 transition-colors hover:bg-white/[0.09] hover:text-foreground"
      >
        <Square size={11} strokeWidth={1.7} />
      </button>
      <button
        type="button"
        aria-label="Close"
        onClick={() => ipc.system.closeWindow()}
        className="flex h-8 w-9 items-center justify-center text-foreground/70 transition-colors hover:bg-[#ff453a] hover:text-white"
      >
        <XIcon size={14} strokeWidth={2} />
      </button>
    </div>
  );
}
