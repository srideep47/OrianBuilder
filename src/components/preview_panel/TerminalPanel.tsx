import { useCallback, useEffect, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import { Plus, SquareTerminal, Trash2 } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import { ipc } from "@/ipc/types";
import type { TerminalInfo } from "@/ipc/types";
import { showError } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { EmptyState, LBadge, LButton, LIconButton } from "@/components/liquid";

/**
 * A real interactive terminal in the workspace.
 *
 * xterm.js against a `node-pty` session in the main process — a genuine tty, so
 * `npm install` shows progress bars, `git` can prompt, colour survives, and
 * anything using readline works. Before this the desktop had no shell at all;
 * OrionAndroid has had one since its mobile dev centre shipped.
 *
 * Themed to Cosmos so it reads as part of the app rather than a foreign widget
 * pasted into it.
 */

/** Cosmos-matched palette. ANSI colours are drawn from the same accent set the
 *  rest of the UI uses, so a red error in the terminal is the same red as a red
 *  badge beside it. */
const THEME = {
  background: "#00000000",
  foreground: "#e8e6f2",
  cursor: "#a88cff",
  cursorAccent: "#0a0618",
  selectionBackground: "rgba(168,140,255,0.30)",
  black: "#1a1430",
  red: "#ff8794",
  green: "#5fdfa3",
  yellow: "#ffc56b",
  blue: "#78b4ff",
  magenta: "#c5b3ff",
  cyan: "#7ee0e6",
  white: "#d9d6e8",
  brightBlack: "#5b5480",
  brightRed: "#ffa3ad",
  brightGreen: "#8aeabf",
  brightYellow: "#ffd693",
  brightBlue: "#9cc9ff",
  brightMagenta: "#dccfff",
  brightCyan: "#a5eef2",
  brightWhite: "#ffffff",
} as const;

export function TerminalPanel() {
  const selectedAppId = useAtomValue(selectedAppIdAtom);
  const [sessions, setSessions] = useState<TerminalInfo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  // Reconcile with the main process on mount: sessions outlive this panel being
  // unmounted, so a reopened Terminal tab must find its shells still there.
  useEffect(() => {
    void (async () => {
      const list = await ipc.terminal.list(undefined);
      setSessions(list);
      setActiveId((current) => current ?? list[0]?.id ?? null);
    })();
  }, []);

  useEffect(() => {
    return ipc.events.terminal.onExit(({ id, exitCode }) => {
      setSessions((prev) =>
        prev.map((s) => (s.id === id ? { ...s, exitCode } : s)),
      );
    });
  }, []);

  const create = useCallback(async () => {
    setStarting(true);
    try {
      const info = await ipc.terminal.create({
        appId: selectedAppId ?? undefined,
      });
      setSessions((prev) => [...prev, info]);
      setActiveId(info.id);
    } catch (err) {
      showError(`Could not start a shell: ${err}`);
    } finally {
      setStarting(false);
    }
  }, [selectedAppId]);

  const close = useCallback(
    async (id: string) => {
      await ipc.terminal.kill({ id });
      setSessions((prev) => prev.filter((s) => s.id !== id));
      setActiveId((current) => {
        if (current !== id) return current;
        const remaining = sessions.filter((s) => s.id !== id);
        return remaining[0]?.id ?? null;
      });
    },
    [sessions],
  );

  if (sessions.length === 0) {
    return (
      <EmptyState
        icon={<SquareTerminal />}
        title="No shell running"
        description={
          selectedAppId == null
            ? "Opens in your home directory. Select a project to start in its folder instead."
            : "Opens in this project's folder, with a real tty — progress bars, colour and prompts all work."
        }
        action={
          <LButton
            size="compact"
            tone="primary"
            icon={<Plus />}
            disabled={starting}
            onClick={() => void create()}
          >
            New shell
          </LButton>
        }
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Session tabs. Multiple shells is the normal case — a dev server in one,
          git in another — so they're first-class rather than a single session. */}
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-white/[0.07] px-2 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {sessions.map((session) => (
          <button
            key={session.id}
            type="button"
            onClick={() => setActiveId(session.id)}
            className={cn(
              "group inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[12px] transition-colors",
              session.id === activeId
                ? "border-primary/40 bg-primary/18 text-primary"
                : "border-transparent text-muted-foreground hover:bg-white/[0.07] hover:text-foreground",
            )}
          >
            <SquareTerminal className="h-3.5 w-3.5" />
            <span className="font-mono">{session.id.replace("term-", "")}</span>
            {session.exitCode !== null && (
              <span className="font-mono text-[10px] opacity-70">
                exit {session.exitCode}
              </span>
            )}
            <span
              role="button"
              tabIndex={-1}
              aria-label={`Close shell ${session.id}`}
              onClick={(event) => {
                event.stopPropagation();
                void close(session.id);
              }}
              className="ml-0.5 rounded p-0.5 opacity-0 transition-opacity hover:text-[var(--cosmos-red)] group-hover:opacity-100"
            >
              <Trash2 className="h-3 w-3" />
            </span>
          </button>
        ))}
        <div className="ml-auto shrink-0">
          <LIconButton
            label="New shell"
            size="compact"
            disabled={starting}
            onClick={() => void create()}
          >
            <Plus />
          </LIconButton>
        </div>
      </div>

      {/* Every session stays mounted so switching tabs preserves its viewport and
          scroll position; only the active one is visible. */}
      <div className="relative min-h-0 flex-1">
        {sessions.map((session) => (
          <TerminalSurface
            key={session.id}
            session={session}
            active={session.id === activeId}
          />
        ))}
      </div>
    </div>
  );
}

function TerminalSurface({
  session,
  active,
}: {
  session: TerminalInfo;
  active: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      theme: THEME,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 12,
      lineHeight: 1.35,
      cursorBlink: true,
      // Transparency so the Cosmos backdrop shows through, matching every other
      // surface in the app.
      allowTransparency: true,
      scrollback: 10_000,
      convertEol: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    // Replay what the shell already printed, so a panel opened after a long
    // `npm install` isn't blank.
    void ipc.terminal.scrollback({ id: session.id }).then(({ data }) => {
      if (data) term.write(data);
    });

    const offData = ipc.events.terminal.onData(({ id, data }) => {
      if (id === session.id) term.write(data);
    });

    const disposeInput = term.onData((data) => {
      void ipc.terminal.write({ id: session.id, data });
    });

    // Keep the pty's window size in step with the rendered one, or wrapped
    // output and full-screen programs draw at the wrong width.
    const syncSize = () => {
      try {
        fit.fit();
        void ipc.terminal.resize({
          id: session.id,
          cols: term.cols,
          rows: term.rows,
        });
      } catch {
        // Fit throws while the host has zero size (collapsed dock).
      }
    };
    const observer = new ResizeObserver(syncSize);
    observer.observe(host);
    syncSize();

    return () => {
      observer.disconnect();
      offData();
      disposeInput.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [session.id]);

  // Refit when this tab becomes visible: while hidden the host has no size, so
  // the last fit was against a zero box.
  useEffect(() => {
    if (!active) return;
    const id = window.setTimeout(() => {
      try {
        fitRef.current?.fit();
        const term = termRef.current;
        if (term) {
          void ipc.terminal.resize({
            id: session.id,
            cols: term.cols,
            rows: term.rows,
          });
        }
      } catch {
        /* zero-size host */
      }
    }, 40);
    return () => window.clearTimeout(id);
  }, [active, session.id]);

  return (
    <div
      className={cn(
        "absolute inset-0 flex flex-col",
        active ? "visible" : "invisible",
      )}
    >
      <div className="flex shrink-0 items-center gap-2 px-3 py-1">
        <LBadge tone={session.exitCode === null ? "success" : "neutral"} dot>
          {session.exitCode === null ? "running" : `exited ${session.exitCode}`}
        </LBadge>
        <span className="truncate font-mono text-[11px] text-muted-foreground">
          {session.shell} · {session.cwd}
        </span>
      </div>
      <div ref={hostRef} className="min-h-0 flex-1 px-2 pb-2" />
    </div>
  );
}
