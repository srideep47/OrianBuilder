/**
 * Reclaim disk space lost to half-finished model downloads.
 *
 * Two storage roots hold downloaded AI models:
 *   • <userData>/models                 — GGUF / LLM weights (download manager)
 *   • <userData>/mediaai/models         — Media AI weights + HuggingFace cache
 *
 * Aborted or failed downloads leave junk behind that nothing else cleans:
 *   • partial-download files: our `*.part` files and HuggingFace `*.incomplete`
 *     blobs (the multi-GB space hogs)
 *   • orphaned markers: `.model-markers/<id>.json` whose weights are gone
 *   • empty leftover directories
 *
 * Every candidate path is checked to live inside one of the two known model
 * roots before deletion, mirroring the guard in `deleteLocalModel`. The Python
 * venv (<userData>/mediaai/.venv) and TripoSR git checkout are never scanned —
 * we only walk the `models` subtree, not the whole mediaai root.
 */
import fs from "node:fs";
import path from "node:path";
import log from "electron-log";
import { getModelsDir, listDownloads } from "./model_download_manager";
import {
  getMediaAiDataPaths,
  hfHubRepoDir,
  TIER_HF_REPOS,
} from "./media_ai_backend";
import type { MediaAiModelId } from "../types/media_ai";

const logger = log.scope("model-cleanup");

export type ModelJunkKind =
  | "partial-download"
  | "orphaned-marker"
  | "empty-dir";

export interface ModelJunkItem {
  path: string;
  sizeBytes: number;
  kind: ModelJunkKind;
}

export interface ModelJunkScan {
  items: ModelJunkItem[];
  totalBytes: number;
}

export interface ModelJunkCleanResult {
  removed: string[];
  freedBytes: number;
}

/** The file subtrees we are allowed to scan and delete from. */
function scanRoots(): string[] {
  const { modelsPath } = getMediaAiDataPaths();
  return [getModelsDir(), modelsPath];
}

function isInsideScanRoots(p: string): boolean {
  const target = path.resolve(p);
  return scanRoots().some((root) => {
    const r = path.resolve(root);
    return target === r || target.startsWith(r + path.sep);
  });
}

function walkFiles(
  dir: string,
  cb: (file: string, stat: fs.Stats) => void,
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) walkFiles(full, cb);
      else if (entry.isFile()) cb(full, fs.statSync(full));
    } catch {
      // unreadable / vanished mid-walk — skip
    }
  }
}

function isPartialDownload(name: string): boolean {
  // `.part`     → our download manager's in-progress file
  // `.incomplete` → HuggingFace hub's partial blob
  return name.endsWith(".part") || name.endsWith(".incomplete");
}

/**
 * Collect partial-download files and orphaned marker files (not empty dirs —
 * those are handled separately so cleanup can re-prune after deleting files).
 */
function collectFileJunk(): ModelJunkItem[] {
  const items: ModelJunkItem[] = [];
  const { modelsPath, hfCachePath } = getMediaAiDataPaths();

  // Skip files belonging to a download that is currently in flight.
  const activeParts = new Set(
    listDownloads()
      .filter(
        (d) =>
          d.state === "downloading" ||
          d.state === "queued" ||
          d.state === "paused",
      )
      .map((d) => path.resolve(d.destPath + ".part")),
  );

  // 1. Partial-download files across both model roots.
  for (const root of scanRoots()) {
    walkFiles(root, (file, stat) => {
      if (!isPartialDownload(path.basename(file))) return;
      if (activeParts.has(path.resolve(file))) return;
      items.push({
        path: file,
        sizeBytes: stat.size,
        kind: "partial-download",
      });
    });
  }

  // 2. Orphaned media markers: a marker whose mapped HF repo cache is gone.
  //    Only ids with a known repo can be verified — leave the rest untouched.
  const markerDir = path.join(modelsPath, ".model-markers");
  let markerFiles: string[] = [];
  try {
    markerFiles = fs.existsSync(markerDir) ? fs.readdirSync(markerDir) : [];
  } catch {
    markerFiles = [];
  }
  for (const file of markerFiles) {
    if (!file.endsWith(".json")) continue;
    const id = file.replace(/\.json$/, "") as MediaAiModelId;
    const repo = TIER_HF_REPOS[id];
    if (!repo) continue; // unverifiable — keep it
    const hubDir = path.join(hfCachePath, "hub", hfHubRepoDir(repo));
    const snapshotDir = path.join(
      hfCachePath,
      "snapshots",
      repo.replace("/", "__"),
    );
    if (fs.existsSync(hubDir) || fs.existsSync(snapshotDir)) continue;
    const full = path.join(markerDir, file);
    let size = 0;
    try {
      size = fs.statSync(full).size;
    } catch {
      // ignore
    }
    items.push({ path: full, sizeBytes: size, kind: "orphaned-marker" });
  }

  return items;
}

/**
 * Post-order walk that reports (dryRun) or removes (!dryRun) directories that
 * contain only other empty directories. Never touches the root itself.
 */
function pruneEmptyDirs(root: string, dryRun: boolean): ModelJunkItem[] {
  const removed: ModelJunkItem[] = [];
  const rootResolved = path.resolve(root);

  function recurse(dir: string): boolean {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    let removable = true;
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!recurse(full)) removable = false;
      } else {
        removable = false;
      }
    }
    if (removable && path.resolve(dir) !== rootResolved) {
      removed.push({ path: dir, sizeBytes: 0, kind: "empty-dir" });
      if (!dryRun) {
        try {
          fs.rmdirSync(dir);
        } catch {
          // someone wrote into it mid-prune — leave it
        }
      }
      return true;
    }
    return false;
  }

  if (fs.existsSync(rootResolved)) recurse(rootResolved);
  return removed;
}

/** Report reclaimable junk without deleting anything. */
export function scanModelJunk(): ModelJunkScan {
  const items = [
    ...collectFileJunk(),
    ...scanRoots().flatMap((root) => pruneEmptyDirs(root, true)),
  ];
  const totalBytes = items.reduce((sum, item) => sum + item.sizeBytes, 0);
  return { items, totalBytes };
}

/** Delete reclaimable junk and report what was freed. */
export function cleanModelJunk(): ModelJunkCleanResult {
  const removed: string[] = [];
  let freedBytes = 0;

  for (const item of collectFileJunk()) {
    if (!isInsideScanRoots(item.path)) continue;
    try {
      fs.rmSync(item.path, { force: true });
      freedBytes += item.sizeBytes;
      removed.push(item.path);
    } catch (err) {
      logger.warn(`Failed to remove ${item.path}:`, err);
    }
  }

  // Files gone — now collapse any directories left empty.
  for (const root of scanRoots()) {
    for (const dir of pruneEmptyDirs(root, false)) removed.push(dir.path);
  }

  logger.info(
    `Cleaned ${removed.length} junk entries, freed ${(freedBytes / 1e9).toFixed(2)} GB`,
  );
  return { removed, freedBytes };
}
