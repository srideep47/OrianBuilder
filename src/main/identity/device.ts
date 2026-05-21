import os from "node:os";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { deviceIdentity } from "@/db/schema";
import { getOrCreateKeypair } from "./keypair";
import { getCachedHardwareProfile } from "@/main/hardware/detect";
import type { DeviceIdentity } from "@/ipc/types/identity";

export async function getDeviceIdentity(): Promise<DeviceIdentity> {
  const keypair = await getOrCreateKeypair();
  const rows = db.select().from(deviceIdentity).limit(1).all();

  let deviceName = os.hostname();
  let deviceType: "desktop" | "laptop" | "server" = "desktop";

  if (rows.length > 0) {
    deviceName = rows[0].deviceName;
    deviceType = rows[0].deviceType as "desktop" | "laptop" | "server";
  }

  const hardware = await getCachedHardwareProfile().catch(() => null);

  return {
    publicKey: keypair.publicKey,
    fingerprint: keypair.fingerprint,
    deviceName,
    deviceType,
    hardware: hardware
      ? {
          cpu: hardware.cpu.model,
          ramGB: Math.round(hardware.totalRamMb / 1024),
          gpu: hardware.primaryGpu?.model ?? "Unknown",
          vramGB: Math.round((hardware.primaryGpu?.vramMb ?? 0) / 1024),
        }
      : null,
  };
}

export async function updateDevice(params: {
  deviceName?: string;
  deviceType?: "desktop" | "laptop" | "server";
}): Promise<DeviceIdentity> {
  await getOrCreateKeypair(); // ensure row exists
  const rows = db.select().from(deviceIdentity).limit(1).all();
  if (!rows.length) throw new Error("No device identity found");

  const updateRow = rows[0];
  const updates: {
    deviceName?: string;
    deviceType?: "desktop" | "laptop" | "server";
  } = {};
  if (params.deviceName !== undefined) updates.deviceName = params.deviceName;
  if (params.deviceType !== undefined) updates.deviceType = params.deviceType;

  if (Object.keys(updates).length > 0) {
    db.update(deviceIdentity)
      .set(updates)
      .where(eq(deviceIdentity.id, updateRow.id))
      .run();
  }

  return getDeviceIdentity();
}
