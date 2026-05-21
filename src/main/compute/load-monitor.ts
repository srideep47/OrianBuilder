/**
 * Polls GPU/CPU utilization from the embedded inference server and broadcasts
 * live load stats to all connected peers every 2 seconds.
 */

import log from "electron-log";
import { networkSwarm } from "@/main/network/swarm";

const logger = log.scope("compute:load-monitor");

let _interval: ReturnType<typeof setInterval> | null = null;
let _currentLoad = 0;
let _loadedModels: string[] = [];
let _computeAvailable = false;
let _queueDepth = 0;

export function setComputeAvailable(enabled: boolean): void {
  _computeAvailable = enabled;
}

export function setLoadedModels(models: string[]): void {
  _loadedModels = models;
}

export function setQueueDepth(depth: number): void {
  _queueDepth = depth;
}

export function getCurrentLoad(): number {
  return _currentLoad;
}

export function startLoadMonitor(): void {
  if (_interval) return;
  _interval = setInterval(() => _broadcast(), 2000);
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
    // Try to get GPU utilization from embedded server stats
    _currentLoad = await _pollGpuUtilization();
    networkSwarm.broadcastLoad({
      gpuUtilization: _currentLoad,
      loadedModels: _loadedModels,
      computeAvailable: _computeAvailable,
      queueDepth: _queueDepth,
    });
  } catch {
    // Silently ignore — not critical
  }
}

async function _pollGpuUtilization(): Promise<number> {
  try {
    // Query the embedded inference server stats endpoint
    const res = await fetch("http://127.0.0.1:11435/metrics", {
      signal: AbortSignal.timeout(500),
    });
    if (!res.ok) return _currentLoad;
    const text = await res.text();
    // Parse prometheus-style metric: llamacpp:kv_cache_usage_ratio
    const match = text.match(/llamacpp:tokens_per_second\s+([\d.]+)/);
    if (match) {
      // Convert tokens/sec to approximate GPU % (heuristic)
      const tps = parseFloat(match[1]);
      return Math.min(100, Math.round(tps * 2));
    }
    return _currentLoad;
  } catch {
    return _currentLoad;
  }
}
