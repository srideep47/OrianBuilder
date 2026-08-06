/**
 * The relocation pointer must never override an explicit `--user-data-dir`.
 *
 * Regression test for a bug that made the whole E2E suite non-hermetic: on a
 * machine with a relocated data directory, Playwright's per-run temp profile
 * was silently discarded and every spec ran against the developer's real
 * database.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPath: vi.fn(),
  setPath: vi.fn(),
  hasSwitch: vi.fn(),
  readFileSync: vi.fn(),
  statSync: vi.fn(),
  accessSync: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    getPath: mocks.getPath,
    setPath: mocks.setPath,
    commandLine: { hasSwitch: mocks.hasSwitch },
  },
}));

vi.mock("node:fs", () => ({
  default: {
    readFileSync: mocks.readFileSync,
    statSync: mocks.statSync,
    accessSync: mocks.accessSync,
    constants: { W_OK: 2 },
  },
}));

const DEFAULT_USER_DATA = "C:\\Users\\dev\\AppData\\Roaming\\OrianBuilder";
const RELOCATED = "D:\\OrianBuilderData\\orianbuilder";

let originalArgv: string[];

beforeEach(() => {
  vi.resetModules();
  originalArgv = process.argv;
  process.argv = ["electron.exe", "main.js"];

  mocks.getPath.mockImplementation((name: string) =>
    name === "userData"
      ? DEFAULT_USER_DATA
      : "C:\\Users\\dev\\AppData\\Roaming",
  );
  mocks.setPath.mockReset();
  mocks.hasSwitch.mockReturnValue(false);
  mocks.readFileSync.mockReturnValue(
    JSON.stringify({ userDataPath: RELOCATED }),
  );
  mocks.statSync.mockReturnValue({ isDirectory: () => true });
  mocks.accessSync.mockReturnValue(undefined);
});

afterEach(() => {
  process.argv = originalArgv;
});

async function applyRelocation() {
  const mod = await import("./user_data_location");
  mod.applyUserDataRelocation();
}

describe("applyUserDataRelocation", () => {
  it("relocates when a valid pointer exists and no switch was passed", async () => {
    await applyRelocation();
    expect(mocks.setPath).toHaveBeenCalledWith("userData", RELOCATED);
    expect(mocks.setPath).toHaveBeenCalledWith("sessionData", RELOCATED);
  });

  it("ignores the pointer when --user-data-dir is in argv", async () => {
    // Playwright's Electron fixture passes it this way, and argv is the only
    // honest signal that a *launcher* chose the profile directory.
    process.argv = [
      "electron.exe",
      "main.js",
      "--user-data-dir=C:\\Temp\\orianbuilder-e2e-tests-123",
    ];
    await applyRelocation();
    expect(mocks.setPath).not.toHaveBeenCalled();
  });

  it("does NOT consult app.commandLine.hasSwitch", async () => {
    // Regression test for a bug that silently sent every relocated install
    // back to the default profile. Chromium populates its own command line
    // with a resolved `--user-data-dir` on every launch, so `hasSwitch` is
    // true even when nobody passed one; consulting it meant the pointer was
    // skipped *always*, and the user's projects, settings, chat history and
    // models appeared to have vanished.
    //
    // The first version of this test mocked `hasSwitch` to return true and
    // asserted relocation was skipped — encoding the bug as the requirement,
    // which is why it passed while the app was broken.
    mocks.hasSwitch.mockImplementation((s: string) => s === "user-data-dir");
    await applyRelocation();
    expect(mocks.setPath).toHaveBeenCalledWith("userData", RELOCATED);
    expect(mocks.hasSwitch).not.toHaveBeenCalled();
  });

  it("stays on the default when there is no pointer", async () => {
    mocks.readFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    await applyRelocation();
    expect(mocks.setPath).not.toHaveBeenCalled();
  });

  it("stays on the default when the target is not writable", async () => {
    mocks.accessSync.mockImplementation(() => {
      throw new Error("EACCES");
    });
    await applyRelocation();
    expect(mocks.setPath).not.toHaveBeenCalled();
  });
});
