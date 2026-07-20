import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ensureExpoAndroidPackage,
  getNativePackagingGateFailure,
} from "./package_native_artifact";

let tempRoot: string;

describe("package_native_artifact Expo config helpers", () => {
  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "orianbuilder-native-package-"),
    );
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("injects android.package into dynamic Expo config before prebuild", async () => {
    const configPath = path.join(tempRoot, "app.config.js");
    await fs.writeFile(
      configPath,
      `module.exports = {
  expo: {
    name: "ExpoApp",
    slug: "expo-app",
    android: {
      adaptiveIcon: {
        foregroundImage: "./assets/adaptive-icon.png",
        backgroundColor: "#ffffff",
      },
    },
  },
};
`,
    );

    await ensureExpoAndroidPackage(
      tempRoot,
      "com.orianbuilder.helloworldandroidapp",
    );

    const updated = await fs.readFile(configPath, "utf8");
    expect(updated).toContain(
      'package: "com.orianbuilder.helloworldandroidapp"',
    );
    expect(updated).toContain("adaptiveIcon");
  });
});

describe("package_native_artifact execution gates", () => {
  it("blocks Electron packaging when browser QA failed", () => {
    const failure = getNativePackagingGateFailure({
      target: "electron_desktop",
      lastBrowserQaStatus: "failed",
    });

    expect(failure?.error).toContain("browser_qa_gate status is failed");
  });

  it("blocks every target while a command failure is unresolved", () => {
    for (const target of ["electron_desktop", "android_apk"] as const) {
      const failure = getNativePackagingGateFailure({
        target,
        lastBrowserQaStatus: "passed",
        unresolvedCommandFailure: {
          command: "pnpm add electron",
          exitCode: 1,
        },
      });
      expect(failure?.error).toContain("unresolved command failure");
    }
  });

  it("allows Electron packaging after browser QA passes", () => {
    expect(
      getNativePackagingGateFailure({
        target: "electron_desktop",
        lastBrowserQaStatus: "passed",
      }),
    ).toBeNull();
  });
});
