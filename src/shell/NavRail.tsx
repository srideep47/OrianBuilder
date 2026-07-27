import { useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { HelpCircle, Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import { HelpDialog } from "@/components/HelpDialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { SPACES, spaceForPath, type Space } from "./spaces";

/**
 * The primary navigation: one item per space, in a fixed rail.
 *
 * Replaces a sidebar that had four primary items, a twelve-item "Tools" popover
 * and a two-item footer — three tiers of weight for what was really one flat
 * list. Everything now sits at one level because there are few enough of them,
 * and the second level moved into each space's own header where it belongs.
 *
 * Every item shows its icon *and* its label permanently, matching Android's
 * `LiquidTabBar`: an icon-only rail forces either a hover-wait or memorisation
 * before you can navigate, and there is plenty of room for five words.
 */
export function NavRail() {
  const { location } = useRouterState();
  const pathname = location.pathname;
  const activeSpace = spaceForPath(pathname);
  const [helpOpen, setHelpOpen] = useState(false);
  const settingsActive = pathname.startsWith("/settings");

  return (
    <nav
      aria-label="Primary"
      className={cn(
        "z-40 flex h-screenish w-[var(--shell-rail-width)] shrink-0 flex-col",
        "mt-[var(--app-titlebar-height)] px-2 pb-2 pt-2.5",
      )}
    >
      <ul className="flex min-h-0 flex-1 flex-col gap-1.5">
        {SPACES.map((space) => (
          <li key={space.id}>
            <RailItem
              space={space}
              active={activeSpace?.id === space.id && !settingsActive}
            />
          </li>
        ))}
      </ul>

      <ul className="flex shrink-0 flex-col gap-1.5">
        <li>
          <Link
            to="/settings"
            aria-current={settingsActive ? "page" : undefined}
            className={cn(railItemClass, settingsActive && railActiveClass)}
          >
            <Settings
              className="h-[18px] w-[18px] shrink-0"
              strokeWidth={1.9}
            />
            <span className={railLabelClass}>Settings</span>
          </Link>
        </li>
        <li>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  onClick={() => setHelpOpen(true)}
                  className={railItemClass}
                />
              }
            >
              <HelpCircle
                className="h-[18px] w-[18px] shrink-0"
                strokeWidth={1.9}
              />
              <span className={railLabelClass}>Help</span>
            </TooltipTrigger>
            <TooltipContent side="right">
              Keyboard shortcuts and docs
            </TooltipContent>
          </Tooltip>
          <HelpDialog isOpen={helpOpen} onClose={() => setHelpOpen(false)} />
        </li>
      </ul>
    </nav>
  );
}

/**
 * 56px tall so icon + label fit without either cramping, and the whole rail of
 * seven items fits any window height without scrolling — the old rail scrolled
 * its own nav, which meant destinations could be hidden below a fold.
 */
const railItemClass = cn(
  "group relative flex h-14 w-full cursor-pointer flex-col items-center justify-center gap-1",
  "rounded-[16px] border border-transparent text-muted-foreground outline-none",
  "transition-colors duration-[120ms] ease-[var(--ease-macos-control)]",
  "hover:border-white/[0.08] hover:bg-white/[0.055] hover:text-foreground",
  "focus-visible:ring-2 focus-visible:ring-primary/45",
);

const railActiveClass = cn(
  "border-primary/35 bg-gradient-to-b from-primary/[0.22] to-primary/[0.07] text-primary",
  "shadow-[inset_0_1px_0_rgba(255,255,255,0.1)]",
);

const railLabelClass =
  "w-full truncate px-1 text-center text-[10px] font-medium leading-none tracking-[0.01em]";

function RailItem({ space, active }: { space: Space; active: boolean }) {
  const Icon = space.icon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Link
            to={space.to}
            aria-current={active ? "page" : undefined}
            className={cn(railItemClass, active && railActiveClass)}
          />
        }
      >
        {/* The active marker is a rail-edge bar rather than a colour change
            alone, so the current space is identifiable without relying on
            colour perception. */}
        <span
          className={cn(
            "absolute left-0 top-1/2 h-6 w-[3px] -translate-y-1/2 rounded-r-full bg-primary",
            "transition-opacity duration-[120ms]",
            active ? "opacity-100" : "opacity-0",
          )}
        />
        <Icon className="h-[18px] w-[18px] shrink-0" strokeWidth={1.9} />
        <span className={railLabelClass}>{space.label}</span>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-[260px]">
        <span className="font-medium">{space.label}</span>
        <span className="mt-0.5 block text-xs opacity-80">{space.purpose}</span>
      </TooltipContent>
    </Tooltip>
  );
}
