import log from "electron-log";
import {
  getCachedHardwareProfile,
  detectHardwareProfile,
} from "../../main/hardware/detect";
import { hardwareContracts } from "../types/hardware";
import { createTypedHandler } from "./base";

const logger = log.scope("hardware-handlers");

export function registerHardwareHandlers(): void {
  createTypedHandler(hardwareContracts.getProfile, async () => {
    return getCachedHardwareProfile();
  });

  createTypedHandler(hardwareContracts.refreshProfile, async () => {
    logger.info("Refreshing hardware profile on demand");
    return detectHardwareProfile();
  });
}
