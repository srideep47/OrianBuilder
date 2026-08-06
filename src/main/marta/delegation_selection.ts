import type { LocalModel, MartaDelegationSelection } from "@/ipc/types";

/**
 * Claude model names accepted in natural speech.
 *
 * This intentionally lives in main rather than the Stage. A coding request can
 * enter Marta through voice, the compact chat, an automation, or a future
 * remote client; the trusted executor must make the same decision regardless
 * of which renderer happened to submit it.
 */
export const MARTA_CLAUDE_CODING_MODELS = [
  {
    id: "claude-haiku-4-5",
    aliases: ["haiku", "haiku 4.5", "claude haiku"],
  },
  {
    id: "claude-sonnet-4-6",
    aliases: ["sonnet", "sonnet 4.6", "claude sonnet"],
  },
  {
    id: "claude-opus-4-7",
    aliases: ["opus", "opus 4.7", "claude opus"],
  },
] as const;

function normalise(value: string): string {
  return value
    .toLowerCase()
    .replace(/[_/\\:-]+/g, " ")
    .replace(/[^a-z0-9.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function inferRemember(text: string): boolean | undefined {
  if (
    /\b(?:don t|do not|never) remember\b|\bjust (?:this|one) time\b/.test(text)
  ) {
    return false;
  }
  if (
    /\b(?:always|remember(?: this)?|from now on)\b|\bmake (?:it|this) (?:my )?default\b/.test(
      text,
    )
  ) {
    return true;
  }
  return undefined;
}

function inferEffort(
  text: string,
): MartaDelegationSelection["effort"] | undefined {
  if (/\b(?:xhigh|x high|extra high|very high)\b/.test(text)) return "xhigh";
  if (/\b(?:max|maximum)(?:imum)?(?: effort)?\b/.test(text)) return "max";
  if (/\bhigh effort\b|\bhigh\b/.test(text)) return "high";
  if (/\bmedium effort\b|\bnormal effort\b|\bmedium\b/.test(text)) {
    return "medium";
  }
  if (/\blow effort\b|\bminimum effort\b|\blow\b/.test(text)) return "low";
  return undefined;
}

function inferClaudeModel(text: string): string | undefined {
  return MARTA_CLAUDE_CODING_MODELS.find((model) =>
    [model.id, ...model.aliases].some((alias) =>
      text.includes(normalise(alias)),
    ),
  )?.id;
}

/** Whether the utterance tries to override the saved coding-worker default. */
export function mentionsDelegationSelection(rawText: string): boolean {
  const text = normalise(rawText);
  return (
    /\b(?:claude|anthropic|haiku|sonnet|opus|local|locally|offline|private|lm studio|lmstudio|ollama|embedded)\b/.test(
      text,
    ) || inferEffort(text) !== undefined
  );
}

const LOCAL_MODEL_STOP_WORDS = new Set([
  "a",
  "agent",
  "ai",
  "build",
  "coding",
  "do",
  "effort",
  "for",
  "i",
  "it",
  "local",
  "locally",
  "model",
  "one",
  "orion",
  "please",
  "run",
  "task",
  "the",
  "this",
  "to",
  "use",
  "with",
]);

function localModelTokens(value: string): string[] {
  return normalise(value)
    .split(" ")
    .filter((token) => token && !LOCAL_MODEL_STOP_WORDS.has(token));
}

function localModelKey(model: LocalModel): string {
  return `${model.provider}:${model.modelName}`;
}

/** Resolve an explicitly named installed model without guessing between ties. */
function inferLocalModel(
  text: string,
  localModels: readonly LocalModel[],
): string | undefined {
  const unique = localModels.filter(
    (model, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.provider === model.provider &&
          candidate.modelName === model.modelName,
      ) === index,
  );
  if (unique.length === 0) return undefined;

  const requested = localModelTokens(text);
  if (requested.length === 0) return undefined;
  const size = text.match(/\b\d+(?:\.\d+)?\s*b\b/)?.[0].replace(/\s/g, "");
  const ranked = unique
    .map((model) => {
      const searchable = normalise(
        `${model.provider} ${model.modelName} ${model.displayName}`,
      );
      const compact = searchable.replace(/\s/g, "");
      let score = requested.reduce(
        (sum, token) => sum + (searchable.includes(token) ? 2 : 0),
        0,
      );
      if (size && compact.includes(size)) score += 4;
      if (text.includes("lm studio") && model.provider === "lmstudio") {
        score += 3;
      }
      if (text.includes("ollama") && model.provider === "ollama") score += 3;
      if (text.includes("embedded") && model.provider === "embedded") {
        score += 3;
      }
      if (text.includes("marta") && model.provider === "marta") score += 3;
      return { key: localModelKey(model), score };
    })
    .sort((left, right) => right.score - left.score);

  if (!ranked[0] || ranked[0].score < 2) return undefined;
  if (ranked[1]?.score === ranked[0].score) return undefined;
  return ranked[0].key;
}

/**
 * Infer a *complete* coding-worker selection from the original utterance.
 *
 * Partial answers deliberately return undefined. That preserves the normal
 * conversational chooser for "use Claude" while allowing an already-complete
 * request such as "build it with Claude Haiku, low effort" to start without
 * asking the same question again.
 */
export function inferDelegationSelectionFromUtterance(
  rawText: string,
  localModels: readonly LocalModel[] = [],
): MartaDelegationSelection | undefined {
  const text = normalise(rawText);
  const claudeModel = inferClaudeModel(text);
  const explicitClaude = /\b(?:claude|anthropic)\b/.test(text) || !!claudeModel;
  const explicitLocal =
    /\b(?:local|locally|offline|private|lm studio|lmstudio|ollama|embedded)\b/.test(
      text,
    );
  const localModel = inferLocalModel(text, localModels);

  // Never silently choose when speech recognition produced both providers.
  if ((explicitClaude || claudeModel) && (explicitLocal || localModel)) {
    return undefined;
  }

  const remember = inferRemember(text);
  if (explicitClaude) {
    const effort = inferEffort(text);
    const explicitlyUsesAccountDefault =
      /\b(?:claude |account )?default(?: model)?\b/.test(text);
    if ((!claudeModel && !explicitlyUsesAccountDefault) || !effort) {
      return undefined;
    }
    return {
      worker: "claude",
      ...(claudeModel ? { model: claudeModel } : {}),
      effort,
      remember,
    };
  }

  if (explicitLocal || localModel) {
    if (!localModel) return undefined;
    return { worker: "local", model: localModel, remember };
  }

  return undefined;
}
