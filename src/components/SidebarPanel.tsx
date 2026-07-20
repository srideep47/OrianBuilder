import { useAtomValue } from "jotai";
import { sidebarPanelAtom } from "@/atoms/uiAtoms";
import { ChatList } from "./ChatList";
import { AppList } from "./AppList";
import { SettingsList } from "./SettingsList";
import { LibraryList } from "./LibraryList";
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
        "h-screenish mt-[var(--app-titlebar-height)] overflow-hidden",
        "transition-[width,opacity,transform] duration-300 ease-[var(--ease-macos)] will-change-[width,opacity,transform]",
        visible
          ? "w-[288px] translate-x-0 border-l border-t border-border/70 bg-card/82 opacity-100 shadow-[0_16px_50px_rgba(0,0,0,0.2)] backdrop-blur-xl"
          : "w-0 -translate-x-3 opacity-0",
      )}
    >
      <div className="h-full w-[288px]">
        <AppList show={visible && panelItem === "Apps"} />
        <ChatList show={visible && panelItem === "Chat"} />
        <SettingsList show={visible && panelItem === "Settings"} />
        <LibraryList show={visible && panelItem === "Library"} />
      </div>
    </div>
  );
}
