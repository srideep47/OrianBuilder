/**
 * Polls loaded models and GPU utilization for the OrianBuilder embedded
 * inference engine (the one driven by the Engine screen) and broadcasts live
 * load stats to all connected peers every 2 seconds.
 *
 * We only surface the embedded engine. The shared-compute path is locked to
 * the embedded engine in compute-node.ts, so advertising Ollama / LM Studio
 * models here would just tell peers about models we can't actually serve.
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
/** Last values that went out in a LOAD_UPDATE — used to seed METADATA on new
 *  connections so peers don't see a stale "no models" payload for the 2s
 *  window between connect and the next broadcast. */
let _lastBroadcast = {
  loadedModels: [] as string[],
  computeAvailable: false,
  gpuUtilization: 0,
  queueDepth: 0,
  timestamp: 0,
};

export function setComputeAvailable(enabled: boolean): void {
  _computeAvailable = enabled;
  // Trigger an immediate broadcast so peers see the change right away
  void _broadcast();
}

/** Snapshot of the last broadcast — read by swarm.ts to seed METADATA. */
export function getCurrentBroadcastState() {
  return { ..._lastBroadcast };
}

/** Force-broadcast immediately (e.g. when a new peer connects). */
export function broadcastNow(): Promise<void> {
  return _broadcast();
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
    // We only advertise compute as actually available when sharing is enabled
    // AND a model is loaded in the embedded engine. Otherwise a peer's picker
    // would let them select us → request would immediately fail.
    const canActuallyServe = _computeAvailable && models.length > 0;
    const prevModels = _lastBroadcast.loadedModels.join(",");
    const nextModels = models.join(",");
    _lastBroadcast = {
      loadedModels: models,
      computeAvailable: canActuallyServe,
      gpuUtilization: _currentLoad,
      queueDepth: _queueDepth,
      timestamp: Date.now(),
    };
    networkSwarm.broadcastLoad({
      gpuUtilization: _currentLoad,
      loadedModels: models,
      computeAvailable: canActuallyServe,
      queueDepth: _queueDepth,
    });
    // Only log when something interesting changed — keeps the log readable
    // across the 2-second tick rate.
    if (prevModels !== nextModels) {
      logger.info(
        `Broadcasting LOAD_UPDATE: share=${canActuallyServe} models=[${nextModels || "(none)"}] gpu=${_currentLoad}%`,
      );
    }
  } catch (err) {
    logger.warn("Broadcast pass failed:", err);
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
  // Only report the model currently loaded in OrianBuilder's embedded engine.
  // That's the only model we'll actually serve over the P2P channel.
  try {
    const embedded = getServerStatus();
    if (embedded.modelLoaded && embedded.modelName) {
      return [embedded.modelName];
    }
  } catch {}
  return [];
}
