import { computeContracts } from "../types/compute";
import { createTypedHandler } from "./base";
import {
  getComputeTarget,
  setComputeTarget,
  getAvailableNodes,
} from "@/main/compute/routing";
import {
  startProxy,
  setProxyTarget,
  PROXY_PORT,
} from "@/main/compute/compute-proxy";
import {
  setComputeAvailable,
  startLoadMonitor,
  stopLoadMonitor,
} from "@/main/compute/load-monitor";
import { getActiveRequestCount } from "@/main/compute/compute-node";
import { getCachedHardwareProfile } from "@/main/hardware/detect";
import log from "electron-log";

const logger = log.scope("compute:handlers");

let _shareEnabled = false;
let _maxConcurrent = 1;

export function registerComputeHandlers(): void {
  // Start load monitor and proxy on registration
  startLoadMonitor();
  startProxy();

  createTypedHandler(computeContracts.getAvailableNodes, async (_event) => {
    const hw = await getCachedHardwareProfile().catch(() => null);
    const selfHardware = hw
      ? {
          cpu: hw.cpu.model,
          ramGB: Math.round(hw.totalRamMb / 1024),
          gpu: hw.primaryGpu?.model ?? "Unknown",
          vramGB: Math.round((hw.primaryGpu?.vramMb ?? 0) / 1024),
        }
      : null;
    return getAvailableNodes(selfHardware);
  });

  createTypedHandler(computeContracts.getTarget, async (_event) => {
    return getComputeTarget();
  });

  createTypedHandler(computeContracts.setTarget, async (_event, input) => {
    setComputeTarget(input);

    if (input.mode === "peer" && input.peerId) {
      setProxyTarget(input.peerId);
      logger.info(`Compute routed to peer ${input.peerId.slice(0, 16)}…`);
      return { success: true, proxyActive: true };
    }

    setProxyTarget(null);
    return { success: true, proxyActive: false };
  });

  createTypedHandler(computeContracts.setSharing, async (_event, input) => {
    _shareEnabled = input.enabled;
    _maxConcurrent = input.maxConcurrent;
    setComputeAvailable(input.enabled);

    if (input.enabled) {
      startLoadMonitor();
    } else {
      stopLoadMonitor();
    }

    logger.info(`Compute sharing ${input.enabled ? "enabled" : "disabled"}`);
    return { success: true };
  });

  createTypedHandler(computeContracts.getShareStatus, async (_event) => {
    return {
      enabled: _shareEnabled,
      maxConcurrent: _maxConcurrent,
      activeRequestCount: getActiveRequestCount(),
      proxyPort: PROXY_PORT,
    };
  });
}
