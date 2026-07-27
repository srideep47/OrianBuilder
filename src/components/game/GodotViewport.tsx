import { useCallback, useRef, useState } from "react";
import {
  Camera,
  Gamepad2,
  MousePointerClick,
  Pause,
  Play,
  SkipForward,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ipc } from "@/ipc/types";
import {
  Chip,
  EmptyState,
  LBadge,
  LIconButton,
  Panel,
} from "@/components/liquid";
import { useGodotViewport, type ViewportFrame } from "./useGodot";

/**
 * The live game view, plus the controls that make it interactive rather than a
 * picture: pause, single-frame step, click-to-position and keyboard forwarding.
 *
 * Frames arrive as PNG screenshots on a 2 fps poll (see `useGodotViewport` for
 * why that, and not a video pipe). That's deliberately visible in the UI — the
 * frame rate readout says "preview", so nobody mistakes a stuttering preview for
 * a stuttering game.
 */
export function GodotViewport({
  running,
  paused,
  onPausedChange,
  className,
}: {
  running: boolean;
  paused: boolean;
  onPausedChange: (paused: boolean) => void;
  className?: string;
}) {
  const [forwardInput, setForwardInput] = useState(false);
  const [fast, setFast] = useState(false);
  const { frame, capture, busy } = useGodotViewport({
    enabled: running,
    intervalMs: fast ? 200 : 500,
  });
  const imgRef = useRef<HTMLImageElement>(null);

  /**
   * Translates a click on the preview into a click in the game.
   *
   * The image is letterboxed inside its container, so the click has to be mapped
   * through the rendered rect rather than the element box — using the element box
   * puts every click in the wrong place on any non-matching aspect ratio.
   */
  const handleClick = useCallback(
    async (event: React.MouseEvent<HTMLImageElement>) => {
      if (!forwardInput || !frame?.width || !frame?.height) return;
      const img = imgRef.current;
      if (!img) return;
      const rect = img.getBoundingClientRect();
      const scale = Math.min(
        rect.width / frame.width,
        rect.height / frame.height,
      );
      const renderedW = frame.width * scale;
      const renderedH = frame.height * scale;
      const offsetX = (rect.width - renderedW) / 2;
      const offsetY = (rect.height - renderedH) / 2;
      const x = (event.clientX - rect.left - offsetX) / scale;
      const y = (event.clientY - rect.top - offsetY) / scale;
      if (x < 0 || y < 0 || x > frame.width || y > frame.height) return;

      const position = { x: Math.round(x), y: Math.round(y) };
      await ipc.godot.call({
        action: "simulate_input",
        params: { type: "mouse_motion", position, relative: { x: 0, y: 0 } },
      });
      await ipc.godot.call({
        action: "simulate_input",
        params: { type: "mouse_button", button: 1, pressed: true, position },
      });
      await ipc.godot.call({
        action: "simulate_input",
        params: { type: "mouse_button", button: 1, pressed: false, position },
      });
      void capture();
    },
    [forwardInput, frame, capture],
  );

  /** Forwards real keystrokes as engine input events. */
  const handleKey = useCallback(
    async (event: React.KeyboardEvent) => {
      if (!forwardInput) return;
      event.preventDefault();
      // Godot's physical keycodes follow the ASCII uppercase range for letters
      // and digits, which covers WASD, space and the arrows via their own codes.
      const map: Record<string, number> = {
        ArrowLeft: 4194319,
        ArrowRight: 4194321,
        ArrowUp: 4194320,
        ArrowDown: 4194322,
        Escape: 4194305,
        Enter: 4194309,
        " ": 32,
      };
      const keycode =
        map[event.key] ??
        (event.key.length === 1 ? event.key.toUpperCase().charCodeAt(0) : 0);
      if (!keycode) return;
      await ipc.godot.call({
        action: "simulate_input",
        params: { type: "key", keycode, pressed: event.type === "keydown" },
      });
    },
    [forwardInput],
  );

  const step = useCallback(async () => {
    await ipc.godot.call({ action: "step", params: { frames: 1 } });
    // The frame we want is the one *after* the step; the poll would show it
    // eventually, but an explicit capture makes stepping feel immediate.
    setTimeout(() => void capture(), 120);
  }, [capture]);

  const togglePause = useCallback(async () => {
    const next = !paused;
    const res = await ipc.godot.call({
      action: "set_paused",
      params: { paused: next },
    });
    if (res.ok === true) onPausedChange(Boolean(res.paused));
    void capture();
  }, [paused, onPausedChange, capture]);

  return (
    <Panel
      title="Viewport"
      subtitle={
        running
          ? frame?.width
            ? `${frame.width} × ${frame.height} · preview at ${fast ? "5" : "2"} fps`
            : "waiting for the first frame"
          : "engine not running"
      }
      icon={<Gamepad2 />}
      flush
      className={cn("min-h-0", className)}
      actions={
        running ? (
          <>
            <Chip
              selected={forwardInput}
              icon={<MousePointerClick />}
              onClick={() => setForwardInput((v) => !v)}
              title="Send clicks and keys from this preview into the game"
            >
              Input
            </Chip>
            <Chip selected={fast} onClick={() => setFast((v) => !v)}>
              {fast ? "5 fps" : "2 fps"}
            </Chip>
            <LIconButton
              label={paused ? "Resume the game" : "Pause the game"}
              size="compact"
              active={paused}
              onClick={() => void togglePause()}
            >
              {paused ? <Play /> : <Pause />}
            </LIconButton>
            <LIconButton
              label="Advance one frame"
              size="compact"
              disabled={!paused}
              onClick={() => void step()}
            >
              <SkipForward />
            </LIconButton>
            <LIconButton
              label="Capture now"
              size="compact"
              disabled={busy}
              onClick={() => void capture()}
            >
              <Camera />
            </LIconButton>
          </>
        ) : undefined
      }
      bodyClassName="min-h-0 flex-1"
    >
      <ViewportSurface
        frame={frame}
        running={running}
        forwardInput={forwardInput}
        imgRef={imgRef}
        onClick={handleClick}
        onKey={handleKey}
      />
    </Panel>
  );
}

