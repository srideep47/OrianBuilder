import { describe, expect, it } from "vitest";

import { __testing__ } from "../pro/main/ipc/handlers/local_agent/tools/package_native_artifact";

const { isUnpackedOutputDir, HELPER_BINARY_NAMES } = __testing__;

describe("package_native_artifact: artifact filter", () => {
  describe("isUnpackedOutputDir", () => {
    it("rejects electron-builder unpacked subdirectories", () => {
      for (const name of [
        "win-unpacked",
        "win-ia32-unpacked",
        "linux-unpacked",
        "mac-arm64-unpacked",
        "mac",
        "mac-arm64",
        "linux",
        "linux-arm64",
      ]) {
        expect(isUnpackedOutputDir(name), name).toBe(true);
      }
    });

    it("does not reject normal release/output directories", () => {
      for (const name of [
        "release",
        "out",
        "dist",
        "dist_electron",
        "make",
        "squirrel.windows",
        "x64",
        "build",
      ]) {
        expect(isUnpackedOutputDir(name), name).toBe(false);
      }
    });
  });

  describe("HELPER_BINARY_NAMES", () => {
    it("lists the electron-builder/forge helper binaries we want to skip", () => {
      // These were the binaries that previously shipped as the "Windows
      // installer" download because the artifact walker grabbed every .exe
      // it found under release/.
      expect(HELPER_BINARY_NAMES.has("elevate.exe")).toBe(true);
      expect(HELPER_BINARY_NAMES.has("squirrel.exe")).toBe(true);
      expect(HELPER_BINARY_NAMES.has("update.exe")).toBe(true);
      expect(HELPER_BINARY_NAMES.has("chrome_crashpad_handler.exe")).toBe(true);
    });

    it("matches case-insensitively (the set keys are lowercase; callers must lowercase before lookup)", () => {
      expect(HELPER_BINARY_NAMES.has("Elevate.exe".toLowerCase())).toBe(true);
      expect(HELPER_BINARY_NAMES.has("ELEVATE.EXE".toLowerCase())).toBe(true);
    });

    it("does not match real installer names", () => {
      for (const name of [
        "OrianBuilder Electron App 0.0.1.exe",
        "MyApp Setup 1.2.3.exe",
        "WalkingPig-portable-0.0.1.exe",
      ]) {
        expect(HELPER_BINARY_NAMES.has(name.toLowerCase()), name).toBe(false);
      }
    });
  });
});
