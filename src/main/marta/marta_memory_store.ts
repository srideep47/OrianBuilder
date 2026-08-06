import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import log from "electron-log";

import { getElectron, getUserDataPath } from "@/paths/paths";
import type {
  MartaDelegationSelection,
  MartaPendingDelegation,
  MartaPreferences,
} from "@/ipc/types/marta";
import { MartaPendingDelegationSchema } from "@/ipc/types/marta";
import type { MartaChatMessage } from "./marta_model";

const logger = log.scope("marta-memory");
const FILE_NAME = "marta-memory.json";
const SHARED_FILE_NAME = "orianbuilder-marta-memory-v2.json";
const MEMORY_FILE_ENV = "ORIANBUILDER_MARTA_MEMORY_FILE";

export const DEFAULT_MARTA_PREFERENCES: MartaPreferences = {
  codingWorker: "ask",
  localModel: null,
  claudeModel: null,
  claudeEffort: null,
  narrationDetail: "normal",
};

export interface MartaMemoryFact {
  id: string;
  scope: "global" | "project";
  projectId?: number;
  key: string;
  value: string;
  source: "user" | "orion" | "task";
  updatedAt: number;
}

export interface MartaEpisode {
  id: string;
  taskId: string;
  projectId?: number;
  goal: string;
  outcome: "succeeded" | "failed" | "cancelled";
  summary: string;
  evidence?: string[];
  completedAt: number;
}

interface StoredMartaMemory {
  version: 2;
  preferences: MartaPreferences;
  history: MartaChatMessage[];
  pendingDelegation: MartaPendingDelegation | null;
  facts: MartaMemoryFact[];
  episodes: MartaEpisode[];
}

let memory: StoredMartaMemory = {
  version: 2,
  preferences: DEFAULT_MARTA_PREFERENCES,
  history: [],
  pendingDelegation: null,
  facts: [],
  episodes: [],
};
let loadPromise: Promise<void> | null = null;
let writeChain = Promise.resolve();

function hasExplicitUserDataDir(): boolean {
  return process.argv.some(
    (arg) => arg === "--user-data-dir" || arg.startsWith("--user-data-dir="),
  );
}

/**
 * Marta is one assistant across development and packaged shells. Keep her
 * durable memory in Electron's shared app-data directory, while explicit
 * test/portable profiles remain isolated by design.
 */
export function getMartaMemoryPath(): string {
  const configured = process.env[MEMORY_FILE_ENV];
  if (configured && path.isAbsolute(configured))
    return path.normalize(configured);
  if (hasExplicitUserDataDir() || process.env.NODE_ENV === "test") {
    return path.join(getUserDataPath(), FILE_NAME);
  }
  const electron = getElectron();
  if (electron?.app) {
    return path.join(electron.app.getPath("appData"), SHARED_FILE_NAME);
  }
  return path.join(getUserDataPath(), FILE_NAME);
}

function legacyFilePath(): string {
  return path.join(getUserDataPath(), FILE_NAME);
}

function filePath(): string {
  return getMartaMemoryPath();
}

function conversationalHistory(value: unknown): MartaChatMessage[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (item): item is { role: "user" | "assistant"; content: string } =>
        !!item &&
        typeof item === "object" &&
        ((item as { role?: unknown }).role === "user" ||
          (item as { role?: unknown }).role === "assistant") &&
        typeof (item as { content?: unknown }).content === "string",
    )
    .map((item) => ({ role: item.role, content: item.content }))
    .slice(-24);
}

export async function loadMartaMemory(): Promise<void> {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      let raw: string;
      try {
        raw = await fs.readFile(filePath(), "utf8");
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== "ENOENT" ||
          filePath() === legacyFilePath()
        ) {
          throw error;
        }
        // One-time compatibility migration: the first universal launch adopts
        // the profile-local memory that previous releases used.
        raw = await fs.readFile(legacyFilePath(), "utf8");
      }
      const parsed = JSON.parse(raw) as {
        preferences?: Partial<MartaPreferences>;
        history?: unknown;
        pendingDelegation?: unknown;
        facts?: unknown;
        episodes?: unknown;
      };
      const pending = MartaPendingDelegationSchema.safeParse(
        parsed.pendingDelegation,
      );
      memory = {
        version: 2,
        preferences: {
          ...DEFAULT_MARTA_PREFERENCES,
          ...parsed.preferences,
        },
        history: conversationalHistory(parsed.history),
        pendingDelegation: pending.success ? pending.data : null,
        facts: memoryFacts(parsed.facts),
        episodes: memoryEpisodes(parsed.episodes),
      };
      if (filePath() !== legacyFilePath()) queueWrite();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.warn("Could not load Marta memory:", error);
      }
    }
  })();
  return loadPromise;
}

function memoryFacts(value: unknown): MartaMemoryFact[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is MartaMemoryFact => {
      if (!item || typeof item !== "object") return false;
      const fact = item as Partial<MartaMemoryFact>;
      return (
        typeof fact.id === "string" &&
        (fact.scope === "global" || fact.scope === "project") &&
        typeof fact.key === "string" &&
        typeof fact.value === "string" &&
        (fact.source === "user" ||
          fact.source === "orion" ||
          fact.source === "task") &&
        typeof fact.updatedAt === "number"
      );
    })
    .slice(-500);
}

function memoryEpisodes(value: unknown): MartaEpisode[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is MartaEpisode => {
      if (!item || typeof item !== "object") return false;
      const episode = item as Partial<MartaEpisode>;
      return (
        typeof episode.id === "string" &&
        typeof episode.taskId === "string" &&
        typeof episode.goal === "string" &&
        typeof episode.summary === "string" &&
        (episode.outcome === "succeeded" ||
          episode.outcome === "failed" ||
          episode.outcome === "cancelled") &&
        typeof episode.completedAt === "number"
      );
    })
    .slice(-200);
}

