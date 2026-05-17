import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureExpoAndroidPackage } from "./package_native_artifact";

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
