/**
 * Per-chat path locks. Users can mark files or folders as locked so the agent
 * cannot modify them — this protects manually-edited code from being
 * overwritten by tool calls. Pattern borrowed from bolt.diy.
 *
 * Paths are stored project-relative with forward slashes. A folder lock
 * (e.g. "src/components") blocks any path inside that folder. An exact match
 * locks just the file.
 */

import { db } from "@/db";
import { chats } from "@/db/schema";
import { eq } from "drizzle-orm";

export function normalizeLockPath(input: string): string {
  return input
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\/{2,}/g, "/")
    .trim();
}

/**
 * Returns true when `targetPath` should be considered locked given the chat's
 * lock list. A target is locked if it matches an exact lock or if any lock is
 * a prefix-folder of the target.
 */
export function isPathLocked(
  targetPath: string,
  lockedPaths: string[] | null | undefined,
): boolean {
  if (!lockedPaths || lockedPaths.length === 0) return false;
  const target = normalizeLockPath(targetPath);
  if (!target) return false;
  for (const raw of lockedPaths) {
    const lock = normalizeLockPath(raw);
    if (!lock) continue;
    if (lock === target) return true;
    if (target.startsWith(`${lock}/`)) return true;
  }
  return false;
}

export async function getChatLockedPaths(chatId: number): Promise<string[]> {
  const row = await db.query.chats.findFirst({
    where: eq(chats.id, chatId),
    columns: { lockedPaths: true },
  });
  return row?.lockedPaths ?? [];
}

export async function setChatLockedPaths(
  chatId: number,
  paths: string[],
): Promise<string[]> {
  const cleaned = Array.from(
    new Set(paths.map((p) => normalizeLockPath(p)).filter((p) => p.length > 0)),
  ).sort();
  await db
    .update(chats)
    .set({ lockedPaths: cleaned.length === 0 ? null : cleaned })
    .where(eq(chats.id, chatId));
  return cleaned;
}

export async function addChatLockedPath(
  chatId: number,
  pathToLock: string,
): Promise<string[]> {
  const current = await getChatLockedPaths(chatId);
  return setChatLockedPaths(chatId, [...current, pathToLock]);
}

export async function removeChatLockedPath(
  chatId: number,
  pathToUnlock: string,
): Promise<string[]> {
  const target = normalizeLockPath(pathToUnlock);
  const current = await getChatLockedPaths(chatId);
  return setChatLockedPaths(
    chatId,
    current.filter((p) => normalizeLockPath(p) !== target),
  );
}
