/**
 * Self-managed Android SDK + emulator runner.
 *
 * OrianBuilder auto-downloads the *minimal* Android SDK components needed to
 * boot an emulator and install an APK — no pre-installed Android Studio / SDK
 * required from the user. This mirrors the way the llama-server binary is
 * fetched at runtime (see src/main/llm/llama_server_downloader.ts).
 *
 * Managed layout (under app.getPath("userData")/android-sdk/):
 *   platform-tools/adb[.exe]
 *   emulator/emulator[.exe]
 *   system-images/android-34/google_apis_playstore/x86_64/system.img
 *   avd/OrianBuilderTest.{ini,avd/}
 *
 * If the user already has a working SDK (ANDROID_HOME / ANDROID_SDK_ROOT with
 * adb + emulator) we reuse it and skip the download entirely.
 *
 * Hardware acceleration: the emulator picks WHPX (Windows) / HVF (macOS) /
 * KVM (Linux) automatically via `-accel auto`.
 */

import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { app } from "electron";

import {
  OrianBuilderError,
  OrianBuilderErrorKind,
} from "@/errors/orianbuilder_error";
import { resolveAndroidSdkRoot } from "@/pro/main/ipc/handlers/local_agent/tools/android_env";
import { readSettings } from "@/main/settings";

// The Android runtime needs ~1.5 GB for the download plus ~6 GB once the system
// image is extracted. Require ~9 GB free (with headroom) before installing so
// we never fill a volume mid-extraction.
const ANDROID_RUNTIME_MIN_FREE_BYTES = 9 * 1024 ** 3;

// =============================================================================
// Constants
// =============================================================================

const REPO_BASE = "https://dl.google.com/android/repository/";
const REPO_MANIFEST = `${REPO_BASE}repository2-3.xml`;
const SYSIMG_BASE = `${REPO_BASE}sys-img/google_apis_playstore/`;
const SYSIMG_MANIFEST = `${SYSIMG_BASE}sys-img2-3.xml`;

const API_LEVEL = "34";
const SYSTEM_IMAGE_TAG = "google_apis_playstore";
const SYSTEM_IMAGE_ABI = "x86_64";
const SYSTEM_IMAGE_PACKAGE = `system-images;android-${API_LEVEL};${SYSTEM_IMAGE_TAG};${SYSTEM_IMAGE_ABI}`;

export const MANAGED_AVD_NAME = "OrianBuilderTest";

// =============================================================================
// Types
// =============================================================================

export type AndroidSetupStage =
  | "resolving"
  | "platform-tools"
  | "emulator"
  | "system-image"
  | "avd"
  | "done";

export interface AndroidSetupProgress {
  stage: AndroidSetupStage;
  label: string;
  percent: number;
  bytesDownloaded: number;
  totalBytes: number;
}

export interface AndroidEmulatorStatus {
  sdkReady: boolean;
  imageReady: boolean;
  emulatorRunning: boolean;
  avdName: string | null;
}

type ProgressCallback = (progress: AndroidSetupProgress) => void;

// =============================================================================
// Path resolution
// =============================================================================

/**
 * Free bytes available on the volume that contains `targetPath` (or its drive
 * root if the path does not exist yet). Returns +Infinity when the platform
 * can't report it, so callers degrade gracefully rather than blocking.
 */
