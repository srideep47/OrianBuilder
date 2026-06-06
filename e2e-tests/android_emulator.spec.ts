import { expect } from "@playwright/test";
import { test } from "./helpers/test_helper";

/**
 * Verifies the self-managed Android test runner's status IPC handler returns a
 * valid shape. This does not download the SDK or boot an emulator (~1.5 GB);
 * it only asserts the handler is registered and reports a well-formed status.
 */
test("android_emulator:getStatus returns a valid shape", async ({ po }) => {
  await po.setUp();

  const status = await po.page.evaluate(async () => {
    return (window as any).electron.ipcRenderer.invoke(
      "android_emulator:getStatus",
    );
  });

  expect(status).toBeTruthy();
  expect(typeof status.sdkReady).toBe("boolean");
  expect(typeof status.imageReady).toBe("boolean");
  expect(typeof status.emulatorRunning).toBe("boolean");
  // avdName is either a string or null.
  expect(status.avdName === null || typeof status.avdName === "string").toBe(
    true,
  );
});