function queueWrite(): void {
  const snapshot = JSON.stringify(memory, null, 2);
  writeChain = writeChain
    .then(async () => {
      await fs.mkdir(path.dirname(filePath()), { recursive: true });
      const temporary = `${filePath()}.tmp`;
      await fs.writeFile(temporary, snapshot, "utf8");
      await fs.rename(temporary, filePath());
    })
    .catch((error) => logger.warn("Could not save Marta memory:", error));
}

export async function getMartaPreferences(): Promise<MartaPreferences> {
  await loadMartaMemory();
  return { ...memory.preferences };
}

export async function updateMartaPreferences(
  patch: Partial<MartaPreferences>,
): Promise<MartaPreferences> {
  await loadMartaMemory();
  memory.preferences = { ...memory.preferences, ...patch };
  queueWrite();
  return { ...memory.preferences };
}

export async function rememberDelegationSelection(
  selection: MartaDelegationSelection,
): Promise<void> {
  if (!selection.remember) return;
  await updateMartaPreferences({
    codingWorker: selection.worker,
    ...(selection.worker === "local"
      ? { localModel: selection.model ?? null }
      : {
          claudeModel: selection.model ?? null,
          claudeEffort: selection.effort ?? null,
        }),
  });
}

export async function getStoredMartaHistory(): Promise<MartaChatMessage[]> {
  await loadMartaMemory();
  return [...memory.history];
}

export async function saveMartaHistory(
  history: MartaChatMessage[],
): Promise<void> {
  await loadMartaMemory();
  memory.history = conversationalHistory(history);
  queueWrite();
}

export async function getPendingMartaDelegation(): Promise<MartaPendingDelegation | null> {
  await loadMartaMemory();
  return memory.pendingDelegation
    ? {
        ...memory.pendingDelegation,
        conversation: memory.pendingDelegation.conversation
          ? { ...memory.pendingDelegation.conversation }
          : undefined,
      }
    : null;
}

export async function setPendingMartaDelegation(
  pending: MartaPendingDelegation | null,
): Promise<void> {
  await loadMartaMemory();
  memory.pendingDelegation = pending;
  queueWrite();
}

/** Upsert a user/project fact by stable scope + project + key. */
export async function rememberMartaFact(
  fact: Omit<MartaMemoryFact, "id" | "updatedAt"> &
    Partial<Pick<MartaMemoryFact, "id" | "updatedAt">>,
): Promise<MartaMemoryFact> {
  await loadMartaMemory();
  const key = fact.key.trim().slice(0, 120);
  const value = fact.value.trim().slice(0, 2_000);
  const existing = memory.facts.find(
    (candidate) =>
      candidate.scope === fact.scope &&
      candidate.projectId === fact.projectId &&
      candidate.key.toLowerCase() === key.toLowerCase(),
  );
  const next: MartaMemoryFact = {
    id: fact.id ?? existing?.id ?? randomUUID(),
    scope: fact.scope,
    projectId: fact.projectId,
    key,
    value,
    source: fact.source,
    updatedAt: fact.updatedAt ?? Date.now(),
  };
  memory.facts = [
    ...memory.facts.filter((candidate) => candidate.id !== next.id),
    next,
  ].slice(-500);
  queueWrite();
  return { ...next };
}

export async function recordMartaEpisode(
  episode: Omit<MartaEpisode, "id"> & Partial<Pick<MartaEpisode, "id">>,
): Promise<MartaEpisode> {
  await loadMartaMemory();
  const next: MartaEpisode = {
    ...episode,
    id: episode.id ?? randomUUID(),
    evidence: episode.evidence?.slice(-20),
  };
  memory.episodes = [
    ...memory.episodes.filter((candidate) => candidate.taskId !== next.taskId),
    next,
  ].slice(-200);
  queueWrite();
  return { ...next, evidence: next.evidence ? [...next.evidence] : undefined };
}

export async function listMartaEpisodes(
  projectId?: number,
): Promise<MartaEpisode[]> {
  await loadMartaMemory();
  return memory.episodes
    .filter(
      (episode) => projectId === undefined || episode.projectId === projectId,
    )
    .slice(-30)
    .map((episode) => ({
      ...episode,
      evidence: episode.evidence ? [...episode.evidence] : undefined,
    }));
}

/** Compact trusted memory for Marta's prompt; never includes hidden worker text. */
export async function getMartaMemoryDigest(
  projectId?: number,
): Promise<string> {
  await loadMartaMemory();
  const facts = memory.facts
    .filter(
      (fact) =>
        fact.scope === "global" ||
        (projectId !== undefined && fact.projectId === projectId),
    )
    .slice(-20);
  const episodes = memory.episodes
    .filter(
      (episode) => projectId === undefined || episode.projectId === projectId,
    )
    .slice(-5);
  if (facts.length === 0 && episodes.length === 0)
    return "No durable facts yet.";
  return [
    ...facts.map(
      (fact) => `${fact.scope} preference ${fact.key}: ${fact.value}`,
    ),
    ...episodes.map(
      (episode) =>
        `previous task ${episode.outcome}: ${episode.goal} — ${episode.summary}`,
    ),
  ].join("\n");
}

export function _resetMartaMemoryForTests(): void {
  memory = {
    version: 2,
    preferences: DEFAULT_MARTA_PREFERENCES,
    history: [],
    pendingDelegation: null,
    facts: [],
    episodes: [],
  };
  loadPromise = null;
  writeChain = Promise.resolve();
}

export async function _flushMartaMemoryForTests(): Promise<void> {
  await writeChain;
}