function freeBytesAt(targetPath: string): number {
  try {
    const probe = fileExists(targetPath)
      ? targetPath
      : path.parse(targetPath).root;
    const stat = fs.statfsSync(probe);
    return stat.bavail * stat.bsize;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Windows only: pick the local drive root (C:\, D:\, …) with the most free
 * space that still clears `minFreeBytes`. Returns null when none qualify.
 */
function bestWritableVolumeWin(minFreeBytes: number): string | null {
  let best: { root: string; free: number } | null = null;
  for (let code = 67 /* C */; code <= 90 /* Z */; code++) {
    const root = `${String.fromCharCode(code)}:\\`;
    if (!fileExists(root)) continue;
    const free = freeBytesAt(root);
    if (free >= minFreeBytes && (!best || free > best.free)) {
      best = { root, free };
    }
  }
  return best ? best.root : null;
}

export function getManagedSdkRoot(): string {
  // Honor an explicit, persisted choice — but only if the runtime is already
  // installed there or its volume can still hold it. This lets a stale path
  // (e.g. one pinned to a now-full drive) self-heal to a roomier volume below
  // instead of repeatedly failing to install.
  const override = readSettings().androidSdkManagedPath;
  if (
    override &&
    (hasSystemImage(override) ||
      freeBytesAt(override) >= ANDROID_RUNTIME_MIN_FREE_BYTES)
  ) {
    return override;
  }

  const def = path.join(app.getPath("userData"), "android-sdk");
  // userData usually lives on the system drive (e.g. C:), which is often too
  // full to hold the ~8 GB runtime. When it can't fit, fall back to the local
  // volume with the most free space so the install doesn't silently fail
  // mid-extraction.
  if (process.platform === "win32") {
    const defRoot = path.parse(def).root;
    if (freeBytesAt(defRoot) < ANDROID_RUNTIME_MIN_FREE_BYTES) {
      const best = bestWritableVolumeWin(ANDROID_RUNTIME_MIN_FREE_BYTES);
      if (best && best.toLowerCase() !== defRoot.toLowerCase()) {
        return path.join(best, "OrianBuilder", "android-sdk");
      }
    }
  }
  return def;
}

const exe = (name: string): string =>
  process.platform === "win32" ? `${name}.exe` : name;

function adbPath(sdkRoot: string): string {
  return path.join(sdkRoot, "platform-tools", exe("adb"));
}

function emulatorPath(sdkRoot: string): string {
  return path.join(sdkRoot, "emulator", exe("emulator"));
}

function systemImageDir(sdkRoot: string): string {
  return path.join(
    sdkRoot,
    "system-images",
    `android-${API_LEVEL}`,
    SYSTEM_IMAGE_TAG,
    SYSTEM_IMAGE_ABI,
  );
}

function avdHomeDir(sdkRoot: string): string {
  return path.join(sdkRoot, "avd");
}

function fileExists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function hasPlatformTools(sdkRoot: string): boolean {
  return fileExists(adbPath(sdkRoot));
}

function hasEmulator(sdkRoot: string): boolean {
  return fileExists(emulatorPath(sdkRoot));
}

/**
 * Locate any installed system image under the SDK — any API level / tag / ABI
 * (google_apis_playstore, google_apis, default, …). We deliberately don't
 * require a specific tag so that a user's pre-existing SDK image is recognized
 * instead of triggering an unnecessary download.
 */
function findAnySystemImage(sdkRoot: string): string | null {
  const base = path.join(sdkRoot, "system-images");
  let apis: string[];
  try {
    apis = fs.readdirSync(base);
  } catch {
    return null;
  }
  for (const api of apis) {
    let tags: string[];
    try {
      tags = fs.readdirSync(path.join(base, api));
    } catch {
      continue;
    }
    for (const tag of tags) {
      let abis: string[];
      try {
        abis = fs.readdirSync(path.join(base, api, tag));
      } catch {
        continue;
      }
      for (const abi of abis) {
        if (fileExists(path.join(base, api, tag, abi, "system.img"))) {
          return path.join(base, api, tag, abi, "system.img");
        }
      }
    }
  }
  return null;
}

function hasSystemImage(sdkRoot: string): boolean {
  return findAnySystemImage(sdkRoot) !== null;
}

/**
 * Resolve which SDK root to use. Prefers a complete user-installed SDK
 * (ANDROID_HOME etc.) so we don't redownload ~1.5 GB; otherwise falls back to
 * the OrianBuilder-managed directory used as the download target.
 */
export async function resolveActiveSdkRoot(): Promise<{
  root: string;
  managed: boolean;
}> {
  const userSdk = await resolveAndroidSdkRoot();
  if (userSdk && hasPlatformTools(userSdk) && hasEmulator(userSdk)) {
    return { root: userSdk, managed: false };
  }
  return { root: getManagedSdkRoot(), managed: true };
}

// =============================================================================
// Network helpers (ported from llama_server_downloader.ts)
// =============================================================================

async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": "orianbuilder-android-sdk-downloader" },
    redirect: "follow",
    signal,
  });
  if (!res.ok) {
    throw new OrianBuilderError(
      `GET ${url} → ${res.status} ${res.statusText}`,
      OrianBuilderErrorKind.External,
    );
  }
  return res.text();
}

async function fetchToFile(
  url: string,
  destPath: string,
  onProgress?: (bytesDownloaded: number, totalBytes: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(url, {
    headers: { "User-Agent": "orianbuilder-android-sdk-downloader" },
    redirect: "follow",
    signal,
  });
  if (!res.ok || !res.body) {
    throw new OrianBuilderError(
      `GET ${url} → ${res.status} ${res.statusText}`,
      OrianBuilderErrorKind.External,
    );
  }
  const totalBytes = parseInt(res.headers.get("content-length") ?? "0", 10);
  let bytesDownloaded = 0;

  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });

  const tracker = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytesDownloaded += chunk.length;
      onProgress?.(bytesDownloaded, totalBytes);
      this.push(chunk);
      cb();
    },
  });

  await pipeline(
    Readable.fromWeb(res.body as any),
    tracker,
    fs.createWriteStream(destPath),
  );
}

