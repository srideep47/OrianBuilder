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
        "h-screenish mt-[var(--app-titlebar-height)] mb-2 overflow-hidden rounded-r-[24px] sm:mb-3",
        "transition-[width,opacity,transform] duration-300 ease-[var(--ease-macos)] will-change-[width,opacity,transform]",
        visible
          ? "liquid-glass-thick w-[288px] translate-x-0 opacity-100 border-y border-r border-black/[0.06] bg-card/78 shadow-[0_22px_60px_rgba(15,23,42,0.08)] dark:border-white/[0.08] dark:bg-card/70 dark:shadow-[0_22px_60px_rgba(0,0,0,0.34)]"
          : "w-0 -translate-x-3 opacity-0",
      )}
    >
      <div className="h-full w-[288px]">
        <AppList show={visible && panelItem === "Apps"} />
        <ChatList show={visible && panelItem === "Chat"} />
        <SettingsList show={visible && panelItem === "Settings"} />
        <LibraryList show={visible && panelItem === "Library"} />
        <GenAssetsList show={visible && panelItem === "Gen Assets"} />
      </div>
    </div>
  );
}
