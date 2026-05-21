import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const ANDROID_STUDIO_JBR_DEFAULT =
  "C:\\Program Files\\Android\\Android Studio\\jbr";

export interface AndroidEnvStatus {
  sdkRoot: string | null;
  ndkVersion: string | null;
  jbrPath: string | null;
  issues: string[];
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function resolveAndroidSdkRoot(): Promise<string | null> {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.platform === "win32" && process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "Android", "Sdk")
      : null,
    process.platform === "win32"
      ? path.join(os.homedir(), "AppData", "Local", "Android", "Sdk")
      : null,
    process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Android", "sdk")
      : null,
    process.platform === "linux"
      ? path.join(os.homedir(), "Android", "Sdk")
      : null,
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of new Set(candidates)) {
    if (await exists(candidate)) return candidate;
  }
  return null;
}

function compareAndroidVersionNames(a: string, b: string): number {
  const aParts = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const bParts = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i += 1) {
    const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return a.localeCompare(b);
}

export async function findUsableNdkVersion(
  sdkDir: string,
): Promise<string | null> {
  const ndkRoot = path.join(sdkDir, "ndk");
  let entries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    entries = await fs.readdir(ndkRoot, { withFileTypes: true });
  } catch {
    return null;
  }

  const valid: string[] = [];
  for (const entry of entries) {
    if (
      entry.isDirectory() &&
      (await exists(path.join(ndkRoot, entry.name, "source.properties")))
    ) {
      valid.push(entry.name);
    }
  }
  if (valid.length === 0) return null;

  const major27 = valid
    .filter((v) => v.startsWith("27."))
    .sort(compareAndroidVersionNames);
  if (major27.length > 0) return major27.at(-1) ?? null;
  return valid.sort(compareAndroidVersionNames).at(-1) ?? null;
}

export async function findAndroidSdkCMakeDir(
  sdkDir: string,
): Promise<string | null> {
  const cmakeRoot = path.join(sdkDir, "cmake");
  let entries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    entries = await fs.readdir(cmakeRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  const versions = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => /^\d/.test(name))
    .sort(compareAndroidVersionNames);
  const chosen = versions.at(-1);
  if (!chosen) return null;
  const dir = path.join(cmakeRoot, chosen);
  const bin =
    process.platform === "win32"
      ? path.join(dir, "bin", "cmake.exe")
      : path.join(dir, "bin", "cmake");
  return (await exists(bin)) ? dir : null;
}

export async function checkAndroidEnv(): Promise<AndroidEnvStatus> {
  const issues: string[] = [];
  const sdkRoot = await resolveAndroidSdkRoot();
  if (!sdkRoot) {
    issues.push(
      "Android SDK not found. Install Android Studio or set ANDROID_HOME to your SDK directory.",
    );
    return { sdkRoot: null, ndkVersion: null, jbrPath: null, issues };
  }

  const ndkVersion = await findUsableNdkVersion(sdkRoot);
  if (!ndkVersion) {
    issues.push(
      `Android NDK not found under ${path.join(sdkRoot, "ndk")}. Install an NDK side-by-side package via Android Studio SDK Manager (NDK 27.x recommended).`,
    );
  }

  const jbrPath = (await exists(ANDROID_STUDIO_JBR_DEFAULT))
    ? ANDROID_STUDIO_JBR_DEFAULT
    : null;
  if (!jbrPath && process.platform === "win32") {
    issues.push(
      `Android Studio JBR not found at ${ANDROID_STUDIO_JBR_DEFAULT}. Install Android Studio (default location) or ensure a compatible JDK is on PATH.`,
    );
  }

  return { sdkRoot, ndkVersion, jbrPath, issues };
}

export function formatAndroidEnvStatus(status: AndroidEnvStatus): string {
  if (status.issues.length === 0) {
    return `Android env OK — SDK=${status.sdkRoot}, NDK=${status.ndkVersion}${
      status.jbrPath ? `, JBR=${status.jbrPath}` : ""
    }.`;
  }
  return [
    "Android env issues detected — APK packaging will fail until resolved (web preview still works):",
    ...status.issues.map((line) => `- ${line}`),
  ].join("\n");
}
