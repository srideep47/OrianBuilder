/**
 * The world-state digest — what makes Marta "aware of everything" without a
 * 100k-token prompt.
 *
 * Regenerated every turn and rendered to a few hundred tokens. It answers the
 * questions that are implicit in almost every request and that she would
 * otherwise have to spend a tool call discovering: what am I looking at, which
 * project is live, what is already running, and is there room on the GPU.
 *
 * Sources are injected rather than imported. Three reasons, in order of
 * importance: this module must be unit-testable without Electron, a database
 * or a GPU; the pieces it reads live in subsystems that import each other and
 * a direct import graph here would knot them together; and the renderer owns
 * part of the state (what is on the Stage) which main cannot ask for
 * synchronously.
 *
 * **Every source is allowed to fail.** A digest missing its GPU section is a
 * slightly less informed Marta. A digest that throws is a Marta who cannot
 * answer at all, because the failure happens before she has read the request.
 * So collection is individually try/caught and partial results are normal.
 */

import log from "electron-log";

const logger = log.scope("marta-world");

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

export interface StageState {
  /** Surface id currently on the Stage, or null when it is empty. */
  surfaceId: string | null;
  /** Params that surface was summoned with. */
  params?: Record<string, unknown>;
  /** Other surfaces in the current split, if any. */
  alsoShowing?: string[];
}

export interface ActiveProject {
  id: number;
  name: string;
  path?: string;
  /** True when its dev server is running. */
  running?: boolean;
  branch?: string;
  uncommittedFiles?: number;
}

export interface ResidentModel {
  kind: string;
  modelId: string;
  vramMb: number;
}

/**
 * Marta's own placement. She needs to know it because it changes what she
 * should promise: on the CPU she is several times slower, so "give me a
 * moment" is honest rather than evasive.
 */
export interface CompanionModel {
  modelId: string;
  placement: "gpu" | "cpu";
  /** True while she is deliberately staying off the card to avoid thrashing. */
  thrashLatched?: boolean;
}

export interface RunningWork {
  kind:
    | "flow"
    | "mission"
    | "media"
    | "download"
    | "terminal"
    | "claude"
    | "local";
  id: string;
  label: string;
  /** 0–100 when known. */
  progress?: number;
  /** True when this is blocked waiting for the user. */
  awaitingUser?: boolean;
}

export interface RecentArtifact {
  kind: string;
  label: string;
  path?: string;
}

export interface WorldState {
  stage: StageState;
  project: ActiveProject | null;
  resident: ResidentModel | null;
  companion: CompanionModel | null;
  freeVramMb: number | null;
  totalVramMb: number | null;
  gpu: string | null;
  running: RunningWork[];
  recentArtifacts: RecentArtifact[];
  /** Sources that threw while collecting. Rendered so Marta can hedge. */
  degraded: string[];
}

/**
 * One getter per section. All optional: an unwired source is simply absent
 * from the digest, which is what lets P0 land before the runtime exists.
 */
export interface WorldStateSources {
  stage?: () => StageState | Promise<StageState>;
  project?: () => ActiveProject | null | Promise<ActiveProject | null>;
  resident?: () => ResidentModel | null | Promise<ResidentModel | null>;
  companion?: () => CompanionModel | null | Promise<CompanionModel | null>;
  vram?: () => Promise<{
    freeMb: number | null;
    totalMb: number | null;
    gpu: string | null;
  }>;
  running?: () => RunningWork[] | Promise<RunningWork[]>;
  recentArtifacts?: () => RecentArtifact[] | Promise<RecentArtifact[]>;
}

let sources: WorldStateSources = {};

export function setWorldStateSources(next: WorldStateSources): void {
  sources = { ...sources, ...next };
}

