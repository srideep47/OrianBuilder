import { identityContracts } from "../types/identity";
import { createTypedHandler } from "./base";
import { getDeviceIdentity, updateDevice } from "@/main/identity/device";
import { resetKeypair } from "@/main/identity/keypair";

export function registerIdentityHandlers(): void {
  createTypedHandler(identityContracts.get, async (_event) => {
    return getDeviceIdentity();
  });

  createTypedHandler(identityContracts.updateDevice, async (_event, input) => {
    return updateDevice(input);
  });

  createTypedHandler(identityContracts.reset, async (_event) => {
    await resetKeypair();
    return getDeviceIdentity();
  });
}
