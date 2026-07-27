import { useCallback, useEffect, useRef, useState } from "react";
import { ipc, type GodotStatus } from "@/ipc/types";

/**
 * Live engine status.
 *
 * Seeded with one fetch, then kept current by the main process's
 * `godot:status-changed` broadcast rather than polling — engine state changes are
 * events (started, exited, bridge came up), and a poll would either lag them or
 * spend a request per second doing nothing.
 */
export function useGodotStatus(): {
  status: GodotStatus | null;
  refresh: () => Promise<void>;
} {
  const [status, setStatus] = useState<GodotStatus | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await ipc.godot.status(undefined));
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return ipc.events.godot.onStatusChanged((next) => setStatus(next));
  }, [refresh]);

  return { status, refresh };
}

export interface ViewportFrame {
  dataUrl: string | null;
  width: number | null;
  height: number | null;
  error: string | null;
}

/**
 * Streams the running game's viewport as PNG frames.
 *
 * Screenshot-polling rather than a real video pipe. Godot has no frame-streaming
 * API a host process can attach to, and the alternative — reparenting the engine's
 * OS window into the Electron window — is exactly what OrionAndroid found
 * crashes the engine process. Screenshots are honest about what they are: a
 * preview you can inspect and click, not a 60 fps mirror.
 *
 * `intervalMs` defaults to 500 (2 fps), which is enough to see what a scene looks
 * like and to watch a stepped animation, while leaving the engine's frame budget
 * alone. The poll stops entirely when the engine isn't running or the tab isn't
 * visible.
 */
export function useGodotViewport(params: {
  enabled: boolean;
  intervalMs?: number;
}): {
  frame: ViewportFrame | null;
  capture: () => Promise<void>;
  busy: boolean;
} {
  const { enabled, intervalMs = 500 } = params;
  const [frame, setFrame] = useState<ViewportFrame | null>(null);
  const [busy, setBusy] = useState(false);
  // Guards against overlapping captures: a slow engine frame would otherwise
  // queue requests faster than it answers them.
  const inFlight = useRef(false);

  const capture = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const res = await ipc.godot.viewport(undefined);
      setFrame({
        dataUrl: res.dataUrl,
        width: res.width,
        height: res.height,
        error: res.error,
      });
    } catch (err) {
      setFrame({
        dataUrl: null,
        width: null,
        height: null,
        error: (err as Error).message,
      });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setFrame(null);
      return;
    }
    void capture();
    let timer: number | null = window.setInterval(() => {
      if (document.hidden) return;
      void capture();
    }, intervalMs);
    return () => {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
    };
  }, [enabled, intervalMs, capture]);

  return { frame, capture, busy };
}

export interface SceneNode {
  name: string;
  path: string;
  class: string;
  script: string | null;
  visible: boolean | null;
  transform?: Record<string, unknown>;
  children?: SceneNode[];
  child_count?: number;
}

/** Fetches the live scene tree. Manual refresh — the tree only changes on edits. */
export function useSceneTree(enabled: boolean): {
  root: SceneNode | null;
  error: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
} {
  const [root, setRoot] = useState<SceneNode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await ipc.godot.call({
        action: "scene_tree",
        params: { depth: 12 },
      });
      if (res.ok === true) {
        setRoot(res.tree as SceneNode);
        setError(null);
      } else {
        setRoot(null);
        setError((res.error as string) ?? "scene_tree failed");
      }
    } catch (err) {
      setRoot(null);
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setRoot(null);
      setError(null);
      return;
    }
    void refresh();
  }, [enabled, refresh]);

  return { root, error, loading, refresh };
}

export interface NodeProperty {
  name: string;
  type: string;
  value: unknown;
}

/** Fetches one node's properties for the inspector. */
export function useNodeProperties(nodePath: string | null): {
  properties: NodeProperty[];
  error: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
} {
  const [properties, setProperties] = useState<NodeProperty[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!nodePath) {
      setProperties([]);
      return;
    }
    setLoading(true);
    try {
      const res = await ipc.godot.call({
        action: "list_properties",
        params: { path: nodePath },
      });
      if (res.ok === true) {
        setProperties((res.properties as NodeProperty[]) ?? []);
        setError(null);
      } else {
        setProperties([]);
        setError((res.error as string) ?? "list_properties failed");
      }
    } catch (err) {
      setProperties([]);
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [nodePath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { properties, error, loading, refresh };
}