function ViewportSurface({
  frame,
  running,
  forwardInput,
  imgRef,
  onClick,
  onKey,
}: {
  frame: ViewportFrame | null;
  running: boolean;
  forwardInput: boolean;
  imgRef: React.RefObject<HTMLImageElement | null>;
  onClick: (event: React.MouseEvent<HTMLImageElement>) => void;
  onKey: (event: React.KeyboardEvent) => void;
}) {
  if (!running) {
    return (
      <EmptyState
        icon={<Gamepad2 />}
        title="Engine not running"
        description="Start Godot to see the live game here. Headless mode still renders — you get the viewport without a separate window."
      />
    );
  }
  if (frame?.error) {
    return (
      <EmptyState
        compact
        icon={<Gamepad2 />}
        title="No frame"
        description={frame.error}
      />
    );
  }
  if (!frame?.dataUrl) {
    return (
      <div className="flex h-full items-center justify-center">
        <LBadge tone="accent" dot>
          waiting for the first frame
        </LBadge>
      </div>
    );
  }
  return (
    <div
      // The checkerboard makes transparent regions legible instead of blending
      // into the panel, which matters for UI and sprite work.
      className={cn(
        "relative flex h-full min-h-[220px] items-center justify-center overflow-hidden rounded-[16px]",
        "bg-[repeating-conic-gradient(rgba(255,255,255,0.035)_0%_25%,transparent_0%_50%)] bg-[length:18px_18px]",
        forwardInput && "ring-1 ring-primary/45",
      )}
      tabIndex={forwardInput ? 0 : -1}
      onKeyDown={onKey}
      onKeyUp={onKey}
    >
      <img
        ref={imgRef}
        src={frame.dataUrl}
        alt="Godot viewport"
        draggable={false}
        onClick={onClick}
        className={cn(
          "max-h-full max-w-full select-none object-contain",
          forwardInput ? "cursor-crosshair" : "cursor-default",
        )}
      />
      {forwardInput && (
        <div className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2">
          <LBadge tone="accent">
            input forwarding on — click the frame, then use WASD / space
          </LBadge>
        </div>
      )}
    </div>
  );
}
