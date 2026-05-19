/**
 * Project ZIP export. Walks the app directory and produces a single .zip with
 * the same structure, skipping noisy directories (node_modules, .git, etc.).
 * Mirrors bolt.diy's ZIP export — a one-click escape hatch so users can take
 * their project elsewhere.
 */

import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";

const SKIP_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".next",
  ".expo",
  ".turbo",
  ".cache",
  "dist",
  "dist_electron",
  "build",
  "out",
  "release",
  ".orianbuilder",
  "android/app/build",
  "android/.gradle",
  "ios/build",
  "ios/Pods",
  "web-build",
]);

const SKIP_FILES = new Set([".DS_Store", "Thumbs.db"]);

const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB — single-file cap

export interface ExportZipResult {
  zipPath: string;
  fileCount: number;
  sizeBytes: number;
}

async function walkAndAdd(
  zip: JSZip,
  rootDir: string,
  relPrefix: string,
  counts: { files: number },
): Promise<void> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      // Allow nested matches like "android/app/build"
      if (SKIP_DIRECTORIES.has(relPath)) continue;
      await walkAndAdd(zip, fullPath, relPath, counts);
      continue;
    }
    if (entry.isSymbolicLink()) continue; // skip symlinks for portability
    if (!entry.isFile()) continue;
    if (SKIP_FILES.has(entry.name)) continue;
    let stat: import("node:fs").Stats;
    try {
      stat = await fs.stat(fullPath);
    } catch {
      continue; // broken symlink or file disappeared during walk
    }
    if (stat.size > MAX_FILE_BYTES) continue; // skip very large binaries
    let data: Buffer;
    try {
      data = await fs.readFile(fullPath);
    } catch {
      continue; // file unreadable or disappeared
    }
    zip.file(relPath, data);
    counts.files += 1;
  }
}

export async function exportProjectZip(
  appPath: string,
  destinationPath: string,
): Promise<ExportZipResult> {
  const zip = new JSZip();
  const counts = { files: 0 };
  await walkAndAdd(zip, appPath, "", counts);

  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });

  await fs.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.writeFile(destinationPath, buffer);

  return {
    zipPath: destinationPath,
    fileCount: counts.files,
    sizeBytes: buffer.length,
  };
}
