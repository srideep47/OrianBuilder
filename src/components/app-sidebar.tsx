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
  Newspaper,
  Network,
  Eye,
  Palette,
} from "lucide-react";
import { Link, useRouterState } from "@tanstack/react-router";
import { useState, useCallback } from "react";
import { useAtom, useSetAtom } from "jotai";
import {
  sidebarPanelAtom,
  isNetworkPeerListOpenAtom,
  type SidebarPanelItem,
} from "@/atoms/uiAtoms";

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
import { HelpDialog } from "./HelpDialog";

const items = [
  { title: "Apps", to: "/", icon: Home, hasPanel: true },
  { title: "Chat", to: "/chat", icon: Inbox, hasPanel: true },
  { title: "Engine", to: "/inference", icon: Cpu, hasPanel: false },
  { title: "Models", to: "/models", icon: Database, hasPanel: false },
  {
    title: "Marketplace",
    to: "/marketplace",
    icon: HardDrive,
    hasPanel: false,
  },
  { title: "Media AI", to: "/mediaai", icon: Sparkles, hasPanel: false },
  {
    title: "Daily AI Digest",
    to: "/dailyaidigest",
    icon: Newspaper,
    hasPanel: false,
  },
  { title: "Design", to: "/design-studio", icon: Palette, hasPanel: false },
  { title: "Network", to: "/network", icon: Network, hasPanel: false },
  { title: "Watchdog", to: "/watchdog", icon: Eye, hasPanel: false },
  { title: "Settings", to: "/settings", icon: Settings, hasPanel: true },
  { title: "Library", to: "/library", icon: BookOpen, hasPanel: true },
  { title: "Hub", to: "/hub", icon: Store, hasPanel: false },
] as const;

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
    <span className="text-[10px] leading-tight text-center w-full">
      {title}
    </span>
  );
}

export function AppSidebar() {
  const [panelItem, setPanelItem] = useAtom(sidebarPanelAtom);
  const setIsNetworkPeerListOpen = useSetAtom(isNetworkPeerListOpenAtom);
  const [isHelpDialogOpen, setIsHelpDialogOpen] = useState(false);

  const { location } = useRouterState();
  const pathname = location.pathname;

  const handleIconClick = useCallback(
    (title: string, hasPanel: boolean) => {
      if (title === "Network") {
        // Clicking Network in the tools bar toggles the in-page peer list
        setIsNetworkPeerListOpen((prev) => !prev);
      }
      if (!hasPanel) {
        setPanelItem(null);
      } else {
        setPanelItem((prev) =>
          prev === title ? null : (title as SidebarPanelItem),
        );
      }
    },
    [setPanelItem, setIsNetworkPeerListOpen],
  );

  return (
    <Sidebar collapsible="icon">
      <SidebarContent className="overflow-hidden">
        <div className="mt-11">
          <AppIcons
            onIconClick={handleIconClick}
            pathname={pathname}
            activePanel={panelItem}
          />
        </div>
      </SidebarContent>

      <SidebarFooter className="pb-4">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="sm"
              tooltip="Help"
              className="flex flex-col items-center justify-center gap-0.5 w-full h-[62px] mb-1 rounded-xl font-medium"
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
  );
}

function AppIcons({
  onIconClick,
  pathname,
  activePanel,
}: {
  onIconClick: (title: string, hasPanel: boolean) => void;
  pathname: string;
  activePanel: SidebarPanelItem;
}) {
  return (
    <SidebarGroup className="px-1 py-0">
      <SidebarGroupContent>
        <SidebarMenu className="gap-0">
          {items.map((item) => {
            const isActive =
              (item.to === "/" && pathname === "/") ||
              (item.to !== "/" && pathname.startsWith(item.to));

            const isPanelActive = activePanel === item.title;

            return (
              <SidebarMenuItem key={item.title}>
                <SidebarMenuButton
                  as={Link}
                  to={item.to}
                  size="sm"
                  tooltip={item.title}
                  isActive={isActive || isPanelActive}
                  className="flex flex-col items-center justify-center gap-0.5 w-full h-[62px] mb-0.5 rounded-xl font-medium"
                  onClick={() => onIconClick(item.title, item.hasPanel)}
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
