import { useAtom } from "jotai";
import { useRouterState } from "@tanstack/react-router";
import { FolderKanban, MessagesSquare, PanelLeftClose } from "lucide-react";
import { atomWithStorage } from "jotai/utils";
import { cn } from "@/lib/utils";
import { ChatList } from "@/components/ChatList";
import { AppList } from "@/components/AppList";
import { LIconButton, Segmented } from "@/components/liquid";
import { spaceForPath } from "./spaces";

/**
 * Which list the Build space's context panel is showing. Persisted because it's
 * a working preference, not transient view state — an IDE that forgets whether
 * you were browsing sessions or projects makes you re-pick on every launch.
 */
const contextTabAtom = atomWithStorage<"sessions" | "projects">(
  "orion.contextPanel.tab",
  "sessions",
);

/** Panel open/closed, also persisted for the same reason. */
export const contextPanelOpenAtom = atomWithStorage<boolean>(
  "orion.contextPanel.open",
  true,
);

const TABS = [
  { value: "sessions" as const, label: "Sessions", icon: <MessagesSquare /> },
  { value: "projects" as const, label: "Projects", icon: <FolderKanban /> },
];

/**
 * The Build space's context panel: your sessions and your projects, always in
 * the same place.
 *
 * The old secondary panel was bound to nav *items* — it appeared for four of
 * sixteen destinations and vanished for the rest, so the shell's width changed
 * unpredictably as you navigated and you could never rely on the list being
 * there. This one is bound to a *space*: it exists throughout Build and nowhere
 * else, which is a rule the user can actually learn.
 */
export function ContextPanel() {
  const { location } = useRouterState();
  const space = spaceForPath(location.pathname);
  const [open, setOpen] = useAtom(contextPanelOpenAtom);
  const [tab, setTab] = useAtom(contextTabAtom);

  const applies = space?.id === "build";
  const visible = applies && open;

  return (
    <aside
      aria-label="Sessions and projects"
      aria-hidden={!visible}
      className={cn(
        "z-30 mt-[var(--app-titlebar-height)] h-screenish shrink-0 overflow-hidden",
        "transition-[width,opacity] duration-[240ms] ease-[var(--ease-macos)]",
        visible
          ? "w-[var(--shell-panel-width)] border-l border-t border-white/[0.07] bg-[color-mix(in_srgb,var(--cosmos-deep)_72%,transparent)] opacity-100 backdrop-blur-[24px]"
          : "pointer-events-none w-0 opacity-0",
      )}
    >
      <div className="flex h-full w-[var(--shell-panel-width)] flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-white/[0.07] px-3 py-2.5">
          <Segmented
            aria-label="Context panel view"
            size="compact"
            options={TABS}
            value={tab}
            onChange={setTab}
            className="min-w-0 flex-1"
            stretch
          />
          <LIconButton
            label="Hide panel"
            size="compact"
            onClick={() => setOpen(false)}
          >
            <PanelLeftClose />
          </LIconButton>
        </div>

        {/* Both lists stay mounted so switching tabs doesn't refetch or lose
            scroll position; `show` gates visibility, matching how these
            components were already written. */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ChatList show={visible && tab === "sessions"} />
          <AppList show={visible && tab === "projects"} />
        </div>
      </div>
    </aside>
  );
}
