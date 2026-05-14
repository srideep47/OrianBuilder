import log from "electron-log";
import {
  getCachedHardwareProfile,
  detectHardwareProfile,
} from "../../main/hardware/detect";
import { initMediaAiHardware } from "../utils/media_ai_backend";
import { hardwareContracts } from "../types/hardware";
import { createTypedHandler } from "./base";

const logger = log.scope("hardware-handlers");

export function registerHardwareHandlers(): void {
  // Detect hardware once at registration time and seed the media backend so
  // the Python subprocess receives ORIANBUILDER_HARDWARE_BACKEND / VRAM env
  // vars on first spawn.
  void detectHardwareProfile()
    .then((profile) => initMediaAiHardware(profile))
    .catch((err) => logger.warn("Initial hardware detection failed:", err));

  createTypedHandler(hardwareContracts.getProfile, async () => {
    return getCachedHardwareProfile();
  });

  createTypedHandler(hardwareContracts.refreshProfile, async () => {
    logger.info("Refreshing hardware profile on demand");
    const profile = await detectHardwareProfile();
    initMediaAiHardware(profile);
    return profile;
  });
}
