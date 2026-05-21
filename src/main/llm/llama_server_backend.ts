/**
 * Manages the llama-server child process that performs local inference.
 *
 * Lifecycle:
 *   start({ modelPath, ... })  →  spawn binary, wait for /health to return 200
 *   stop()                     →  SIGTERM, then SIGKILL after a short grace
 *   getStatus()                →  current state, port, model, resolved layers
 *
 * The process binds to 127.0.0.1 on the requested port (default 11435 — same
 * as the previous in-process wrapper, so LocalLlamaProvider's base URL stays
 * the same). Stdout/stderr are forwarded into electron-log so users see the
 * usual diagnostic stream.
 */

import { ChildProcess, spawn } from "node:child_process";
import http from "node:http";
import log from "electron-log";

import {
  resolveLlamaServerBinary,
  resolveLlamaServerBinaryByVariant,
  type LlamaServerVariant,
} from "./llama_server_binary";
import {
  buildLlamaServerArgs,
  type LlamaServerArgInput,
} from "./llama_server_args";
import { getCachedHardwareProfile } from "@/main/hardware/detect";
import {
  llamaServerStatsPoller,
  forwardLlamaServerLog,
} from "./llama_server_stats_poller";

const logger = log.scope("llama-server");

export interface LlamaServerStartConfig extends Omit<
  LlamaServerArgInput,
  "host" | "port"
> {
  host?: string;
  port?: number;
  /** Max ms to wait for the /health endpoint to report ready. */
  readyTimeoutMs?: number;
  /**
   * When set, bypasses hardware-profile auto-detection and loads the specified
   * llama-server variant directly. Use this when the user has manually selected
   * a GPU that differs from the auto-detected primary GPU (e.g. AMD iGPU on a
   * system that also has an NVIDIA discrete GPU).
   */
  variantOverride?: LlamaServerVariant;
}

export interface LlamaServerStatus {
  running: boolean;
  modelPath: string | null;
  modelName: string | null;
  /** Absolute path of the mmproj projector if one was loaded with the model,
   *  null otherwise. When set, the embedded backend accepts image content. */
  mmprojPath: string | null;
  host: string | null;
  port: number | null;
  pid: number | null;
  resolvedGpuLayers: number;
  binaryVariant: string | null;
  /** Last few lines of stderr. Useful when the process exits abnormally. */
  lastError: string | null;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 11435;
// Large quantized models (20B+, ~20GB+) can take 60-120s to mmap from disk
// on cold cache. 180s is a safe ceiling that still surfaces real hangs.
const DEFAULT_READY_TIMEOUT_MS = 180_000;
const HEALTH_POLL_INTERVAL_MS = 250;
const STOP_GRACE_MS = 5_000;
const STDERR_TAIL_LINES = 20;

export class LlamaServerBackend {
  private child: ChildProcess | null = null;
  private modelPath: string | null = null;
  private mmprojPath: string | null = null;
  private host: string | null = null;
  private port: number | null = null;
  private resolvedGpuLayers = 0;
  private binaryVariant: string | null = null;
  private stderrTail: string[] = [];

  getStatus(): LlamaServerStatus {
    return {
      running: this.child !== null && this.child.exitCode === null,
      modelPath: this.modelPath,
      modelName: this.modelPath
        ? (this.modelPath.split(/[/\\]/).pop() ?? null)
        : null,
      mmprojPath: this.mmprojPath,
      host: this.host,
      port: this.port,
      pid: this.child?.pid ?? null,
      resolvedGpuLayers: this.resolvedGpuLayers,
      binaryVariant: this.binaryVariant,
      lastError: this.stderrTail.length
        ? this.stderrTail.join("\n").slice(-4_000)
        : null,
    };
  }

