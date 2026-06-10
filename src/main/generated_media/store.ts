/**
 * Global "generated media" store.
 *
 * A single shared pool under `userData/generated-media/`. Every image / video /
 * audio / 3D model the user generates lands here so it shows up categorised in
 * Library → Media, can be toggled "sharable", and shared with trusted peers.
 *
 * Per-file metadata (prompt, sharable flag, thumbnail) lives in a sidecar
 * `<file>.json`. Files are served to the renderer via
 * `orian-media://generated/{filename}` (see the protocol handler in main.ts).
 */
import * as fs from "fs";
import * as path from "path";
import { app, net } from "electron";
import log from "electron-log/main";

const logger = log.scope("generated-media");

export type GeneratedMediaKind = "image" | "video" | "audio" | "model";

export interface GeneratedMediaItem {
  fileName: string;
  kind: GeneratedMediaKind;
  mimeType: string;
  sizeBytes: number;
  /** Epoch ms (file mtime). */
  createdAt: number;
  prompt: string | null;
  /** Whether this item is shared with trusted peers. */
  shared: boolean;
  /** Small base64 data-URL thumbnail (images/videos), for peer announce + UI. */
  thumbnail: string | null;
}

interface Sidecar {
  prompt?: string | null;
  shared?: boolean;
  thumbnail?: string | null;
}

const MIME_BY_EXT: Record<string, { mime: string; kind: GeneratedMediaKind }> =
  {
    ".png": { mime: "image/png", kind: "image" },
    ".jpg": { mime: "image/jpeg", kind: "image" },
    ".jpeg": { mime: "image/jpeg", kind: "image" },
    ".webp": { mime: "image/webp", kind: "image" },
    ".gif": { mime: "image/gif", kind: "image" },
    ".mp4": { mime: "video/mp4", kind: "video" },
    ".webm": { mime: "video/webm", kind: "video" },
    ".mov": { mime: "video/quicktime", kind: "video" },
    ".wav": { mime: "audio/wav", kind: "audio" },
    ".mp3": { mime: "audio/mpeg", kind: "audio" },
    ".glb": { mime: "model/gltf-binary", kind: "model" },
    ".gltf": { mime: "model/gltf+json", kind: "model" },
    ".obj": { mime: "model/obj", kind: "model" },
    ".stl": { mime: "model/stl", kind: "model" },
  };

