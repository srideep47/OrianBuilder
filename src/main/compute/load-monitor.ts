/**
 * Polls loaded models and GPU utilization, then broadcasts live load stats
 * to all connected peers every 2 seconds.
 *
 * Sources (checked in priority order):
 *  1. OrianBuilder embedded llama-server (port 11435) — no install needed
 *  2. Ollama (port 11434) — if running
 *  3. LM Studio (port 1234) — if running
 *
 * The monitor always runs so peers can see what models are available.
 * computeAvailable is set separately via setComputeAvailable() when the user
 * enables "Share my compute".
 */

import log from "electron-log";
import { networkSwarm } from "@/main/network/swarm";
import { getServerStatus } from "@/ipc/utils/embedded_inference_server";

const logger = log.scope("compute:load-monitor");

let _interval: ReturnType<typeof setInterval> | null = null;
let _currentLoad = 0;
let _computeAvailable = false;
let _queueDepth = 0;

export function setComputeAvailable(enabled: boolean): void {
  _computeAvailable = enabled;
  // Trigger an immediate broadcast so peers see the change right away
  void _broadcast();
}

export function setQueueDepth(depth: number): void {
  _queueDepth = depth;
}

export function getCurrentLoad(): number {
  return _currentLoad;
}

export function startLoadMonitor(): void {
  if (_interval) return;
  _interval = setInterval(() => void _broadcast(), 2000);
  // Broadcast immediately on start
  void _broadcast();
  logger.info("Load monitor started");
}

export function stopLoadMonitor(): void {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
  }
}

async function _broadcast(): Promise<void> {
  try {
    const [load, models] = await Promise.all([
      _pollGpuUtilization(),
      _collectLoadedModels(),
    ]);
    _currentLoad = load;
    networkSwarm.broadcastLoad({
      gpuUtilization: _currentLoad,
      loadedModels: models,
      computeAvailable: _computeAvailable,
      queueDepth: _queueDepth,
    });
  } catch {
    // non-critical
  }
}

async function _pollGpuUtilization(): Promise<number> {
  try {
    // llama-server exposes prometheus metrics when a model is active
    const res = await fetch("http://127.0.0.1:11435/metrics", {
      signal: AbortSignal.timeout(400),
    });
    if (!res.ok) return _currentLoad;
    const text = await res.text();
    const match = text.match(/llamacpp:tokens_per_second\s+([\d.]+)/);
    if (match) {
      return Math.min(100, Math.round(parseFloat(match[1]) * 2));
    }
    return _currentLoad;
  } catch {
    return _currentLoad;
  }
}

async function _collectLoadedModels(): Promise<string[]> {
  const models: string[] = [];

  // ── 1. Embedded llama-server (OrianBuilder Engine screen) ────────────────
  // Read directly from the in-process state — no HTTP round-trip needed.
  try {
    const embedded = getServerStatus();
    if (embedded.modelLoaded && embedded.modelName) {
      models.push(embedded.modelName);
    }
  } catch {}

  // ── 2. Ollama ─────────────────────────────────────────────────────────────
  try {
    const res = await fetch("http://127.0.0.1:11434/api/tags", {
      signal: AbortSignal.timeout(800),
    });
    if (res.ok) {
      const data = (await res.json()) as { models?: { name: string }[] };
      for (const m of data.models ?? []) {
        if (m.name && !models.includes(m.name)) models.push(m.name);
      }
    }
  } catch {}

  // ── 3. LM Studio ──────────────────────────────────────────────────────────
  try {
    const res = await fetch("http://127.0.0.1:1234/v1/models", {
      signal: AbortSignal.timeout(800),
    });
    if (res.ok) {
      const data = (await res.json()) as { data?: { id: string }[] };
      for (const m of data.data ?? []) {
        if (m.id && !models.includes(m.id)) models.push(m.id);
      }
    }
  } catch {}

  return models;
}
