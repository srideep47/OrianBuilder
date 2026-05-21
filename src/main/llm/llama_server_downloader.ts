/**
 * In-process llama-server binary downloader.
 * Ports the logic from scripts/download-llama-server.mjs into TypeScript so the
 * Electron main process can fetch the binary at runtime (with progress callbacks)
 * instead of requiring a manual CLI step.
 *
 * Download target:
 *   Packaged build  →  app.getPath("userData")/llama-server/<variant>/
 *   Dev build       →  <project-root>/resources/llama-server/<variant>/
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import os from "node:os";
import { app } from "electron";

import type { LlamaServerVariant } from "./llama_server_binary";

// =============================================================================
// Types
// =============================================================================

export type DownloadStage =
  | "resolving"
  | "downloading"
  | "extracting"
  | "companions"
  | "done";

export interface DownloadProgress {
  stage: DownloadStage;
  label: string;
  percent: number;
  bytesDownloaded: number;
  totalBytes: number;
}

type ProgressCallback = (progress: DownloadProgress) => void;

// =============================================================================
// Variant → GitHub release asset patterns
// =============================================================================

const VARIANT_PATTERNS: Record<
  LlamaServerVariant,
  { preferredAssets: string[][]; companionAssets: string[][] }
> = {
  "win-cuda": {
    preferredAssets: [
      ["llama-", "bin-win-cuda-12", "x64.zip", "!cudart"],
      ["llama-", "bin-win-cuda-13", "x64.zip", "!cudart"],
      ["llama-", "bin-win-cuda", "x64.zip", "!cudart"],
    ],
    companionAssets: [
      ["cudart-llama-bin-win-cuda-12", "x64.zip"],
      ["cudart-llama-bin-win-cuda-13", "x64.zip"],
      ["cudart-llama-bin-win-cuda", "x64.zip"],
    ],
  },
  "win-vulkan": {
    preferredAssets: [["llama-", "bin-win-vulkan", "x64.zip"]],
    companionAssets: [],
  },
  "win-cpu": {
    preferredAssets: [
      ["llama-", "bin-win-cpu", "x64.zip"],
      ["llama-", "bin-win-avx2", "x64.zip"],
    ],
    companionAssets: [],
  },
  "linux-cuda": {
    preferredAssets: [["llama-", "bin-linux-cuda", "x64"]],
    companionAssets: [],
  },
  "linux-vulkan": {
    preferredAssets: [["llama-", "bin-linux-vulkan", "x64"]],
    companionAssets: [],
  },
  "linux-cpu": {
    preferredAssets: [
      ["llama-", "bin-ubuntu", "x64.zip"],
      ["llama-", "bin-linux-cpu", "x64.zip"],
    ],
    companionAssets: [],
  },
  "mac-metal": {
    preferredAssets: [["llama-", "bin-macos", "arm64.zip"]],
    companionAssets: [],
  },
};

// =============================================================================
// Target directory resolution
// =============================================================================

function getTargetRoot(): string {
  if (app.isPackaged) {
    return path.join(app.getPath("userData"), "llama-server");
  }
  // Dev: walk up from .vite/build → project root
  return path.join(
    path.resolve(__dirname, "..", ".."),
    "resources",
    "llama-server",
  );
}

// =============================================================================
// Network helpers
// =============================================================================

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "orianbuilder-llama-server-downloader",
      Accept: "application/vnd.github+json",
    },
  });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  return res.json();
}

async function fetchToFile(
  url: string,
  destPath: string,
  onProgress?: (bytesDownloaded: number, totalBytes: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(url, {
    headers: { "User-Agent": "orianbuilder-llama-server-downloader" },
    redirect: "follow",
    signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
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

// =============================================================================
// Archive extraction
// =============================================================================

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
          : reject(new Error(`Expand-Archive exited ${code}`)),
      );
      return;
    }
    const child = spawn("unzip", ["-o", "-q", archivePath, "-d", destDir], {
      stdio: "pipe",
    });
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`unzip exited ${code}`)),
    );
  });
}

// =============================================================================
// Asset matching + discovery
// =============================================================================

function assetMatches(name: string, fragments: string[]): boolean {
  const lower = name.toLowerCase();
  for (const frag of fragments) {
    if (frag.startsWith("!")) {
      if (lower.includes(frag.slice(1).toLowerCase())) return false;
    } else if (!lower.includes(frag.toLowerCase())) {
      return false;
    }
  }
  return true;
}

function pickAsset(release: any, preferredAssets: string[][]): any | null {
  const assets: any[] = release.assets ?? [];
  for (const frags of preferredAssets) {
    for (const asset of assets) {
      if (assetMatches(asset.name as string, frags)) return asset;
    }
  }
  return null;
}

function findBinaryInDir(rootDir: string, binaryName: string): string | null {
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name === binaryName) return full;
    }
  }
  return null;
}

async function copyAllFilesFromDir(
  sourceDir: string,
  targetDir: string,
  predicate?: (name: string) => boolean,
): Promise<void> {
  await fs.promises.mkdir(targetDir, { recursive: true });
  const stack = [sourceDir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry.isFile() && (!predicate || predicate(entry.name))) {
        await fs.promises.copyFile(full, path.join(targetDir, entry.name));
      }
    }
  }
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Download and install the llama-server binary for the given variant.
 * Reports progress via `onProgress` throughout.
 * Respects `signal` for cancellation (throws AbortError on cancel).
 */
