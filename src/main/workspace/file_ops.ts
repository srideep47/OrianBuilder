import fs from "node:fs/promises";
import path from "node:path";
import log from "electron-log";

const logger = log.scope("file-ops");

/**
 * Project file operations — the create/rename/move/delete surface the desktop
 * file tree was missing entirely (it could render and search, nothing more,
 * where OrionAndroid's file manager has had a full context menu for a while).
 *
 * Every function jails its paths inside the project. That's not defensive
 * boilerplate: paths reach here from a rendered tree whose entries come from
 * disk, including from repositories the user cloned, and `..` in any of them
 * would otherwise let a click delete something outside the project.
 */

export interface FileEntry {
  name: string;
  /** Project-relative, forward slashes. */
  relativePath: string;
  isDirectory: boolean;
  sizeBytes: number;
  modifiedMs: number;
}

export interface EntryProperties {
  name: string;
  relativePath: string;
  absolutePath: string;
  isDirectory: boolean;
  sizeBytes: number;
  /** Recursive count for a directory; 1 for a file. */
  itemCount: number;
  modifiedMs: number;
  createdMs: number;
}

/**
 * Resolves a project-relative path, refusing anything that escapes the root.
 *
 * `realpath` on the root (not the target, which may not exist yet) so a symlinked
 * project directory still validates, while a symlink *inside* the project that
 * points outside it is caught by the containment check on the resolved target.
 */
async function safeResolve(root: string, relative: string): Promise<string> {
  const realRoot = await fs.realpath(root);
  const target = path.resolve(realRoot, relative);
  const rel = path.relative(realRoot, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes the project: ${relative}`);
  }
  return target;
}

/** True when `child` is inside `parent`, used to refuse a move into itself. */
function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

const IGNORED = new Set([
  "node_modules",
  ".git",
  ".godot",
  "dist",
  "build",
  "out",
  "__pycache__",
  ".venv",
]);

/** Lists one directory. Not recursive — the tree fetches lazily per expand. */
export async function listDirectory(
  root: string,
  relative = "",
): Promise<FileEntry[]> {
  const dir = await safeResolve(root, relative);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: FileEntry[] = [];

  for (const entry of entries) {
    if (IGNORED.has(entry.name)) continue;
    const absolute = path.join(dir, entry.name);
    let stat;
    try {
      stat = await fs.lstat(absolute);
    } catch {
      // Vanished between readdir and lstat — skip rather than fail the listing.
      continue;
    }
    out.push({
      name: entry.name,
      relativePath: path.relative(root, absolute).split(path.sep).join("/"),
      isDirectory: entry.isDirectory(),
      sizeBytes: stat.isFile() ? stat.size : 0,
      modifiedMs: stat.mtimeMs,
    });
  }

  // Directories first, then alphabetical — the ordering every file manager uses,
  // and the one that makes a deep tree scannable.
  out.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return out;
}

export async function createFile(
  root: string,
  relative: string,
  contents = "",
): Promise<string> {
  const target = await safeResolve(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  // `wx` fails if it exists, so a new file can never silently truncate one.
  await fs.writeFile(target, contents, { flag: "wx" });
  logger.info(`Created file ${relative}`);
  return relative;
}

export async function createDirectory(
  root: string,
  relative: string,
): Promise<string> {
  const target = await safeResolve(root, relative);
  await fs.mkdir(target, { recursive: false });
  logger.info(`Created directory ${relative}`);
  return relative;
}

export async function renameEntry(
  root: string,
  relative: string,
  newName: string,
): Promise<string> {
  if (newName.includes("/") || newName.includes("\\")) {
    throw new Error(
      "A name cannot contain a path separator — use move instead.",
    );
  }
  const from = await safeResolve(root, relative);
  const to = path.join(path.dirname(from), newName);
  // Refuse to clobber. `fs.rename` would overwrite silently on POSIX.
  try {
    await fs.access(to);
    throw new Error(`${newName} already exists here.`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  await fs.rename(from, to);
  return path.relative(root, to).split(path.sep).join("/");
}

export async function moveEntry(
  root: string,
  relative: string,
  destinationDir: string,
): Promise<string> {
  const from = await safeResolve(root, relative);
  const dir = await safeResolve(root, destinationDir);
  if (isInside(from, dir)) {
    throw new Error("Cannot move a folder into itself.");
  }
  const to = path.join(dir, path.basename(from));
  if (to === from) return relative;
  try {
    await fs.access(to);
    throw new Error(
      `${path.basename(from)} already exists in the destination.`,
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  await fs.mkdir(dir, { recursive: true });
  await fs.rename(from, to);
  return path.relative(root, to).split(path.sep).join("/");
}

export async function copyEntry(
  root: string,
  relative: string,
  destinationDir: string,
): Promise<string> {
  const from = await safeResolve(root, relative);
  const dir = await safeResolve(root, destinationDir);
  if (isInside(from, dir)) {
    throw new Error("Cannot copy a folder into itself.");
  }
  await fs.mkdir(dir, { recursive: true });

  // Never overwrite: a second copy of "config.json" must not replace the first.
  const base = path.basename(from);
  const ext = path.extname(base);
  const stem = path.basename(base, ext);
  let candidate = path.join(dir, base);
  let n = 1;
  while (true) {
    try {
      await fs.access(candidate);
      candidate = path.join(dir, `${stem} (${n})${ext}`);
      n += 1;
    } catch {
      break;
    }
  }

  await fs.cp(from, candidate, { recursive: true, errorOnExist: true });
  return path.relative(root, candidate).split(path.sep).join("/");
}

export async function deleteEntry(
  root: string,
  relative: string,
): Promise<void> {
  const target = await safeResolve(root, relative);
  const realRoot = await fs.realpath(root);
  if (target === realRoot) {
    throw new Error("Refusing to delete the project root.");
  }
  // lstat, not stat: a symlink to a directory outside the project must be
  // unlinked, never followed and recursively removed.
  const stat = await fs.lstat(target);
  if (stat.isSymbolicLink()) {
    await fs.unlink(target);
    return;
  }
  await fs.rm(target, { recursive: stat.isDirectory(), force: false });
  logger.info(`Deleted ${relative}`);
}

/** Recursive size and item count, for the properties dialog. */
async function measure(
  target: string,
): Promise<{ sizeBytes: number; itemCount: number }> {
  const stat = await fs.lstat(target);
  if (!stat.isDirectory()) return { sizeBytes: stat.size, itemCount: 1 };
  let sizeBytes = 0;
  let itemCount = 0;
  const entries = await fs.readdir(target, { withFileTypes: true });
  for (const entry of entries) {
    if (IGNORED.has(entry.name)) continue;
    const child = path.join(target, entry.name);
    try {
      const inner = await measure(child);
      sizeBytes += inner.sizeBytes;
      itemCount += inner.itemCount;
    } catch {
      // Unreadable child — count nothing rather than aborting the measurement.
    }
  }
  return { sizeBytes, itemCount };
}

export async function entryProperties(
  root: string,
  relative: string,
): Promise<EntryProperties> {
  const target = await safeResolve(root, relative);
  const stat = await fs.lstat(target);
  const { sizeBytes, itemCount } = await measure(target);
  return {
    name: path.basename(target),
    relativePath: relative,
    absolutePath: target,
    isDirectory: stat.isDirectory(),
    sizeBytes,
    itemCount,
    modifiedMs: stat.mtimeMs,
    createdMs: stat.birthtimeMs,
  };
}
