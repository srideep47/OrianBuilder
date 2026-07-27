import { useCallback, useEffect, useState } from "react";
import { useAtomValue } from "jotai";
import { useNavigate } from "@tanstack/react-router";
import {
  CircleStop,
  ExternalLink,
  Gamepad2,
  Monitor,
  SquareTerminal,
} from "lucide-react";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import { ipc } from "@/ipc/types";
import type { GodotProject } from "@/ipc/types";
import { showError } from "@/lib/toast";
import { EmptyState, LBadge, LButton, LoadingState } from "@/components/liquid";
import { GodotViewport } from "@/components/game/GodotViewport";
import { GodotSceneTree } from "@/components/game/GodotSceneTree";
import { useGodotStatus, useSceneTree } from "@/components/game/useGodot";

/**
 * The Game dock panel: watch the engine while the agent builds the game.
 *
 * Deliberately a reduced view — viewport plus scene tree, no inspector. The dock
 * is half a window at best, and the point here is *observation while chatting*:
 * seeing that the crate the agent just generated actually landed on the floor.
 * Real editing work belongs in the Game space, which this links to rather than
 * duplicating.
 */
export function GamePanel() {
  const selectedAppId = useAtomValue(selectedAppIdAtom);
  const navigate = useNavigate();
  const { status, refresh } = useGodotStatus();
  const [project, setProject] = useState<GodotProject | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [paused, setPaused] = useState(false);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);

  const running = status?.state === "running" && status.mode !== "editor";
  const bridgeReady = Boolean(status?.bridgeReady);
  const tree = useSceneTree(running && bridgeReady);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (selectedAppId == null) {
        setProject(null);
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        const found = await ipc.godot.findProject({ appId: selectedAppId });
        if (!cancelled) setProject(found);
      } catch {
        if (!cancelled) setProject(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedAppId]);

  const launch = useCallback(
    async (mode: "windowed" | "headless") => {
      if (selectedAppId == null) return;
      setBusy(true);
      try {
        await ipc.godot.start({ appId: selectedAppId, mode });
        setPaused(false);
        await refresh();
      } catch (err) {
        showError(String(err));
      } finally {
        setBusy(false);
      }
    },
    [selectedAppId, refresh],
  );

  const stop = useCallback(async () => {
    setBusy(true);
    try {
      await ipc.godot.stop(undefined);
      setSelectedNode(null);
      await refresh();
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  if (loading) return <LoadingState label="the Godot project" />;

  if (selectedAppId == null) {
    return (
      <EmptyState
        icon={<Gamepad2 />}
        title="No project selected"
        description="Pick a project to see whether it has a game."
      />
    );
  }

  if (!project) {
    return (
      <EmptyState
        icon={<Gamepad2 />}
        title="No game in this project"
        description="Ask Orion to make one — “turn this into a 3D game” — or set it up by hand in the Game space."
        action={
          <LButton
            size="compact"
            tone="primary"
            icon={<ExternalLink />}
            onClick={() => void navigate({ to: "/game" })}
          >
            Open the Game space
          </LButton>
        }
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-2">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {running ? (
          <LButton
            size="compact"
            tone="destructive"
            icon={<CircleStop />}
            disabled={busy}
            onClick={() => void stop()}
          >
            Stop
          </LButton>
        ) : (
          <>
            <LButton
              size="compact"
              tone="primary"
              icon={<Monitor />}
              disabled={busy}
              onClick={() => void launch("windowed")}
            >
              Run
            </LButton>
            <LButton
              size="compact"
              icon={<SquareTerminal />}
              disabled={busy}
              onClick={() => void launch("headless")}
            >
              Headless
            </LButton>
          </>
        )}
        {running && (
          <LBadge tone={bridgeReady ? "success" : "warning"} dot>
            {bridgeReady ? project.name : "bridge not answering"}
          </LBadge>
        )}
        <LButton
          size="compact"
          tone="ghost"
          className="ml-auto"
          icon={<ExternalLink />}
          onClick={() => void navigate({ to: "/game" })}
        >
          Full workbench
        </LButton>
      </div>

      <div className="min-h-0 flex-1">
        <GodotViewport
          running={running && bridgeReady}
          paused={paused}
          onPausedChange={setPaused}
          className="h-full"
        />
      </div>

      {running && bridgeReady && (
        <div className="h-[180px] shrink-0">
          <GodotSceneTree
            root={tree.root}
            error={tree.error}
            loading={tree.loading}
            selected={selectedNode}
            onSelect={setSelectedNode}
            onRefresh={() => void tree.refresh()}
            className="h-full"
          />
        </div>
      )}
    </div>
  );
}