export async function downloadLlamaServerBinary(
  variant: LlamaServerVariant,
  onProgress: ProgressCallback,
  signal?: AbortSignal,
): Promise<void> {
  const emit = (
    stage: DownloadStage,
    label: string,
    percent: number,
    bytesDownloaded = 0,
    totalBytes = 0,
  ) => onProgress({ stage, label, percent, bytesDownloaded, totalBytes });

  emit("resolving", "Fetching release info…", 0);

  const release = await fetchJson(
    "https://api.github.com/repos/ggerganov/llama.cpp/releases/latest",
  );

  const spec = VARIANT_PATTERNS[variant];
  if (!spec) throw new Error(`Unknown variant: ${variant}`);

  const mainAsset = pickAsset(release, spec.preferredAssets);
  if (!mainAsset) {
    throw new Error(
      `No matching asset for variant "${variant}" in release ${release.tag_name}. ` +
        `Compile llama-server yourself and set LLAMA_SERVER_PATH.`,
    );
  }

  const binaryName = variant.startsWith("win-") ? "llama-server.exe" : "llama-server";
  const targetDir = path.join(getTargetRoot(), variant);
  const hasCompanions = spec.companionAssets.length > 0;

  // Percent budget:  download 0→65 (or 0→80 if no companions), extract 65→80 (or 80→98), companions 80→98
  const dlEnd = hasCompanions ? 65 : 80;
  const exEnd = hasCompanions ? 80 : 98;

  const tmpDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), `llama-server-${variant}-`),
  );
  const unpackedDir = path.join(tmpDir, "unpacked");
  await fs.promises.mkdir(unpackedDir, { recursive: true });

  try {
    // ── Download main archive ──────────────────────────────────────────
    const archivePath = path.join(tmpDir, mainAsset.name);
    await fetchToFile(
      mainAsset.browser_download_url,
      archivePath,
      (bytes, total) => {
        const pct = total > 0 ? (bytes / total) * dlEnd : dlEnd * 0.5;
        emit("downloading", `Downloading ${mainAsset.name}…`, pct, bytes, total);
      },
      signal,
    );

    // ── Extract ────────────────────────────────────────────────────────
    emit("extracting", "Extracting archive…", dlEnd);
    await unzip(archivePath, unpackedDir);

    const found = findBinaryInDir(unpackedDir, binaryName);
    if (!found) {
      throw new Error(`"${binaryName}" not found inside ${mainAsset.name}`);
    }

    emit("extracting", "Copying binary…", dlEnd + (exEnd - dlEnd) * 0.5);
    await copyAllFilesFromDir(path.dirname(found), targetDir, (name) => {
      const lower = name.toLowerCase();
      return (
        name === binaryName ||
        lower.endsWith(".dll") ||
        lower.endsWith(".so") ||
        lower.endsWith(".dylib") ||
        lower.endsWith(".metallib")
      );
    });

    if (process.platform !== "win32") {
      await fs.promises.chmod(path.join(targetDir, binaryName), 0o755);
    }

    emit("extracting", "Binary installed.", exEnd);

    // ── Companion assets (CUDA runtime DLLs etc.) ─────────────────────
    if (hasCompanions) {
      const downloadedIds = new Set<number>();
      const companionCount = spec.companionAssets.length;

      for (let i = 0; i < companionCount; i++) {
        const companion = pickAsset(release, [spec.companionAssets[i]]);
        if (!companion || downloadedIds.has(companion.id)) continue;
        downloadedIds.add(companion.id);

        const companionArchive = path.join(tmpDir, companion.name);
        const companionUnpacked = path.join(tmpDir, `companion-${i}`);
        await fs.promises.mkdir(companionUnpacked, { recursive: true });

        const cStart = exEnd + (i / companionCount) * (98 - exEnd);
        const cEnd = exEnd + ((i + 1) / companionCount) * (98 - exEnd);

        await fetchToFile(
          companion.browser_download_url,
          companionArchive,
          (bytes, total) => {
            const pct = cStart + (total > 0 ? (bytes / total) : 0.5) * (cEnd - cStart);
            emit("companions", `Downloading ${companion.name}…`, pct, bytes, total);
          },
          signal,
        );
        await unzip(companionArchive, companionUnpacked);
        await copyAllFilesFromDir(companionUnpacked, targetDir, (name) =>
          name.toLowerCase().endsWith(".dll"),
        );
      }
    }

    emit("done", "Download complete!", 100);
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
