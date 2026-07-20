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
  Grid3X3,
  Layers3,
  ServerCog,
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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

const primaryItems = [
  { title: "Orion", to: "/", icon: Orbit, hasPanel: false },
  {
    title: "Chat",
    label: "Sessions",
    to: "/chat",
    icon: Inbox,
    hasPanel: true,
  },
  { title: "Apps", label: "Projects", to: "/apps", icon: Home, hasPanel: true },
  { title: "Library", to: "/library", icon: BookOpen, hasPanel: true },
] as const;

const secondaryItems = [
  { title: "Control Center", to: "/orion", icon: Orbit, hasPanel: false },
  { title: "Media Studio", to: "/mediaai", icon: Sparkles, hasPanel: false },
  {
    title: "Media Queue",
    to: "/library/media-queue",
    icon: Layers3,
    hasPanel: false,
  },
  {
    title: "Open Design",
    to: "/design-studio",
    icon: Palette,
    hasPanel: false,
  },
  { title: "Engine", to: "/inference", icon: Cpu, hasPanel: false },
  { title: "Models", to: "/models", icon: Database, hasPanel: false },
  {
    title: "Marketplace",
    to: "/marketplace",
    icon: HardDrive,
    hasPanel: false,
  },
  { title: "Network", to: "/network", icon: Network, hasPanel: false },
  { title: "Hub", to: "/hub", icon: Store, hasPanel: false },
  {
    title: "Daily AI Digest",
    to: "/dailyaidigest",
    icon: Newspaper,
    hasPanel: false,
  },
  { title: "Watchdog", to: "/watchdog", icon: Eye, hasPanel: false },
  {
    title: "Media Runtime",
    to: "/media-runtime",
    icon: ServerCog,
    hasPanel: false,
  },
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
      <span className="flex flex-col items-center text-center text-[10px] leading-[1.08] tracking-[0.01em]">
        {lines.map((line) => (
          <span key={line}>{line}</span>
        ))}
      </span>
    );
  }
  return (
    <span className="w-full text-center text-[10px] leading-tight tracking-[0.01em]">
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
    <Sidebar collapsible="offcanvas">
      <SidebarContent className="overflow-y-auto overflow-x-hidden group-data-[collapsible=icon]:overflow-y-auto group-data-[collapsible=icon]:overflow-x-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="mt-[var(--app-titlebar-height)] flex min-h-0 flex-1 flex-col">
          <AppIcons
            onIconClick={handleIconClick}
            pathname={pathname}
            activePanel={panelItem}
          />
        </div>
      </SidebarContent>

      <SidebarFooter className="pb-2">
        <SidebarMenu className="gap-1">
          <SidebarMenuItem>
            <SidebarMenuButton
              as={Link}
              to="/settings"
              size="sm"
              tooltip="Settings"
              isActive={pathname.startsWith("/settings")}
              className="flex h-[44px] w-full flex-col items-center justify-center gap-0.5 rounded-[13px] font-medium"
              onClick={() => handleIconClick("Settings", true)}
            >
              <Settings className="h-[17px] w-[17px] shrink-0" />
              <span className="text-center text-[9px] leading-tight">
                Settings
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              size="sm"
              tooltip="Help"
              className="mb-0 flex h-[40px] w-full flex-col items-center justify-center gap-0.5 rounded-[13px] font-medium"
              onClick={() => setIsHelpDialogOpen(true)}
            >
              <HelpCircle className="h-[18px] w-[18px] shrink-0" />
              <span className="text-center text-[9px] leading-tight">Help</span>
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
  const [moreOpen, setMoreOpen] = useState(false);
  const isMoreActive = secondaryItems.some((item) =>
    pathname.startsWith(item.to),
  );

  return (
    <SidebarGroup className="flex min-h-0 flex-1 flex-col px-2 py-1.5">
      <SidebarGroupContent className="flex min-h-0 flex-1 flex-col">
        <SidebarMenu className="flex flex-col justify-start gap-1.5">
          {primaryItems.map((item) => {
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
                  className="flex h-[48px] w-full shrink-0 flex-col items-center justify-center gap-1 rounded-[14px] font-medium"
                  onClick={() => onIconClick(item.title, item.hasPanel)}
                >
                  <item.icon
                    className="h-[18px] w-[18px] shrink-0"
                    strokeWidth={1.85}
                  />
                  <IconLabel
                    title={("label" in item && item.label) || item.title}
                  />
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
          <SidebarMenuItem>
            <Popover open={moreOpen} onOpenChange={setMoreOpen}>
              <PopoverTrigger
                aria-label="More Orion tools"
                className={
                  "flex h-[48px] w-full shrink-0 flex-col items-center justify-center gap-1 rounded-[14px] font-medium transition-colors " +
                  (isMoreActive
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground")
                }
              >
                <Grid3X3 className="h-[18px] w-[18px] shrink-0" />
                <IconLabel title="Tools" />
              </PopoverTrigger>
              <PopoverContent
                side="right"
                align="start"
                sideOffset={10}
                className="max-h-[calc(100vh-96px)] w-80 overflow-y-auto border-border bg-popover/96 p-2 backdrop-blur-2xl"
              >
                <div className="px-2 pb-2 pt-1">
                  <div className="text-sm font-semibold">Orion tools</div>
                  <div className="text-xs text-muted-foreground">
                    Specialist workspaces and runtime management.
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-1">
                  {secondaryItems.map((item) => {
                    const active = pathname.startsWith(item.to);
                    return (
                      <Link
                        key={item.title}
                        to={item.to}
                        onClick={() => {
                          onIconClick(item.title, item.hasPanel);
                          setMoreOpen(false);
                        }}
                        className={
                          "flex min-h-14 items-center gap-2 rounded-xl px-3 py-2 text-sm transition-colors " +
                          (active
                            ? "bg-primary/15 text-primary"
                            : "text-foreground/75 hover:bg-muted/60 hover:text-foreground")
                        }
                      >
                        <item.icon className="h-4 w-4 shrink-0" />
                        <span className="leading-tight">{item.title}</span>
                      </Link>
                    );
                  })}
                </div>
              </PopoverContent>
            </Popover>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