  /** Spawn llama-server with the given model and wait for /health to be ready. */
  async start(config: LlamaServerStartConfig): Promise<void> {
    if (this.child) {
      await this.stop();
    }

    const profile = await getCachedHardwareProfile();
    const binary = config.variantOverride
      ? resolveLlamaServerBinaryByVariant(config.variantOverride)
      : resolveLlamaServerBinary(profile);

    const host = config.host ?? DEFAULT_HOST;
    const port = config.port ?? DEFAULT_PORT;
    const { flags, resolvedGpuLayers } = buildLlamaServerArgs({
      ...config,
      host,
      port,
    });

    logger.info(
      `Spawning ${binary.path} (${binary.variant}) with flags: ${flags.join(" ")}`,
    );

    this.stderrTail = [];
    const child = spawn(binary.path, flags, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    this.child = child;
    this.modelPath = config.modelPath;
    this.mmprojPath = config.mmprojPath ?? null;
    this.host = host;
    this.port = port;
    this.resolvedGpuLayers = resolvedGpuLayers;
    this.binaryVariant = binary.variant;

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (!line.trim()) continue;
        logger.info(`[stdout] ${line}`);
        forwardLlamaServerLog("info", line);
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (!line.trim()) continue;
        // llama.cpp emits most of its useful telemetry on stderr at "I" level
        // (the leading " W " timestamp marker is the high-precision wall clock,
        // not a warning). Tag everything below as "info" except the rare lines
        // that genuinely carry an "E " level marker.
        const level = /\bE\s/.test(line) ? "error" : "info";
        logger.warn(`[stderr] ${line}`);
        this.stderrTail.push(line);
        if (this.stderrTail.length > STDERR_TAIL_LINES) {
          this.stderrTail.shift();
        }
        forwardLlamaServerLog(level, line);
      }
    });

    const exitPromise = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });

    // spawn() returns immediately and emits 'error' asynchronously for
    // failures like ENOENT (binary missing/unreadable) or EACCES. Capture
    // them via a promise so waitForReady can surface the real reason.
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
          `Failed to launch llama-server (${binary.path}): ${spawnErr.message}`,
        );
      }
      await this.waitForReady({
        host,
        port,
        timeoutMs: config.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
        exitPromise,
      });
    } catch (err) {
      // Clean up the process before re-throwing so we don't leak it.
      await this.stop().catch(() => {});
      throw err;
    }

    // Now that /health is up, start polling /slots so the Inference Monitor
    // pane gets live token-rate / session telemetry from the child process.
    llamaServerStatsPoller.start(host, port);

    logger.info(
      `llama-server ready on ${host}:${port} (pid=${child.pid}, gpu-layers=${resolvedGpuLayers})`,
    );
  }

  /** Stop the child process. SIGTERM first, then SIGKILL after a grace period. */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child) {
      // Even if the child is already gone, the poller may still be ticking
      // against a stale port — stop it defensively so it doesn't fire after
      // the next model loads.
      llamaServerStatsPoller.stop();
      return;
    }

    // Tear down telemetry before we kill the child so the final stats flush
    // happens against a /slots endpoint that's still answering.
    llamaServerStatsPoller.stop();

    this.child = null;
    this.modelPath = null;
    this.mmprojPath = null;
    this.host = null;
    this.port = null;
    this.resolvedGpuLayers = 0;

    if (child.exitCode !== null) {
      return;
    }

    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    });

    try {
      child.kill("SIGTERM");
    } catch (err) {
      logger.warn("Failed to send SIGTERM to llama-server:", err);
    }

    const timeout = new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), STOP_GRACE_MS);
    });
    const result = await Promise.race([exited.then(() => "exited"), timeout]);
    if (result === "timeout") {
      logger.warn("llama-server did not exit on SIGTERM; sending SIGKILL");
      try {
        child.kill("SIGKILL");
      } catch (err) {
        logger.warn("Failed to send SIGKILL to llama-server:", err);
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
      // If the child exited while we were polling, fail fast with its stderr.
      const raced = await Promise.race([
        params.exitPromise.then((info) => ({ kind: "exit", info }) as const),
        delay(HEALTH_POLL_INTERVAL_MS).then(() => ({ kind: "tick" }) as const),
      ]);
      if (raced.kind === "exit") {
        const tail = this.stderrTail.join("\n").slice(-2_000);
        throw new Error(
          `llama-server exited before becoming ready ` +
            `(code=${raced.info.code}, signal=${raced.info.signal}). ` +
            `Last stderr:\n${tail || "(empty)"}`,
        );
      }
      const ready = await pingHealth(params.host, params.port);
      if (ready) return;
    }
    throw new Error(
      `llama-server did not become ready within ${params.timeoutMs}ms`,
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
        // Drain so the socket can be released.
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
