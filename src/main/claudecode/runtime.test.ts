import { describe, expect, it } from "vitest";

import { claudeExecutableCandidates } from "./runtime";

/**
 * The "not installed or signed in" bug, as a test.
 *
 * `claude --version` worked in a terminal while Orion reported the CLI missing,
 * for two reasons that only bite on Windows:
 *
 *   - the npm bin directory holds `claude`, `claude.cmd` and `claude.ps1`, none
 *     of which `CreateProcess` can launch, so the bare-name fallback failed even
 *     though the shim was on PATH;
 *   - under nvm4w the global package lives beside the active Node version, not
 *     under `%APPDATA%\npm`, which was the only place being checked.
 *
 * Found by a live delegation run refusing to start.
 */
describe("claudeExecutableCandidates", () => {
  const WINDOWS_ENV = {
    APPDATA: "C:\\Users\\dev\\AppData\\Roaming",
    PATH: "C:\\nvm4w\\nodejs;C:\\Windows\\system32",
  } satisfies NodeJS.ProcessEnv;

  it("looks for the package's real executable beside every PATH entry", () => {
    const candidates = claudeExecutableCandidates(WINDOWS_ENV, "win32");
    expect(candidates).toContain(
      "C:\\nvm4w\\nodejs\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe",
    );
  });

  it("still checks npm's user-global location", () => {
    expect(claudeExecutableCandidates(WINDOWS_ENV, "win32")).toContain(
      "C:\\Users\\dev\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe",
    );
  });

  it("prefers an explicit override above everything else", () => {
    const candidates = claudeExecutableCandidates(
      { ...WINDOWS_ENV, CLAUDE_CODE_EXECUTABLE: "D:\\tools\\claude.exe" },
      "win32",
    );
    expect(candidates[0]).toBe("D:\\tools\\claude.exe");
  });

  it("prefers the package binary over the unlaunchable shim directory", () => {
    // Order matters: `C:\nvm4w\nodejs\claude.exe` does not exist, but if it did
    // it would still be the shim's directory. The package binary is the one that
    // is guaranteed to be a real executable.
    const candidates = claudeExecutableCandidates(WINDOWS_ENV, "win32");
    const packageIndex = candidates.indexOf(
      "C:\\nvm4w\\nodejs\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe",
    );
    const shimIndex = candidates.indexOf("C:\\nvm4w\\nodejs\\claude.exe");
    expect(packageIndex).toBeGreaterThanOrEqual(0);
    expect(shimIndex).toBeGreaterThan(packageIndex);
  });

  it("uses the platform's own separator and executable name", () => {
    const candidates = claudeExecutableCandidates(
      { PATH: "/usr/local/bin:/usr/bin" },
      "linux",
    );
    expect(candidates).toContain(
      "/usr/local/bin/node_modules/@anthropic-ai/claude-code/bin/claude",
    );
    expect(candidates).toContain("/usr/bin/claude");
    expect(candidates.some((entry) => entry.endsWith(".exe"))).toBe(false);
  });

  it("does not repeat a candidate when PATH does", () => {
    const candidates = claudeExecutableCandidates(
      { PATH: "/usr/bin:/usr/bin" },
      "linux",
    );
    expect(new Set(candidates).size).toBe(candidates.length);
  });

  it("survives an empty environment without throwing", () => {
    expect(claudeExecutableCandidates({}, "win32")).toEqual([]);
  });

  it("ignores empty and whitespace PATH entries", () => {
    const candidates = claudeExecutableCandidates(
      { PATH: "/usr/bin::  " },
      "linux",
    );
    expect(candidates).toEqual([
      "/usr/bin/node_modules/@anthropic-ai/claude-code/bin/claude",
      "/usr/bin/claude",
    ]);
  });
});
