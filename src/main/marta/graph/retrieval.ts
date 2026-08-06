/**
 * Choosing which slice of the graph Marta sees this turn.
 *
 * She never sees all of it. Not because it would not fit — a 262K context and
 * ~110 granted actions would fit comfortably — but because a 4B model's tool
 * selection degrades sharply as the candidate list grows. Fewer, better
 * candidates beat exhaustive ones.
 *
 * The split is deliberate:
 *
 *   delegates — always all four. Which brain to hand the job to is *the*
 *               routing decision, and it must not depend on a lexical match.
 *   surfaces  — always all. They are the app's information architecture; if
 *               Marta cannot see a surface she will claim it does not exist.
 *   actions   — a pinned core plus the best lexical matches. The core is what
 *               orientation questions need ("what am I working on?"), which
 *               are asked constantly and whose phrasing rarely matches the
 *               action names.
 *
 * Lexical search (fuse.js, already a dependency) rather than embeddings. It is
 * synchronous, needs no model resident, and the search corpus is 110 short
 * curated strings written for exactly this purpose. Revisit only if recall
 * measurably fails — the seam is `selectActions`, not the whole module.
 */

import Fuse, { type IFuseOptions } from "fuse.js";

import { buildGraph } from "./build_graph";
import type { ActionNode, MartaGraph } from "./types";

/**
 * Always offered, regardless of the query.
 *
 * These answer "where am I and what is going on", which is the implicit
 * preamble to most real requests and is asked in words ("what am I doing?")
 * that match no action summary.
 */
export const CORE_ACTIONS: ReadonlyArray<string> = [
  "marta.listTasks",
  "marta.listGoals",
  "app.listApps",
  "app.searchApps",
  "settings.getUserSettings",
  "hardware.getProfile",
  "orchestrator.getStatus",
  "mediaQueue.list",
  "generatedMedia.list",
];

export interface RetrievalResult {
  actions: ActionNode[];
  graph: MartaGraph;
}

const MIN_TOKEN_LENGTH = 3;

const FUSE_OPTIONS: IFuseOptions<ActionNode> = {
  // Weighted so a hit in the hand-written summary or keywords outranks one in
  // the id. `github.push` should not win "push the changes" on the id alone
  // when a summary says it plainly.
  keys: [
    { name: "summary", weight: 0.5 },
    { name: "keywords", weight: 0.35 },
    { name: "id", weight: 0.15 },
  ],
  // Generous: users describe outcomes, not method names, so recall matters
  // more than precision. The pinned core plus a hard `limit` bounds the cost
  // of being wrong.
  threshold: 0.45,
  ignoreLocation: true,
  minMatchCharLength: MIN_TOKEN_LENGTH,
  includeScore: true,
};

/**
 * Words carrying no retrieval signal. Without this, "in", "the" and "my" match
 * fragments all over the corpus and drown the words that mattered.
 */
const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "these",
  "those",
  "you",
  "your",
  "our",
  "its",
  "his",
  "her",
  "them",
  "they",
  "can",
  "could",
  "would",
  "should",
  "will",
  "shall",
  "may",
  "might",
  "please",
  "just",
  "now",
  "then",
  "here",
  "there",
  "what",
  "which",
  "who",
  "how",
  "why",
  "when",
  "where",
  "into",
  "onto",
  "from",
  "about",
  "have",
  "has",
  "had",
  "was",
  "were",
  "are",
  "been",
  "being",
  "some",
  "any",
  "all",
  "one",
  "two",
  "get",
  "got",
  "let",
  "lets",
  "want",
  "need",
  "like",
  "make",
  "made",
  "does",
  "did",
  "doing",
]);

/**
 * Split an utterance into the words worth searching on.
 *
 * Fuse scores a whole query string against each field, so a long sentence
 * matched against a short keyword scores badly however good the match is:
 * "what changed in this project" never reaches the `"what changed"` keyword on
 * `git.getUncommittedFiles`. Searching token by token and combining the scores
 * fixes that, and costs nothing at this corpus size.
 */
function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= MIN_TOKEN_LENGTH && !STOPWORDS.has(t));
}

let fuse: Fuse<ActionNode> | null = null;

function index(): Fuse<ActionNode> {
  if (!fuse) fuse = new Fuse(buildGraph().actions, FUSE_OPTIONS);
  return fuse;
}

/**
 * Weight given to a hit on the full phrase, relative to a single token.
 *
 * A phrase match is much stronger evidence than any one word — "take a
 * screenshot of the game" matching `godot.viewport` as a phrase should beat
 * "game" alone matching four other things — so it is worth several tokens.
 */
const PHRASE_WEIGHT = 3;

function score(query: string): Map<string, number> {
  const scores = new Map<string, number>();
  const add = (id: string, value: number) => {
    scores.set(id, (scores.get(id) ?? 0) + value);
  };

  const trimmed = query.trim();
  if (trimmed.length >= MIN_TOKEN_LENGTH) {
    for (const hit of index().search(trimmed)) {
      // Fuse scores 0 = perfect, 1 = no match; invert so bigger is better.
      add(hit.item.id, (1 - (hit.score ?? 1)) * PHRASE_WEIGHT);
    }
  }

  for (const token of tokenize(query)) {
    for (const hit of index().search(token)) {
      add(hit.item.id, 1 - (hit.score ?? 1));
    }
  }

  return scores;
}

/**
 * The actions to offer for `query`: the pinned core, then the best matches, up
 * to `limit`. Core actions keep their pinned position rather than being
 * re-ranked, so their presence is predictable across turns — a model that
 * learned `app.listApps` is always there should keep finding it there.
 */
export function selectActions(query: string, limit = 28): ActionNode[] {
  const byId = new Map(buildGraph().actions.map((a) => [a.id, a]));

  const chosen: ActionNode[] = [];
  const taken = new Set<string>();

  for (const id of CORE_ACTIONS) {
    const action = byId.get(id);
    if (action) {
      chosen.push(action);
      taken.add(id);
    }
  }

  const ranked = [...score(query).entries()]
    .filter(([id]) => !taken.has(id))
    .sort((a, b) => b[1] - a[1]);

  for (const [id] of ranked) {
    if (chosen.length >= limit) break;
    const action = byId.get(id);
    if (action) chosen.push(action);
  }

  return chosen;
}

/** Everything Marta may use this turn. */
export function retrieve(query: string, limit?: number): RetrievalResult {
  return { actions: selectActions(query, limit), graph: buildGraph() };
}

/** Test seam — pairs with `_resetGraphForTests`. */
export function _resetRetrievalForTests(): void {
  fuse = null;
}