export function _resetWorldStateForTests(): void {
  sources = {};
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

async function attempt<T>(
  name: string,
  source: (() => T | Promise<T>) | undefined,
  fallback: T,
  degraded: string[],
): Promise<T> {
  if (!source) return fallback;
  try {
    return await source();
  } catch (error) {
    logger.warn(`World-state source "${name}" failed:`, error);
    degraded.push(name);
    return fallback;
  }
}

export async function collectWorldState(): Promise<WorldState> {
  const degraded: string[] = [];

  const [stage, project, resident, companion, vram, running, recentArtifacts] =
    await Promise.all([
      attempt<StageState>(
        "stage",
        sources.stage,
        { surfaceId: null },
        degraded,
      ),
      attempt<ActiveProject | null>("project", sources.project, null, degraded),
      attempt<ResidentModel | null>(
        "resident",
        sources.resident,
        null,
        degraded,
      ),
      attempt<CompanionModel | null>(
        "companion",
        sources.companion,
        null,
        degraded,
      ),
      attempt<{
        freeMb: number | null;
        totalMb: number | null;
        gpu: string | null;
      }>(
        "vram",
        sources.vram,
        { freeMb: null, totalMb: null, gpu: null },
        degraded,
      ),
      attempt<RunningWork[]>("running", sources.running, [], degraded),
      attempt<RecentArtifact[]>(
        "recentArtifacts",
        sources.recentArtifacts,
        [],
        degraded,
      ),
    ]);

  return {
    stage,
    project,
    resident,
    companion,
    freeVramMb: vram.freeMb,
    totalVramMb: vram.totalMb,
    gpu: vram.gpu,
    running,
    recentArtifacts,
    degraded,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Render the digest for the system prompt.
 *
 * Written as terse labelled lines rather than JSON: small models follow prose
 * structure more reliably than they parse nested objects, and it costs roughly
 * half the tokens. Empty sections are omitted entirely — a line reading
 * "Running: none" teaches the model that a "Running:" line is noise, whereas
 * its absence teaches nothing.
 */
export function renderWorldState(state: WorldState): string {
  const lines: string[] = [];

  if (state.stage.surfaceId) {
    const params =
      state.stage.params && Object.keys(state.stage.params).length > 0
        ? ` (${JSON.stringify(state.stage.params)})`
        : "";
    const also = state.stage.alsoShowing?.length
      ? ` alongside ${state.stage.alsoShowing.join(", ")}`
      : "";
    lines.push(`On screen: ${state.stage.surfaceId}${params}${also}`);
  } else {
    lines.push("On screen: nothing — the Stage is empty.");
  }

  if (state.project) {
    const bits = [`"${state.project.name}" (id ${state.project.id})`];
    if (state.project.branch) bits.push(`branch ${state.project.branch}`);
    if (state.project.running) bits.push("dev server running");
    if (state.project.uncommittedFiles) {
      bits.push(`${state.project.uncommittedFiles} uncommitted files`);
    }
    lines.push(`Active project: ${bits.join(", ")}`);
  }

  if (state.gpu) {
    const vram =
      state.freeVramMb !== null && state.totalVramMb !== null
        ? `, ${Math.round(state.freeVramMb / 1024)}GB free of ${Math.round(state.totalVramMb / 1024)}GB`
        : "";
    lines.push(`GPU: ${state.gpu}${vram}`);
  }

  if (state.resident) {
    lines.push(
      `Model resident: ${state.resident.modelId} (${state.resident.kind}, ${Math.round(state.resident.vramMb / 1024)}GB)`,
    );
  }

  if (state.companion) {
    // Told to her in the second person because it is about her, and because a
    // CPU placement changes what she should promise about timing.
    const suffix =
      state.companion.placement === "cpu"
        ? state.companion.thrashLatched
          ? " — you are on CPU and staying there until the GPU frees up, so you are slower than usual"
          : " — you are on CPU while the GPU is busy, so you are slower than usual"
        : "";
    lines.push(
      `You are running as ${state.companion.modelId} on ${state.companion.placement.toUpperCase()}${suffix}`,
    );
  }

  if (state.running.length > 0) {
    const items = state.running.map((w) => {
      const progress = w.progress !== undefined ? ` ${w.progress}%` : "";
      const blocked = w.awaitingUser ? " — WAITING ON THE USER" : "";
      return `${w.kind}:${w.label}${progress}${blocked}`;
    });
    lines.push(`Running: ${items.join("; ")}`);
  }

  if (state.recentArtifacts.length > 0) {
    lines.push(
      `Recently produced: ${state.recentArtifacts
        .map((a) => `${a.kind} "${a.label}"`)
        .join(", ")}`,
    );
  }

  if (state.degraded.length > 0) {
    // Told to Marta on purpose: it is the difference between "there are no
    // running jobs" and "I could not find out whether there are running jobs".
    lines.push(
      `Unavailable this turn (do not assert these are empty): ${state.degraded.join(", ")}`,
    );
  }

  return lines.join("\n");
}
