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
  Orbit,
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
  { title: "Orion", to: "/orion", icon: Orbit, hasPanel: false },
  { title: "Chat", to: "/chat", icon: Inbox, hasPanel: true },
  { title: "Engine", to: "/inference", icon: Cpu, hasPanel: false },
  { title: "Models", to: "/models", icon: Database, hasPanel: false },
  {
    title: "Marketplace",
    to: "/marketplace",
    icon: HardDrive,
    hasPanel: false,
  },
  { title: "Gen Assets", to: "/mediaai", icon: Sparkles, hasPanel: true },
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

// Renders a nav label, capped at two lines so every item stays compact enough
// for the full list to fit without scrolling. Three-word titles (e.g. "Daily AI
// Digest") keep the first word on line one and the rest on line two.
function IconLabel({ title }: { title: string }) {
  const words = title.split(" ");
  if (words.length > 1) {
    const lines =
      words.length > 2 ? [words[0], words.slice(1).join(" ")] : words;
    return (
      <span className="flex flex-col items-center leading-[1.05] text-[9px] text-center">
        {lines.map((line) => (
          <span key={line}>{line}</span>
        ))}
      </span>
    );
  }
  return (
    <span className="text-[9px] leading-tight text-center w-full">{title}</span>
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
      <SidebarContent className="overflow-y-auto overflow-x-hidden group-data-[collapsible=icon]:overflow-y-auto group-data-[collapsible=icon]:overflow-x-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="mt-11 flex flex-1 flex-col min-h-0">
          <AppIcons
            onIconClick={handleIconClick}
            pathname={pathname}
            activePanel={panelItem}
          />
        </div>
      </SidebarContent>

      <SidebarFooter className="pb-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="sm"
              tooltip="Help"
              className="flex flex-col items-center justify-center gap-0.5 w-full h-[40px] mb-0 rounded-lg font-medium"
              onClick={() => setIsHelpDialogOpen(true)}
            >
              <HelpCircle className="h-4 w-4 shrink-0" />
              <span className="text-[9px] leading-tight text-center">Help</span>
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
    <SidebarGroup className="px-1 py-0 flex flex-1 flex-col min-h-0">
      <SidebarGroupContent className="flex flex-1 flex-col min-h-0">
        <SidebarMenu className="flex flex-1 flex-col justify-evenly gap-0">
          {items.map((item) => {
            const isActive =
              (item.to === "/" && pathname === "/") ||
              (item.to !== "/" && pathname.startsWith(item.to)) ||
              (item.title === "Gen Assets" && pathname.startsWith("/3dassets"));

            const isPanelActive = activePanel === item.title;

            return (
              <SidebarMenuItem key={item.title}>
                <SidebarMenuButton
                  as={Link}
                  to={item.to}
                  size="sm"
                  tooltip={item.title}
                  isActive={isActive || isPanelActive}
                  className="flex flex-col items-center justify-center gap-0.5 w-full h-[40px] shrink-0 rounded-lg font-medium"
                  onClick={() => onIconClick(item.title, item.hasPanel)}
                >
                  <item.icon className="h-4 w-4 shrink-0" />
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