export function getStoreDir(): string {
  const dir = path.join(app.getPath("userData"), "generated-media");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function assertSafeName(fileName: string): void {
  if (
    !fileName ||
    fileName.includes("..") ||
    fileName.includes("/") ||
    fileName.includes("\\")
  ) {
    throw new Error(`Unsafe media filename: ${fileName}`);
  }
}

export function getFilePath(fileName: string): string {
  assertSafeName(fileName);
  const resolved = path.resolve(path.join(getStoreDir(), fileName));
  const rel = path.relative(getStoreDir(), resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes generated-media dir: ${fileName}`);
  }
  return resolved;
}

function sidecarPath(fileName: string): string {
  return getFilePath(fileName) + ".json";
}

function readSidecar(fileName: string): Sidecar {
  try {
    const p = sidecarPath(fileName);
    if (fs.existsSync(p))
      return JSON.parse(fs.readFileSync(p, "utf-8")) as Sidecar;
  } catch {
    /* ignore */
  }
  return {};
}

function writeSidecar(fileName: string, patch: Sidecar): void {
  try {
    const merged = { ...readSidecar(fileName), ...patch };
    fs.writeFileSync(sidecarPath(fileName), JSON.stringify(merged), "utf-8");
  } catch (e) {
    logger.warn("Failed to write media sidecar:", e);
  }
}

function sanitizeStem(s: string): string {
  return (
    s
      .slice(0, 40)
      .replace(/[^a-zA-Z0-9]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "")
      .toLowerCase() || "media"
  );
}

function uniqueName(stem: string, ext: string): string {
  const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  return `${sanitizeStem(stem)}_${suffix}${ext}`;
}

/** Download a file from a URL (e.g. the local backend's /outputs/...) into the store. */
export async function saveFromUrl(
  url: string,
  opts: { promptOrStem?: string; ext?: string; prompt?: string | null } = {},
): Promise<GeneratedMediaItem> {
  const res = await net.fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch media (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ext =
    (opts.ext ?? path.extname(new URL(url).pathname) ?? "").toLowerCase() ||
    ".bin";
  return saveBuffer(buf, {
    ext,
    promptOrStem: opts.promptOrStem,
    prompt: opts.prompt ?? opts.promptOrStem ?? null,
  });
}

/** Save raw bytes into the store (used by generation + peer downloads). */
export async function saveBuffer(
  buf: Buffer,
  opts: {
    ext: string;
    promptOrStem?: string;
    prompt?: string | null;
    fileName?: string;
  } = {
    ext: ".bin",
  },
): Promise<GeneratedMediaItem> {
  const ext = opts.ext.toLowerCase();
  const fileName =
    opts.fileName ?? uniqueName(opts.promptOrStem ?? "media", ext);
  fs.writeFileSync(getFilePath(fileName), buf);
  if (opts.prompt) writeSidecar(fileName, { prompt: opts.prompt });
  logger.info(`Saved generated media: ${fileName} (${buf.length} bytes)`);
  return statItem(fileName);
}

export async function saveFromPath(
  srcPath: string,
  opts: { promptOrStem?: string; prompt?: string | null } = {},
): Promise<GeneratedMediaItem> {
  const ext = path.extname(srcPath).toLowerCase() || ".bin";
  const fileName = uniqueName(
    opts.promptOrStem ?? path.basename(srcPath, ext),
    ext,
  );
  fs.copyFileSync(srcPath, getFilePath(fileName));
  if (opts.prompt) writeSidecar(fileName, { prompt: opts.prompt });
  logger.info(`Copied generated media: ${fileName}`);
  return statItem(fileName);
}

export function statItem(fileName: string): GeneratedMediaItem {
  const full = getFilePath(fileName);
  const st = fs.statSync(full);
  const ext = path.extname(fileName).toLowerCase();
  const meta = MIME_BY_EXT[ext] ?? {
    mime: "application/octet-stream",
    kind: "image" as const,
  };
  const sidecar = readSidecar(fileName);
  return {
    fileName,
    kind: meta.kind,
    mimeType: meta.mime,
    sizeBytes: st.size,
    createdAt: st.mtimeMs,
    prompt: sidecar.prompt ?? null,
    shared: sidecar.shared ?? false,
    thumbnail: sidecar.thumbnail ?? null,
  };
}

export function list(): GeneratedMediaItem[] {
  const dir = getStoreDir();
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const items: GeneratedMediaItem[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const ext = path.extname(e.name).toLowerCase();
    if (!(ext in MIME_BY_EXT)) continue; // skip sidecars & unknowns
    try {
      items.push(statItem(e.name));
    } catch {
      /* skip unreadable */
    }
  }
  return items.sort((a, b) => b.createdAt - a.createdAt);
}

/** Items the user has marked sharable (for peer announce). */
export function listShared(): GeneratedMediaItem[] {
  return list().filter((i) => i.shared);
}

export function setShared(fileName: string, shared: boolean): void {
  writeSidecar(fileName, { shared });
}

export function setThumbnail(fileName: string, thumbnail: string | null): void {
  writeSidecar(fileName, { thumbnail });
}

export function readFileBytes(fileName: string): Buffer {
  return fs.readFileSync(getFilePath(fileName));
}

export function remove(fileName: string): void {
  const full = getFilePath(fileName);
  if (fs.existsSync(full)) fs.unlinkSync(full);
  const sidecar = sidecarPath(fileName);
  if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
}
