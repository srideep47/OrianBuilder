import {
  Home,
  Inbox,
  Settings,
  HelpCircle,
  Store,
  BookOpen,
  Cpu,
  HardDrive,
  Database,
  Sparkles,
} from "lucide-react";
import { Link, useRouterState } from "@tanstack/react-router";
import { useState, useRef, useEffect, useCallback } from "react";
import { useAtom } from "jotai";
import { dropdownOpenAtom } from "@/atoms/uiAtoms";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { ChatList } from "./ChatList";
import { AppList } from "./AppList";
import { HelpDialog } from "./HelpDialog";
import { SettingsList } from "./SettingsList";
import { LibraryList } from "./LibraryList";

const items = [
  { title: "Apps", to: "/", icon: Home, hasPanel: true },
  { title: "Chat", to: "/chat", icon: Inbox, hasPanel: true },
  { title: "Engine", to: "/inference", icon: Cpu, hasPanel: false },
  { title: "Models", to: "/models", icon: Database, hasPanel: false },
  { title: "Marketplace", to: "/marketplace", icon: HardDrive, hasPanel: false },
  { title: "Media AI", to: "/mediaai", icon: Sparkles, hasPanel: false },
  { title: "Settings", to: "/settings", icon: Settings, hasPanel: true },
  { title: "Library", to: "/library", icon: BookOpen, hasPanel: true },
  { title: "Hub", to: "/hub", icon: Store, hasPanel: false },
] as const;

type PanelItem = "Apps" | "Chat" | "Settings" | "Library" | null;

// Renders a nav label, splitting two-word titles onto two lines for a compact look
function IconLabel({ title }: { title: string }) {
  const words = title.split(" ");
  if (words.length > 1) {
    return (
      <span className="flex flex-col items-center leading-[1.1] text-[10px] text-center">
        {words.map((w) => (
          <span key={w}>{w}</span>
        ))}
      </span>
    );
  }
  return (
    <span className="text-[10px] leading-tight text-center w-full">{title}</span>
  );
}

export function AppSidebar() {
  const [panelItem, setPanelItem] = useState<PanelItem>(null);
  const [isHelpDialogOpen, setIsHelpDialogOpen] = useState(false);
  const [isDropdownOpen] = useAtom(dropdownOpenAtom);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Ref so the timer callback always reads the latest value without stale closure
  const isDropdownOpenRef = useRef(isDropdownOpen);

  const { location } = useRouterState();
  const pathname = location.pathname;

  useEffect(() => {
    isDropdownOpenRef.current = isDropdownOpen;
  }, [isDropdownOpen]);

  // Close the panel whenever the user navigates to a new route
  useEffect(() => {
    if (panelItem !== null) setPanelItem(null);
  }, [pathname]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clean up any pending timer on unmount
  useEffect(() => {
    return () => {
      if (clearTimer.current) clearTimeout(clearTimer.current);
    };
  }, []);

  const scheduleClear = useCallback(() => {
    clearTimer.current = setTimeout(() => {
      if (!isDropdownOpenRef.current) setPanelItem(null);
    }, 120);
  }, []);

  const cancelClear = useCallback(() => {
    if (clearTimer.current) {
      clearTimeout(clearTimer.current);
      clearTimer.current = null;
    }
  }, []);

  const handleIconHover = useCallback(
    (title: string) => {
      cancelClear();
      const item = items.find((i) => i.title === title);
      setPanelItem(item?.hasPanel ? (title as PanelItem) : null);
    },
    [cancelClear],
  );

  return (
    <>
      <Sidebar
        collapsible="icon"
        onMouseLeave={scheduleClear}
        onMouseEnter={cancelClear}
      >
        <SidebarContent className="overflow-hidden">
          {/* Push content below the TitleBar (44px) plus a small visual gap */}
          <div className="mt-14">
            <AppIcons onHover={handleIconHover} pathname={pathname} />
          </div>
        </SidebarContent>

        <SidebarFooter className="pb-4">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                size="sm"
                tooltip="Help"
                className="flex flex-col items-center justify-center gap-1 w-full h-[62px] mb-1 rounded-xl font-medium"
                onClick={() => setIsHelpDialogOpen(true)}
              >
                <HelpCircle className="h-[18px] w-[18px] shrink-0" />
                <span className="text-[10px] leading-tight text-center">
                  Help
                </span>
              </SidebarMenuButton>
              <HelpDialog
                isOpen={isHelpDialogOpen}
                onClose={() => setIsHelpDialogOpen(false)}
              />
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>

      {/* Semi-transparent backdrop — dims content so the panel stands apart */}
      {panelItem && (
        <div
          className="fixed inset-0 z-30 bg-black/40 backdrop-blur-[2px]"
          style={{ left: "5rem" }}
          onClick={() => setPanelItem(null)}
        />
      )}

      {/* Floating sub-panel — flush with sidebar, separated by border + deep shadow */}
      {panelItem && (
        <div
          className="fixed left-[5rem] top-11 bottom-4 w-[272px] bg-sidebar backdrop-blur-2xl border-y border-r border-sidebar-border rounded-r-xl shadow-[4px_0_32px_rgba(0,0,0,0.6)] overflow-hidden z-40"
          onMouseEnter={cancelClear}
          onMouseLeave={() => {
            if (!isDropdownOpenRef.current) setPanelItem(null);
          }}
        >
          <AppList show={panelItem === "Apps"} />
          <ChatList show={panelItem === "Chat"} />
          <SettingsList show={panelItem === "Settings"} />
          <LibraryList show={panelItem === "Library"} />
        </div>
      )}
    </>
  );
}

function AppIcons({
  onHover,
  pathname,
}: {
  onHover: (title: string) => void;
  pathname: string;
}) {
  return (
    <SidebarGroup className="px-1 py-0">
      <SidebarGroupContent>
        <SidebarMenu className="gap-0">
          {items.map((item) => {
            const isActive =
              (item.to === "/" && pathname === "/") ||
              (item.to !== "/" && pathname.startsWith(item.to));

            return (
              <SidebarMenuItem key={item.title}>
                <SidebarMenuButton
                  as={Link}
                  to={item.to}
                  size="sm"
                  tooltip={item.hasPanel ? undefined : item.title}
                  isActive={isActive}
                  className="flex flex-col items-center justify-center gap-1 w-full h-[62px] mb-0.5 rounded-xl font-medium"
                  onMouseEnter={() => onHover(item.title)}
                >
                  <item.icon className="h-[18px] w-[18px] shrink-0" />
                  <IconLabel title={item.title} />
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
