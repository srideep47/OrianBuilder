import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs/promises";
import log from "electron-log";
import { locateGodot, type GodotInstall } from "./locate";
import { GodotBridgeClient } from "./bridge_client";
import { ensureBridge, GODOT_USER_SUBDIR, readGodotProject } from "./project";

const logger = log.scope("godot-process");

export type GodotRunState = "idle" | "starting" | "running" | "stopping";

/**
 * How the engine is presented.
 *
 *  - `windowed` — a normal game window the user can see and click.
 *  - `headless` — no window at all; the bridge still answers and screenshots
 *    still render, so an agent can build and verify a game with nothing on
 *    screen. This is the mode automated runs use.
 *  - `editor` — the full Godot editor, for manual work on the same project.
 */
export type GodotMode = "windowed" | "headless" | "editor";

export interface GodotStatus {
  state: GodotRunState;
  mode: GodotMode | null;
  projectDir: string | null;
  projectName: string | null;
  /** True once the bridge answered a ping. */
  bridgeReady: boolean;
  pid: number | null;
  install: GodotInstall | null;
  /** Last ~200 lines of engine stdout/stderr, newest last. */
  output: string[];
  /** Set when the last start attempt failed. */
  error: string | null;
  startedAt: number | null;
}

const MAX_OUTPUT_LINES = 200;

/**
 * Owns the engine's lifecycle.
 *
 * Stop is a real process kill, never an in-process teardown: Godot holds
 * extensive static state and has no supported reinit path
 * (godotengine/godot#99705 — confirmed by a Godot maintainer on a failed iOS
 * attempt). That is also what makes the idle cost exactly zero — between runs
 * there is no engine process at all.
 *
 * One engine at a time. Godot can't swap projects in place for the same reason,
 * so switching projects stops and restarts rather than pretending.
 */
class GodotProcessController {
  private child: ChildProcess | null = null;
  private state: GodotRunState = "idle";
  private mode: GodotMode | null = null;
  private projectDir: string | null = null;
  private projectName: string | null = null;
  private bridgeReady = false;
  private output: string[] = [];
  private error: string | null = null;
  private startedAt: number | null = null;
  private starting: Promise<GodotStatus> | null = null;
  private listeners = new Set<(status: GodotStatus) => void>();

  onChange(listener: (status: GodotStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const snapshot = this.status();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (err) {
        logger.warn("Godot status listener threw:", err);
      }
    }
  }

  private push(line: string): void {
    for (const part of line.split(/\r?\n/)) {
      const trimmed = part.trimEnd();
      if (!trimmed) continue;
      this.output.push(trimmed);
    }
    if (this.output.length > MAX_OUTPUT_LINES) {
      this.output = this.output.slice(-MAX_OUTPUT_LINES);
    }
  }

  status(): GodotStatus {
    return {
      state: this.state,
      mode: this.mode,
      projectDir: this.projectDir,
      projectName: this.projectName,
      bridgeReady: this.bridgeReady,
      pid: this.child?.pid ?? null,
      install: null, // filled by the handler, which caches discovery
      output: [...this.output],
      error: this.error,
      startedAt: this.startedAt,
    };
  }

  client(): GodotBridgeClient | null {
    return this.projectDir ? new GodotBridgeClient(this.projectDir) : null;
  }

  isRunning(): boolean {
    return this.state === "running" && this.child !== null;
  }

