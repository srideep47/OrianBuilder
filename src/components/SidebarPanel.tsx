import { useAtomValue } from "jotai";
import { sidebarPanelAtom } from "@/atoms/uiAtoms";
import { ChatList } from "./ChatList";
import { AppList } from "./AppList";
import { SettingsList } from "./SettingsList";
import { LibraryList } from "./LibraryList";
import { cn } from "@/lib/utils";

export function SidebarPanel() {
  const panelItem = useAtomValue(sidebarPanelAtom);

  return (
    <div
      data-panel="sidebar-panel"
      className={cn(
        "flex-shrink-0 h-screenish mt-11 mb-2 sm:mb-4 overflow-hidden",
        "transition-[width] duration-200 ease-linear",
        panelItem
          ? "w-[272px] border-y border-r border-white/[0.06] bg-[oklch(0.11_0.018_292)]"
          : "w-0",
      )}
    >
      <div className="w-[272px] h-full">
        <AppList show={panelItem === "Apps"} />
        <ChatList show={panelItem === "Chat"} />
        <SettingsList show={panelItem === "Settings"} />
        <LibraryList show={panelItem === "Library"} />
      </div>
    </div>
  );
}
