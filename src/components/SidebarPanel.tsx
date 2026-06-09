import { useAtomValue } from "jotai";
import { sidebarPanelAtom } from "@/atoms/uiAtoms";
import { ChatList } from "./ChatList";
import { AppList } from "./AppList";
import { SettingsList } from "./SettingsList";
import { LibraryList } from "./LibraryList";
import { GenAssetsList } from "./GenAssetsList";
import { cn } from "@/lib/utils";
import { useSidebar } from "@/components/ui/sidebar";

export function SidebarPanel() {
  const panelItem = useAtomValue(sidebarPanelAtom);
  const { state } = useSidebar();
  // Hide the secondary panel whenever the icon rail is collapsed —
  // otherwise sub-lists (Apps / Chat / Library / etc.) stay visible after
  // the user closes the sidebar from the title bar.
  const visible = panelItem !== null && state === "expanded";

  return (
    <div
      data-panel="sidebar-panel"
      className={cn(
        "flex-shrink-0 h-screenish mt-11 mb-2 sm:mb-4 overflow-hidden",
        "transition-[width] duration-200 ease-linear",
        visible
          ? "w-[272px] border-y border-r border-white/[0.06] bg-[oklch(0.11_0.018_292)]"
          : "w-0",
      )}
    >
      <div className="w-[272px] h-full">
        <AppList show={visible && panelItem === "Apps"} />
        <ChatList show={visible && panelItem === "Chat"} />
        <SettingsList show={visible && panelItem === "Settings"} />
        <LibraryList show={visible && panelItem === "Library"} />
        <GenAssetsList show={visible && panelItem === "Gen Assets"} />
      </div>
    </div>
  );
}