function unzip(archivePath: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (process.platform === "win32") {
      const safeSrc = archivePath.replace(/"/g, '`"');
      const safeDest = destDir.replace(/"/g, '`"');
      const child = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Expand-Archive -LiteralPath "${safeSrc}" -DestinationPath "${safeDest}" -Force`,
        ],
        { stdio: "pipe" },
      );
      child.on("exit", (code) =>
        code === 0
          ? resolve()
          : reject(
              new OrianBuilderError(
                `Expand-Archive exited ${code}`,
                OrianBuilderErrorKind.External,
              ),
            ),
      );
      child.on("error", reject);
      return;
    }
    const child = spawn("unzip", ["-o", "-q", archivePath, "-d", destDir], {
      stdio: "pipe",
    });
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(
            new OrianBuilderError(
              `unzip exited ${code}`,
              OrianBuilderErrorKind.External,
            ),
          ),
    );
    child.on("error", reject);
  });
}

// =============================================================================
// Android repository manifest parsing
// =============================================================================

function hostOsName(): string {
  switch (process.platform) {
    case "win32":
      return "windows";
    case "darwin":
      return "macosx";
    default:
      return "linux";
  }
}

/**
 * Extract the `<remotePackage path="...">…</remotePackage>` block for a given
 * package path from a repository manifest XML.
 */
function extractRemotePackageBlock(
  xml: string,
  packagePath: string,
): string | null {
  // Escape regex metacharacters in the package path (it contains ; chars).
  const escaped = packagePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `<remotePackage[^>]*path="${escaped}"[\\s\\S]*?</remotePackage>`,
  );
  const match = re.exec(xml);
  return match ? match[0] : null;
}

/**
 * Resolve the download URL for the emulator package matching the current host
 * OS from the main repository manifest.
 */
async function resolveEmulatorUrl(signal?: AbortSignal): Promise<string> {
  const xml = await fetchText(REPO_MANIFEST, signal);
  const block = extractRemotePackageBlock(xml, "emulator");
  if (!block) {
    throw new OrianBuilderError(
      "Could not find the 'emulator' package in the Android repository manifest.",
      OrianBuilderErrorKind.External,
    );
  }
  const wantedOs = hostOsName();
  const archiveRe = /<archive>([\s\S]*?)<\/archive>/g;
  let fallbackUrl: string | null = null;
  let archiveMatch: RegExpExecArray | null;
  while ((archiveMatch = archiveRe.exec(block)) !== null) {
    const archive = archiveMatch[1];
    const urlMatch = /<url>([^<]+)<\/url>/.exec(archive);
    if (!urlMatch) continue;
    const url = urlMatch[1];
    const osMatch = /<host-os>([^<]*)<\/host-os>/.exec(archive);
    const archiveOs = osMatch ? osMatch[1] : null;
    if (archiveOs === wantedOs) {
      return REPO_BASE + url;
    }
    // Some emulator archives omit host-os; keep as a last resort.
    if (!archiveOs && !fallbackUrl) {
      fallbackUrl = REPO_BASE + url;
    }
  }
  if (fallbackUrl) return fallbackUrl;
  throw new OrianBuilderError(
    `No emulator archive found for host OS "${wantedOs}".`,
    OrianBuilderErrorKind.External,
  );
}

/**
 * Resolve the download URL for the configured system image from the
 * google_apis_playstore system-image manifest.
 */
async function resolveSystemImageUrl(signal?: AbortSignal): Promise<string> {
  const xml = await fetchText(SYSIMG_MANIFEST, signal);
  const block = extractRemotePackageBlock(xml, SYSTEM_IMAGE_PACKAGE);
  if (!block) {
    throw new OrianBuilderError(
      `Could not find "${SYSTEM_IMAGE_PACKAGE}" in the system-image manifest.`,
      OrianBuilderErrorKind.External,
    );
  }
  // System images ship a single host-agnostic archive; take the first URL.
  const urlMatch =
    /<complete>[\s\S]*?<url>([^<]+)<\/url>[\s\S]*?<\/complete>/.exec(block);
  if (!urlMatch) {
    const anyUrl = /<url>([^<]+)<\/url>/.exec(block);
    if (anyUrl) return SYSIMG_BASE + anyUrl[1];
    throw new OrianBuilderError(
      "No download URL found for the system image archive.",
      OrianBuilderErrorKind.External,
    );
  }
  return SYSIMG_BASE + urlMatch[1];
}

function platformToolsUrl(): string {
  const osTag =
    process.platform === "win32"
      ? "windows"
      : process.platform === "darwin"
        ? "darwin"
        : "linux";
  return `${REPO_BASE}platform-tools-latest-${osTag}.zip`;
}

// =============================================================================
// Status
// =============================================================================

let runningEmulator: ChildProcess | null = null;

export function isEmulatorRunning(): boolean {
  return runningEmulator !== null && runningEmulator.exitCode === null;
}

export async function getEmulatorStatus(): Promise<AndroidEmulatorStatus> {
  const { root } = await resolveActiveSdkRoot();
  const sdkReady = hasPlatformTools(root) && hasEmulator(root);
  const imageReady = hasSystemImage(root);
  // Prefer an AVD the user already has; fall back to our managed one if present.
  const avds = listAvds(root);
  const managedAvdExists = fileExists(
    path.join(avdHomeDir(root), `${MANAGED_AVD_NAME}.ini`),
  );
  const avdName = avds[0] ?? (managedAvdExists ? MANAGED_AVD_NAME : null);
  return {
    sdkReady,
    imageReady,
    emulatorRunning: isEmulatorRunning(),
    avdName,
  };
}

// =============================================================================
// AVD creation
// =============================================================================

/**
 * Create the managed AVD by writing its config files directly. This avoids a
 * dependency on `avdmanager` (which itself requires the cmdline-tools package
 * and a JDK) — keeping the runtime fully self-managed. The emulator is pointed
 * at this AVD via the ANDROID_AVD_HOME env var at launch time.
 */
async function ensureAvd(sdkRoot: string): Promise<void> {
  const avdHome = avdHomeDir(sdkRoot);
  const iniPath = path.join(avdHome, `${MANAGED_AVD_NAME}.ini`);
  const avdDir = path.join(avdHome, `${MANAGED_AVD_NAME}.avd`);

  if (fileExists(iniPath) && fileExists(path.join(avdDir, "config.ini"))) {
    return;
  }

  // Derive the api/tag/abi from whatever system image is actually installed,
  // rather than assuming a specific variant. The image path looks like:
  //   <sdkRoot>/system-images/<api>/<tag>/<abi>/system.img
  const img = findAnySystemImage(sdkRoot);
  if (!img) {
    throw new OrianBuilderError(
      "No Android system image is installed; cannot create a virtual device.",
      OrianBuilderErrorKind.Precondition,
    );
  }
  const abiDir = path.dirname(img);
  const abi = path.basename(abiDir);
  const tag = path.basename(path.dirname(abiDir));
  const apiName = path.basename(path.dirname(path.dirname(abiDir))); // android-34
  // image.sysdir.1 is relative to the SDK root and must end with a separator.
  const sysdir = `${path.relative(sdkRoot, abiDir).split(path.sep).join("/")}/`;
  const cpuArch = abi.startsWith("x86")
    ? abi === "x86"
      ? "x86"
      : "x86_64"
    : "arm64";

  await fs.promises.mkdir(avdDir, { recursive: true });

  const ini = [
    "avd.ini.encoding=UTF-8",
    `path=${avdDir}`,
    `path.rel=avd/${MANAGED_AVD_NAME}.avd`,
    `target=${apiName}`,
    "",
  ].join("\n");
  await fs.promises.writeFile(iniPath, ini, "utf-8");

  const config = [
    `AvdId=${MANAGED_AVD_NAME}`,
    `abi.type=${abi}`,
    "avd.ini.encoding=UTF-8",
    `hw.cpu.arch=${cpuArch}`,
    "hw.cpu.ncore=4",
    "hw.gpu.enabled=yes",
    "hw.gpu.mode=auto",
    "hw.ramSize=2048",
    "hw.keyboard=yes",
    // 4 GB sparse data partition (grows on demand; a cap, not a preallocation).
    "disk.dataPartition.size=4096M",
    `image.sysdir.1=${sysdir}`,
    `PlayStore.enabled=${tag.includes("playstore") ? "true" : "false"}`,
    `tag.id=${tag}`,
    `avd.ini.displayname=${MANAGED_AVD_NAME}`,
    "hw.device.manufacturer=Google",
    "hw.device.name=pixel_5",
    "",
  ].join("\n");
  await fs.promises.writeFile(path.join(avdDir, "config.ini"), config, "utf-8");
}

// =============================================================================
// Setup (download + install)
// =============================================================================

let activeSetup = false;

/**
 * Download and install the minimal SDK components and create the managed AVD.
 * Reports progress throughout. Respects `signal` for cancellation.
 */
export async function setupAndroidSdk(
  onProgress: ProgressCallback,
  signal?: AbortSignal,
): Promise<void> {
  if (activeSetup) {
    throw new OrianBuilderError(
      "Android runtime setup is already in progress.",
      OrianBuilderErrorKind.Conflict,
    );
  }
  activeSetup = true;

  const emit = (
    stage: AndroidSetupStage,
    label: string,
    percent: number,
    bytesDownloaded = 0,
    totalBytes = 0,
  ) => onProgress({ stage, label, percent, bytesDownloaded, totalBytes });

  try {
    emit("resolving", "Checking for an existing Android SDK…", 0);

    // If the user already has a complete SDK, reuse it and just create the AVD.
    const existing = await resolveActiveSdkRoot();
    if (
      !existing.managed &&
      hasPlatformTools(existing.root) &&
      hasEmulator(existing.root) &&
      hasSystemImage(existing.root)
    ) {
      emit("avd", "Creating virtual device…", 98);
      await ensureAvd(existing.root);
      emit("done", "Using existing Android SDK.", 100);
      return;
    }

    const sdkRoot = getManagedSdkRoot();
    await fs.promises.mkdir(sdkRoot, { recursive: true });

    // Fail fast (with a clear, actionable message) if the target volume can't
    // hold the runtime, instead of silently aborting mid-extraction.
    const freeBytes = freeBytesAt(sdkRoot);
    if (freeBytes < ANDROID_RUNTIME_MIN_FREE_BYTES) {
      const neededGb = (ANDROID_RUNTIME_MIN_FREE_BYTES / 1024 ** 3).toFixed(0);
      const freeGb = (freeBytes / 1024 ** 3).toFixed(1);
      throw new OrianBuilderError(
        `Not enough free disk space to install the Android runtime. Need about ${neededGb} GB free on ${path.parse(sdkRoot).root} but only ${freeGb} GB is available. Free up space (or move the install to a drive that has room) and try again.`,
        OrianBuilderErrorKind.Precondition,
      );
    }

    // Stage the download/extraction on the SAME volume as the SDK. The system
    // temp dir can be on a smaller drive, which would fill up during the ~6 GB
    // system-image extraction.
    const tmpDir = await fs.promises.mkdtemp(path.join(sdkRoot, ".dl-"));

    try {
      // ── platform-tools (adb) : 0 → 5 ──────────────────────────────────
      if (!hasPlatformTools(sdkRoot)) {
        emit("platform-tools", "Downloading platform-tools (adb)…", 0);
        const ptArchive = path.join(tmpDir, "platform-tools.zip");
        await fetchToFile(
          platformToolsUrl(),
          ptArchive,
          (bytes, total) => {
            const pct = total > 0 ? (bytes / total) * 5 : 2.5;
            emit(
              "platform-tools",
              "Downloading platform-tools…",
              pct,
              bytes,
              total,
            );
          },
          signal,
        );
        emit("platform-tools", "Extracting platform-tools…", 5);
        await unzip(ptArchive, sdkRoot);
      }

      // ── emulator : 5 → 25 ─────────────────────────────────────────────
      if (!hasEmulator(sdkRoot)) {
        emit("emulator", "Resolving emulator download…", 5);
        const emulatorDownloadUrl = await resolveEmulatorUrl(signal);
        const emArchive = path.join(tmpDir, "emulator.zip");
        await fetchToFile(
          emulatorDownloadUrl,
          emArchive,
          (bytes, total) => {
            const pct = 5 + (total > 0 ? bytes / total : 0.5) * 20;
            emit("emulator", "Downloading emulator…", pct, bytes, total);
          },
          signal,
        );
        emit("emulator", "Extracting emulator…", 25);
        await unzip(emArchive, sdkRoot);
      }

      // ── system image : 25 → 98 (largest, ~1.5 GB) ─────────────────────
      if (!hasSystemImage(sdkRoot)) {
        emit("system-image", "Resolving system image download…", 25);
        const sysImgUrl = await resolveSystemImageUrl(signal);
        const sysArchive = path.join(tmpDir, "system-image.zip");
        await fetchToFile(
          sysImgUrl,
          sysArchive,
          (bytes, total) => {
            const pct = 25 + (total > 0 ? bytes / total : 0.5) * 73;
            emit(
              "system-image",
              "Downloading system image (~1.5 GB)…",
              pct,
              bytes,
              total,
            );
          },
          signal,
        );
        emit("system-image", "Extracting system image…", 98);
        // The archive contains an `x86_64/` top-level dir; extract into the
        // tag directory so it lands at .../google_apis_playstore/x86_64/.
        const tagDir = path.dirname(systemImageDir(sdkRoot));
        await fs.promises.mkdir(tagDir, { recursive: true });
        await unzip(sysArchive, tagDir);

        // Verify extraction actually produced the image. Expand-Archive can
        // exit 0 yet write nothing when the volume fills up, which previously
        // left setup falsely reporting success.
        if (!hasSystemImage(sdkRoot)) {
          throw new OrianBuilderError(
            "The Android system image did not extract correctly (system.img is missing). This usually means the download was incomplete or the disk filled up during extraction.",
            OrianBuilderErrorKind.External,
          );
        }
      }

      // ── AVD : 98 → 100 ────────────────────────────────────────────────
      emit("avd", "Creating virtual device…", 98);
      await ensureAvd(sdkRoot);

      emit("done", "Android runtime ready!", 100);
    } finally {
      await fs.promises
        .rm(tmpDir, { recursive: true, force: true })
        .catch(() => {});
    }
  } finally {
    activeSetup = false;
  }
}

// =============================================================================
// adb / emulator process helpers
// =============================================================================

function runAdb(
  sdkRoot: string,
  args: string[],
  timeoutMs = 120_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(adbPath(sdkRoot), args, {
      stdio: "pipe",
      env: sdkEnv(sdkRoot),
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(
        new OrianBuilderError(
          `adb ${args.join(" ")} timed out after ${timeoutMs}ms`,
          OrianBuilderErrorKind.External,
        ),
      );
    }, timeoutMs);
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

function sdkEnv(sdkRoot: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ANDROID_HOME: sdkRoot,
    ANDROID_SDK_ROOT: sdkRoot,
  };
}

/**
 * List the AVDs the emulator can see — the user's own AVDs in the default
 * ~/.android/avd home (e.g. "Pixel_8" created in Android Studio). Best-effort:
 * returns [] if the emulator can't be queried.
 */
function listAvds(sdkRoot: string): string[] {
  try {
    const res = spawnSync(emulatorPath(sdkRoot), ["-list-avds"], {
      env: sdkEnv(sdkRoot),
      timeout: 15_000,
      encoding: "utf-8",
    });
    if (res.status !== 0 || !res.stdout) return [];
    return res.stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function waitForBoot(
  sdkRoot: string,
  timeoutMs = 300_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // First, wait for the device to register with adb.
  await runAdb(sdkRoot, ["wait-for-device"], timeoutMs);
  // Then poll until the system finishes booting.
  while (Date.now() < deadline) {
    const { stdout } = await runAdb(
      sdkRoot,
      ["shell", "getprop", "sys.boot_completed"],
      30_000,
    ).catch(() => ({ stdout: "", code: -1, stderr: "" }));
    if (stdout.trim() === "1") return;
    await new Promise((r) => setTimeout(r, 3_000));
  }
  throw new OrianBuilderError(
    "Timed out waiting for the Android emulator to finish booting.",
    OrianBuilderErrorKind.External,
  );
}

// =============================================================================
// Launch + install
// =============================================================================

export async function launchAndInstall(params: {
  apkPath: string;
  packageId?: string | null;
}): Promise<void> {
  const { apkPath, packageId } = params;
  const { root: sdkRoot } = await resolveActiveSdkRoot();

  if (!hasPlatformTools(sdkRoot) || !hasEmulator(sdkRoot)) {
    throw new OrianBuilderError(
      "Android runtime is not set up. Download it first.",
      OrianBuilderErrorKind.Precondition,
    );
  }
  if (!hasSystemImage(sdkRoot)) {
    throw new OrianBuilderError(
      "Android system image is missing. Download the runtime first.",
      OrianBuilderErrorKind.Precondition,
    );
  }
  if (!fileExists(apkPath)) {
    throw new OrianBuilderError(
      `APK not found at ${apkPath}.`,
      OrianBuilderErrorKind.NotFound,
    );
  }

  // Prefer our managed AVD created under the SDK's own avd/ dir. The SDK lives
  // on the volume we picked for free space, so the emulator's writable data
  // (userdata-qemu.img etc.) lands there too — instead of on a user AVD that
  // may sit on a full system drive and crash the emulator mid-run. Fall back to
  // an existing user AVD only if we can't create the managed one.
  let avdName = MANAGED_AVD_NAME;
  let launchEnv: NodeJS.ProcessEnv = {
    ...sdkEnv(sdkRoot),
    ANDROID_AVD_HOME: avdHomeDir(sdkRoot),
  };
  try {
    await ensureAvd(sdkRoot);
  } catch (err) {
    const existingAvds = listAvds(sdkRoot);
    if (existingAvds.length === 0) throw err;
    avdName = existingAvds[0];
    launchEnv = sdkEnv(sdkRoot);
  }
  // Keep the emulator's scratch temp on the SDK volume as well.
  const emuTmp = path.join(sdkRoot, ".emulator-tmp");
  try {
    fs.mkdirSync(emuTmp, { recursive: true });
    launchEnv = { ...launchEnv, TMP: emuTmp, TEMP: emuTmp };
  } catch {
    // best-effort; fall back to the default temp dir
  }

  // Boot the emulator if it isn't already running.
  if (!isEmulatorRunning()) {
    // `-accel auto` lets the emulator pick the best available hypervisor
    // (WHPX on Windows, HVF on macOS, KVM on Linux) and degrade gracefully
    // instead of hard-failing when a specific accelerator is unavailable.
    const child = spawn(
      emulatorPath(sdkRoot),
      ["-avd", avdName, "-accel", "auto", "-no-snapshot", "-no-boot-anim"],
      {
        stdio: "ignore",
        detached: false,
        env: launchEnv,
      },
    );
    child.on("exit", () => {
      if (runningEmulator === child) runningEmulator = null;
    });
    runningEmulator = child;
  }

  await waitForBoot(sdkRoot);

  const install = await runAdb(sdkRoot, ["install", "-r", apkPath], 180_000);
  if (install.code !== 0) {
    throw new OrianBuilderError(
      `adb install failed: ${install.stderr.trim() || install.stdout.trim()}`,
      OrianBuilderErrorKind.External,
    );
  }

  // Launch the app via the monkey tool (sends one event to the main activity).
  if (packageId) {
    const launch = await runAdb(
      sdkRoot,
      [
        "shell",
        "monkey",
        "-p",
        packageId,
        "-c",
        "android.intent.category.LAUNCHER",
        "1",
      ],
      60_000,
    );
    if (launch.code !== 0) {
      throw new OrianBuilderError(
        `Failed to launch ${packageId}: ${launch.stderr.trim() || launch.stdout.trim()}`,
        OrianBuilderErrorKind.External,
      );
    }
  }
}

export function stopEmulator(): void {
  if (runningEmulator && runningEmulator.exitCode === null) {
    runningEmulator.kill();
  }
  runningEmulator = null;
}

// =============================================================================
// JDK resolution (Capacitor 7's Android library compiles at Java 21)
// =============================================================================

/** Read the JDK major version from its `release` file (e.g. 21 from "21.0.5"). */
function jdkMajorVersion(jdkHome: string): number | null {
  try {
    const txt = fs.readFileSync(path.join(jdkHome, "release"), "utf-8");
    const m = /JAVA_VERSION="?(\d+)/.exec(txt);
    return m ? Number.parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

/**
 * Find a JDK 21+ (required to build Capacitor 7 Android apps). Checks JAVA_HOME
 * first, then common install roots — including D:\Java and the OrianBuilder
 * user-data dir where we may have auto-downloaded one.
 */
export function resolveJdk21Home(): string | null {
  const candidates: string[] = [];
  if (process.env.JAVA_HOME) candidates.push(process.env.JAVA_HOME);

  const roots =
    process.platform === "win32"
      ? [
          "C:\\Program Files\\Eclipse Adoptium",
          "C:\\Program Files\\Microsoft",
          "C:\\Program Files\\Java",
          "C:\\Program Files\\Amazon Corretto",
          "C:\\Program Files\\Zulu",
          "D:\\Java",
          path.join(app.getPath("userData"), "jdk"),
        ]
      : process.platform === "darwin"
        ? ["/Library/Java/JavaVirtualMachines", "/opt/homebrew/opt"]
        : ["/usr/lib/jvm"];

  for (const root of roots) {
    let entries: string[];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const name of entries) {
      candidates.push(
        process.platform === "darwin"
          ? path.join(root, name, "Contents", "Home")
          : path.join(root, name),
      );
    }
  }

  for (const c of candidates) {
    if (
      fileExists(path.join(c, "bin", exe("java"))) &&
      (jdkMajorVersion(c) ?? 0) >= 21
    ) {
      return c;
    }
  }
  return null;
}

// =============================================================================
// APK build (Gradle CLI — no Android Studio required)
// =============================================================================

function gradlewPath(androidDir: string): string {
  return path.join(
    androidDir,
    process.platform === "win32" ? "gradlew.bat" : "gradlew",
  );
}

/** Spawn a shell command, streaming each output line to `onLog`. */
function runStreamed(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  onLog: (line: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true, stdio: "pipe", env });
    const onAbort = () => child.kill();
    signal?.addEventListener("abort", onAbort);
    let tail = "";
    const handle = (d: Buffer) => {
      const s = d.toString();
      tail = (tail + s).slice(-4000);
      for (const line of s.split(/\r?\n/)) {
        if (line.trim()) onLog(line.trimEnd());
      }
    };
    child.stdout?.on("data", handle);
    child.stderr?.on("data", handle);
    child.on("error", (err) => {
      signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) {
        reject(
          new OrianBuilderError(
            "Build cancelled.",
            OrianBuilderErrorKind.UserCancelled,
          ),
        );
      } else if (code === 0) {
        resolve();
      } else {
        reject(
          new OrianBuilderError(
            `Command failed (exit ${code}): ${command}\n${tail.trim()}`,
            OrianBuilderErrorKind.External,
          ),
        );
      }
    });
  });
}

function findFirstApk(dir: string): string | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const apk = entries.find((n) => n.toLowerCase().endsWith(".apk"));
  return apk ? path.join(dir, apk) : null;
}

/**
 * Build a debug APK for a Capacitor app entirely from the CLI — no Android
 * Studio. Builds the web bundle, syncs Capacitor, points Gradle at the resolved
 * SDK + a JDK 21, and assembles the debug APK. Streams log lines via `onLog`.
 */
export async function buildDebugApk(params: {
  appPath: string;
  onLog: (line: string) => void;
  signal?: AbortSignal;
}): Promise<string> {
  const { appPath, onLog, signal } = params;
  const androidDir = path.join(appPath, "android");

  const { root: sdkRoot } = await resolveActiveSdkRoot();
  if (!hasPlatformTools(sdkRoot)) {
    throw new OrianBuilderError(
      "Android SDK not found. Set ANDROID_HOME or download the runtime first.",
      OrianBuilderErrorKind.Precondition,
    );
  }
  const jdkHome = resolveJdk21Home();
  if (!jdkHome) {
    throw new OrianBuilderError(
      "A JDK 21+ is required to build Capacitor 7 Android apps, but none was found. Install a JDK 21 (e.g. Eclipse Temurin or Microsoft OpenJDK 21).",
      OrianBuilderErrorKind.Precondition,
    );
  }

  const buildEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ANDROID_HOME: sdkRoot,
    ANDROID_SDK_ROOT: sdkRoot,
    JAVA_HOME: jdkHome,
    LANG: "en_US.UTF-8",
  };

  // 1. Build the web app so dist/ is current.
  onLog("> Building web app (npm run build)…");
  await runStreamed("npm run build", appPath, buildEnv, onLog, signal);

  // 2. Ensure the native Android project exists, then copy web assets/plugins.
  if (!fileExists(gradlewPath(androidDir))) {
    onLog("> Adding Android platform (npx cap add android)…");
    await runStreamed("npx cap add android", appPath, buildEnv, onLog, signal);
  }
  onLog("> Syncing Capacitor (npx cap sync android)…");
  await runStreamed("npx cap sync android", appPath, buildEnv, onLog, signal);

  // 3. Point Gradle at the SDK explicitly (belt-and-suspenders with the env).
  await fs.promises.writeFile(
    path.join(androidDir, "local.properties"),
    `sdk.dir=${sdkRoot.replace(/\\/g, "\\\\")}\n`,
    "utf-8",
  );

  // 4. Assemble the debug APK.
  onLog("> Assembling debug APK (gradlew assembleDebug)…");
  await runStreamed(
    `"${gradlewPath(androidDir)}" assembleDebug --no-daemon`,
    androidDir,
    buildEnv,
    onLog,
    signal,
  );

  const apk = findFirstApk(
    path.join(androidDir, "app", "build", "outputs", "apk", "debug"),
  );
  if (!apk) {
    throw new OrianBuilderError(
      "Build finished but no APK was found under app/build/outputs/apk/debug.",
      OrianBuilderErrorKind.External,
    );
  }
  onLog(`> APK ready: ${apk}`);
  return apk;
}
