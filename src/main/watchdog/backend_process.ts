/**
 * Manages the Watchdog FastAPI child process.
 *
 * Mirrors the pattern used by `llama_server_backend.ts`: spawn the interpreter
 * with uvicorn, watch stdout/stderr (forwarding to electron-log + an in-memory
 * tail), and poll `/health` until it answers 200 OK.
 *
 * Lifecycle:
 *   start()    → spawn uvicorn, wait for /health, emit status
 *   stop()     → SIGTERM, then SIGKILL after grace period
 *   getStatus()→ running/host/port/pid + last error
 *
 * Connection point with OrianBuilder:
 *   - DB lives at <userData>/watchdog/watchdog.db via WATCHDOG_DB_PATH env.
 *   - Summaries are produced by OrianBuilder's own llama-server on port
 *     EMBEDDED_PORT (11435) — WATCHDOG_LLM_MODE=openai, WATCHDOG_LLM_URL points
 *     there. If no model is loaded the summarize call fails and the backend
 *     substitutes a fallback string; the rest of the app keeps working.
 */
import { ChildProcess, spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import log from "electron-log";

import {
  getBundledBackendDir,
  getDatabasePath,
  getVenvPython,
  isSetupComplete,
} from "./venv_installer";

const logger = log.scope("watchdog-backend");

export const WATCHDOG_DEFAULT_HOST = "127.0.0.1";
export const WATCHDOG_DEFAULT_PORT = 8765;

const HEALTH_POLL_INTERVAL_MS = 250;
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const STOP_GRACE_MS = 5_000;
const STDERR_TAIL_LINES = 30;

export interface WatchdogStartConfig {
  host?: string;
  port?: number;
  /** OrianBuilder's llama-server URL — passed through as WATCHDOG_LLM_URL.
   *  When set, the backend uses the OpenAI-compatible /v1 surface (mode="openai").
   *  Leave undefined to fall back to Ollama on 11434. */
  llmBaseUrl?: string;
  /** Model name to request from the LLM endpoint. Defaults preserved in the
   *  Python module if omitted. */
  llmModel?: string;
  readyTimeoutMs?: number;
}

export interface WatchdogStatus {
  running: boolean;
  host: string | null;
  port: number | null;
  pid: number | null;
  setupComplete: boolean;
  lastError: string | null;
}

export class WatchdogBackend {
  private child: ChildProcess | null = null;
  private host: string | null = null;
  private port: number | null = null;
  private stderrTail: string[] = [];

  getStatus(): WatchdogStatus {
    return {
      running: this.child !== null && this.child.exitCode === null,
      host: this.host,
      port: this.port,
      pid: this.child?.pid ?? null,
      setupComplete: isSetupComplete(),
      lastError: this.stderrTail.length
        ? this.stderrTail.join("\n").slice(-4_000)
        : null,
    };
  }

  async start(config: WatchdogStartConfig = {}): Promise<void> {
    if (this.child) {
      await this.stop();
    }
    if (!isSetupComplete()) {
      throw new Error(
        "Watchdog is not set up yet — run setup before starting the backend.",
      );
    }
    const venvPython = getVenvPython();
    const backendDir = getBundledBackendDir();
    // The vendored backend's import statements (`from .db import ...`) require
    // the `backend` package to be importable, which means the working
    // directory has to be the *parent* of `backend/` so Python can find it as
    // a top-level module.
    const cwd = path.dirname(backendDir);

    const host = config.host ?? WATCHDOG_DEFAULT_HOST;
    const port = config.port ?? WATCHDOG_DEFAULT_PORT;

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      WATCHDOG_HOST: host,
      WATCHDOG_PORT: String(port),
      WATCHDOG_DB_PATH: getDatabasePath(),
      PYTHONIOENCODING: "utf-8",
      PYTHONUNBUFFERED: "1",
    };
    if (config.llmBaseUrl) {
      env.WATCHDOG_LLM_MODE = "openai";
      env.WATCHDOG_LLM_URL = config.llmBaseUrl;
    }
    if (config.llmModel) {
      env.WATCHDOG_LLM_MODEL = config.llmModel;
    }

    const args = [
      "-m",
      "uvicorn",
      "backend.app.main:app",
      "--host",
      host,
      "--port",
      String(port),
    ];

    logger.info(`Spawning ${venvPython} ${args.join(" ")} (cwd=${cwd})`);

    this.stderrTail = [];
    const child = spawn(venvPython, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    this.child = child;
    this.host = host;
    this.port = port;

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line.trim()) logger.info(`[stdout] ${line}`);
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      // uvicorn writes its access/startup logs to stderr; treat it as info
      // unless we see an explicit ERROR marker.
      for (const line of chunk.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const level = /\bERROR\b|\bCRITICAL\b/i.test(line) ? "error" : "info";
        if (level === "error") logger.error(`[stderr] ${line}`);
        else logger.info(`[stderr] ${line}`);
        this.stderrTail.push(line);
        if (this.stderrTail.length > STDERR_TAIL_LINES) {
          this.stderrTail.shift();
        }
      }
    });

    const exitPromise = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });

    const spawnErrorPromise = new Promise<Error | null>((resolve) => {
      child.once("error", (err) => {
        this.stderrTail.push(`spawn error: ${err.message}`);
        resolve(err);
      });
      child.once("spawn", () => resolve(null));
    });

    try {
      const spawnErr = await Promise.race([
        spawnErrorPromise,
        delay(2_000).then(() => null),
      ]);
      if (spawnErr) {
        throw new Error(
          `Failed to launch Watchdog backend (${venvPython}): ${spawnErr.message}`,
        );
      }
      await this.waitForReady({
        host,
        port,
        timeoutMs: config.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
        exitPromise,
      });
    } catch (err) {
      await this.stop().catch(() => {});
      throw err;
    }

    logger.info(`Watchdog backend ready on ${host}:${port} (pid=${child.pid})`);
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;

    this.child = null;
    this.host = null;
    this.port = null;

    if (child.exitCode !== null) return;

    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    });

    try {
      child.kill("SIGTERM");
    } catch (err) {
      logger.warn("Failed to send SIGTERM to Watchdog backend:", err);
    }

    const timeout = new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), STOP_GRACE_MS);
    });
    const result = await Promise.race([
      exited.then(() => "exited" as const),
      timeout,
    ]);
    if (result === "timeout") {
      logger.warn(
        "Watchdog backend did not exit on SIGTERM; sending SIGKILL",
      );
      try {
        child.kill("SIGKILL");
      } catch (err) {
        logger.warn("Failed to send SIGKILL to Watchdog backend:", err);
      }
      await exited.catch(() => undefined);
    }
  }

  private async waitForReady(params: {
    host: string;
    port: number;
    timeoutMs: number;
    exitPromise: Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>;
  }): Promise<void> {
    const deadline = Date.now() + params.timeoutMs;
    while (Date.now() < deadline) {
      const raced = await Promise.race([
        params.exitPromise.then((info) => ({ kind: "exit", info }) as const),
        delay(HEALTH_POLL_INTERVAL_MS).then(() => ({ kind: "tick" }) as const),
      ]);
      if (raced.kind === "exit") {
        const tail = this.stderrTail.join("\n").slice(-2_000);
        throw new Error(
          `Watchdog backend exited before becoming ready ` +
            `(code=${raced.info.code}, signal=${raced.info.signal}). ` +
            `Last stderr:\n${tail || "(empty)"}`,
        );
      }
      if (await pingHealth(params.host, params.port)) return;
    }
    throw new Error(
      `Watchdog backend did not become ready within ${params.timeoutMs}ms`,
    );
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pingHealth(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host,
        port,
        path: "/health",
        method: "GET",
        timeout: 1_000,
      },
      (res) => {
        res.on("data", () => undefined);
        res.on("end", () => resolve((res.statusCode ?? 0) < 500));
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

/** Module-level singleton so the rest of the main process can grab the same
 *  backend instance without juggling references. */
export const watchdogBackend = new WatchdogBackend();
