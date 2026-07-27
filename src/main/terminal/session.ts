import os from "node:os";
import path from "node:path";
import { BrowserWindow } from "electron";
import log from "electron-log";
import { spawn as spawnPty, type IPty } from "node-pty";

const logger = log.scope("terminal");

/**
 * Interactive terminal sessions.
 *
 * OrionAndroid has had one since the mobile dev centre landed
 * (`claudecode/TerminalProcess.kt`); desktop had `node-pty` as a dependency but
 * used it only for one-shot command runs, so there was no shell you could type
 * into — the single biggest hole in the workspace.
 *
 * A real pty, not a piped `child_process`: without a tty, `npm` hides progress,
 * `git` refuses to prompt, `vite` prints no colour, and anything using readline
 * (a REPL, `ssh`, an interactive rebase) simply hangs. That's the difference
 * between a terminal and a log viewer.
 */

export interface TerminalInfo {
  id: string;
  /** Working directory the shell started in. */
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
  /** Null while alive; set once the process exits. */
  exitCode: number | null;
}

interface Session {
  info: TerminalInfo;
  pty: IPty;
  /** Replayed to a renderer that attaches after output has already arrived. */
  scrollback: string;
}

/** Cap on retained scrollback per session. A `npm install` alone is ~200 KB. */
const MAX_SCROLLBACK = 512 * 1024;

const sessions = new Map<string, Session>();
let counter = 0;

/**
 * The user's login shell.
 *
 * `COMSPEC` on Windows rather than hardcoding `cmd.exe`, and PowerShell is
 * deliberately *not* preferred: most project tooling documentation assumes a
 * POSIX-ish or cmd invocation, and silently handing the user a shell where `&&`
 * is a parse error is a worse default than a plain one.
 */
function defaultShell(): string {
  if (process.platform === "win32") {
    return process.env.COMSPEC ?? "cmd.exe";
  }
  return process.env.SHELL ?? "/bin/bash";
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send(channel, payload);
  }
}

export const TERMINAL_DATA_CHANNEL = "terminal:data";
export const TERMINAL_EXIT_CHANNEL = "terminal:exit";

export function createTerminal(params: {
  cwd?: string;
  shell?: string;
  cols?: number;
  rows?: number;
  /** Extra environment on top of the app's own. */
  env?: Record<string, string>;
}): TerminalInfo {
  const id = `term-${++counter}`;
  const cwd = params.cwd && params.cwd.length > 0 ? params.cwd : os.homedir();
  const shell = params.shell ?? defaultShell();
  const cols = params.cols ?? 80;
  const rows = params.rows ?? 24;

  const pty = spawnPty(shell, [], {
    name: "xterm-256color",
    cwd,
    cols,
    rows,
    env: {
      ...process.env,
      ...params.env,
      // Tell tooling it has a colour terminal. Without this many CLIs strip
      // ANSI even though we can render it.
      TERM: "xterm-256color",
      FORCE_COLOR: "1",
    } as Record<string, string>,
  });

  const info: TerminalInfo = { id, cwd, shell, cols, rows, exitCode: null };
  const session: Session = { info, pty, scrollback: "" };
  sessions.set(id, session);

  pty.onData((data) => {
    session.scrollback += data;
    if (session.scrollback.length > MAX_SCROLLBACK) {
      session.scrollback = session.scrollback.slice(-MAX_SCROLLBACK);
    }
    broadcast(TERMINAL_DATA_CHANNEL, { id, data });
  });

  pty.onExit(({ exitCode }) => {
    session.info.exitCode = exitCode;
    broadcast(TERMINAL_EXIT_CHANNEL, { id, exitCode });
    logger.info(`Terminal ${id} exited (${exitCode})`);
  });

  logger.info(`Terminal ${id} started: ${shell} in ${cwd}`);
  return info;
}

export function writeTerminal(id: string, data: string): boolean {
  const session = sessions.get(id);
  if (!session || session.info.exitCode !== null) return false;
  session.pty.write(data);
  return true;
}

export function resizeTerminal(
  id: string,
  cols: number,
  rows: number,
): boolean {
  const session = sessions.get(id);
  if (!session || session.info.exitCode !== null) return false;
  // A zero dimension throws inside node-pty on Windows; the renderer can emit
  // one transiently while the panel is collapsing.
  if (cols < 1 || rows < 1) return false;
  session.pty.resize(cols, rows);
  session.info.cols = cols;
  session.info.rows = rows;
  return true;
}

export function killTerminal(id: string): boolean {
  const session = sessions.get(id);
  if (!session) return false;
  try {
    session.pty.kill();
  } catch {
    /* already gone */
  }
  sessions.delete(id);
  return true;
}

export function listTerminals(): TerminalInfo[] {
  return Array.from(sessions.values(), (s) => s.info);
}

/** Replayed on attach so a reopened panel isn't blank. */
export function terminalScrollback(id: string): string {
  return sessions.get(id)?.scrollback ?? "";
}

/**
 * Sends a `cd` into an existing session, POSIX-quoting the path.
 *
 * Mirrors Android's `WorkspaceViewModel.openTerminalAt`, including the quoting:
 * a directory name from a cloned repository is untrusted text, and splicing it
 * unquoted into a live shell's stdin is a command-injection vector, not a
 * cosmetic issue.
 */
export function changeDirectory(id: string, target: string): boolean {
  const quoted =
    process.platform === "win32"
      ? `"${target.replace(/"/g, '""')}"`
      : `'${target.replace(/'/g, `'\\''`)}'`;
  return writeTerminal(id, `cd ${quoted}${os.EOL}`);
}

/** Kills every session. Called on app quit so no shell outlives the window. */
export function killAllTerminals(): void {
  for (const id of Array.from(sessions.keys())) killTerminal(id);
}

/** Resolves a sensible starting directory for a project path. */
export function resolveStartDir(appPath: string, relative?: string): string {
  if (!relative) return appPath;
  const joined = path.resolve(appPath, relative);
  // Jail to the project: a `../..` in a path from the file tree must not open a
  // shell somewhere else on the disk.
  const rel = path.relative(appPath, joined);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return appPath;
  return joined;
}