  /**
   * Starts the engine on `projectDir`, installing the bridge first.
   *
   * Concurrent calls coalesce onto one start. A call naming a *different*
   * project while running is refused rather than silently ignored — the caller
   * must stop first, so a stray tool call can't yank the engine out from under a
   * session the user is watching.
   */
  async start(params: {
    projectDir: string;
    mode?: GodotMode;
    /** Extra engine flags, e.g. `--verbose`. */
    args?: string[];
  }): Promise<GodotStatus> {
    if (this.starting) return this.starting;

    const mode = params.mode ?? "windowed";
    const projectDir = path.resolve(params.projectDir);

    if (this.isRunning()) {
      if (this.projectDir !== projectDir) {
        throw new Error(
          `Godot is already running ${this.projectName ?? this.projectDir}. Stop it before opening a different project.`,
        );
      }
      if (this.mode !== mode) {
        throw new Error(
          `Godot is already running in ${this.mode} mode. Stop it before switching to ${mode}.`,
        );
      }
      return this.status();
    }

    this.starting = this.doStart(projectDir, mode, params.args ?? []);
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async doStart(
    projectDir: string,
    mode: GodotMode,
    extraArgs: string[],
  ): Promise<GodotStatus> {
    const install = await locateGodot();
    if (!install) {
      this.error =
        "No Godot engine found. Install Godot 4 and point Orion at it on the Game page.";
      this.emit();
      throw new Error(this.error);
    }
    if (!install.supported) {
      this.error = `Godot ${install.version} is older than the supported 4.2 floor.`;
      this.emit();
      throw new Error(this.error);
    }

    const project = await readGodotProject(projectDir);
    if (!project) {
      this.error = `No project.godot in ${projectDir}`;
      this.emit();
      throw new Error(this.error);
    }

    await ensureBridge(projectDir);
    const userDir = path.join(projectDir, GODOT_USER_SUBDIR);
    await fs.mkdir(userDir, { recursive: true });

    this.state = "starting";
    this.mode = mode;
    this.projectDir = projectDir;
    this.projectName = project.name;
    this.bridgeReady = false;
    this.error = null;
    this.output = [];
    this.startedAt = Date.now();
    this.emit();

    const args = ["--path", projectDir];
    if (mode === "editor") {
      args.push("--editor");
    } else if (mode === "headless") {
      // `--headless` selects the null display server. The bridge still answers
      // and `get_viewport().get_texture()` still renders, so screenshots work —
      // which is what lets an agent build and visually verify a game with
      // nothing on screen.
      args.push("--headless");
    }
    args.push(...extraArgs);

    logger.info(`Starting Godot: ${install.executable} ${args.join(" ")}`);

    const child = spawn(install.executable, args, {
      cwd: projectDir,
      windowsHide: mode === "headless",
      env: {
        ...process.env,
        // Pin `user://` inside the project so the bridge token lands where
        // `tokenPathForProject` looks for it, regardless of the project's name.
        // Godot honours this on all three desktop platforms.
        XDG_DATA_HOME: userDir,
        APPDATA: process.platform === "win32" ? userDir : process.env.APPDATA,
        HOME: process.platform === "darwin" ? userDir : process.env.HOME,
      },
    });
    this.child = child;

    child.stdout?.on("data", (buf: Buffer) => {
      this.push(buf.toString("utf8"));
      this.emit();
    });
    child.stderr?.on("data", (buf: Buffer) => {
      this.push(buf.toString("utf8"));
      this.emit();
    });
    child.on("error", (err) => {
      this.error = err.message;
      this.state = "idle";
      this.child = null;
      this.bridgeReady = false;
      this.emit();
    });
    child.on("exit", (code, signal) => {
      // The engine can die on its own (a script error, the user closing the
      // window, its own init failure alert). Reconcile rather than leaving a
      // stale "running" that every subsequent call would trust.
      this.push(
        `[engine exited code=${code ?? "null"} signal=${signal ?? "none"}]`,
      );
      this.state = "idle";
      this.child = null;
      this.bridgeReady = false;
      this.mode = null;
      this.emit();
    });

    // The editor doesn't run the game, so no bridge autoload is active — treat
    // "process is up" as ready there. For game runs, wait for a real ping.
    if (mode === "editor") {
      this.state = "running";
      this.emit();
      return this.status();
    }

    const bridge = new GodotBridgeClient(projectDir);
    const ready = await bridge.waitUntilReady(40_000);
    if (!this.child) {
      // Exited while we were waiting; `exit` already reset the state.
      throw new Error(
        this.error ??
          `Godot exited during startup. Engine output:\n${this.output.slice(-20).join("\n")}`,
      );
    }
    this.bridgeReady = ready;
    this.state = "running";
    if (!ready) {
      this.error =
        "Godot started but the Orion bridge never answered on 127.0.0.1:8139. Check the engine output for a script error in addons/orion_bridge.";
    }
    this.emit();
    return this.status();
  }

  /** Kills the engine. Safe to call when nothing is running. */
  async stop(): Promise<GodotStatus> {
    const child = this.child;
    if (!child) {
      this.state = "idle";
      this.emit();
      return this.status();
    }
    this.state = "stopping";
    this.emit();

    await new Promise<void>((resolve) => {
      const done = () => resolve();
      child.once("exit", done);
      child.kill();
      // Godot occasionally ignores SIGTERM while a shader cache flush is in
      // flight; escalate rather than hanging the caller forever.
      setTimeout(() => {
        if (this.child === child) {
          try {
            child.kill("SIGKILL");
          } catch {
            /* already gone */
          }
        }
        resolve();
      }, 4_000);
    });

    this.child = null;
    this.state = "idle";
    this.mode = null;
    this.bridgeReady = false;
    this.emit();
    return this.status();
  }

  /** Re-checks liveness and repairs a stale `running`. */
  async reconcile(): Promise<GodotStatus> {
    if (this.state === "running" && this.child && this.mode !== "editor") {
      const bridge = new GodotBridgeClient(this.projectDir!);
      this.bridgeReady = await bridge.ping();
      this.emit();
    }
    return this.status();
  }
}

let controller: GodotProcessController | null = null;

export function getGodotController(): GodotProcessController {
  controller ??= new GodotProcessController();
  return controller;
}
