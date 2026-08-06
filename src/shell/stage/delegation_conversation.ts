import type {
  LocalModel,
  MartaDelegationConversation,
  MartaDelegationSelection,
} from "@/ipc/types";

export const CLAUDE_CODING_MODELS = [
  {
    id: "claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    hint: "lowest cost",
    aliases: ["haiku", "haiku 4.5", "claude haiku"],
  },
  {
    id: "claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    hint: "balanced",
    aliases: ["sonnet", "sonnet 4.6", "claude sonnet"],
  },
  {
    id: "claude-opus-4-7",
    label: "Claude Opus 4.7",
    hint: "most capable and highest usage",
    aliases: ["opus", "opus 4.7", "claude opus"],
  },
] as const;

export type DelegationConversationContext = MartaDelegationConversation;

export type DelegationConversationResolution =
  | {
      kind: "select";
      selection: MartaDelegationSelection;
    }
  | {
      kind: "reply";
      response: string;
      context: DelegationConversationContext;
    }
  | {
      kind: "cancel";
      response: string;
    };

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

function normalise(value: string): string {
  return value
    .toLowerCase()
    .replace(/[_/\\:-]+/g, " ")
    .replace(/[^a-z0-9.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function providerLabel(provider: LocalModel["provider"]): string {
  switch (provider) {
    case "lmstudio":
      return "LM Studio";
    case "ollama":
      return "Ollama";
    case "embedded":
      return "Orion Engine";
    case "marta":
      return "Marta companion";
  }
}

export function localModelKey(model: LocalModel): string {
  return `${model.provider}:${model.modelName}`;
}

export function localModelLabel(model: LocalModel): string {
  return `${model.displayName} (${providerLabel(model.provider)})`;
}

function uniqueLocalModels(models: LocalModel[]): LocalModel[] {
  return models.filter(
    (model, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.provider === model.provider &&
          candidate.modelName === model.modelName,
      ) === index,
  );
}

export function describeDelegationOptions(localModels: LocalModel[]): string {
  const unique = uniqueLocalModels(localModels);
  const visible = unique.slice(0, 8).map(localModelLabel);
  const local =
    visible.length > 0
      ? `Your available local models are ${visible.join(", ")}${
          unique.length > visible.length
            ? `, plus ${unique.length - visible.length} more`
            : ""
        }.`
      : "No local coding model is available right now. Start LM Studio or Ollama, or load a GGUF in Orion's Engine.";
  const claude = CLAUDE_CODING_MODELS.map(
    (model) => `${model.label} (${model.hint})`,
  ).join(", ");
  return `${local} Claude options are ${claude}. For Claude, also choose low, medium, high, extra-high, or max effort. You can say something like “local Qwen 4B” or “Claude Haiku, low effort.”`;
}

function asksForOptions(text: string): boolean {
  return (
    /\b(options?|choices?|available|which models?|what models?|list models?|show models?)\b/.test(
      text,
    ) || /\bwhat (can|could|should) i (use|choose|pick)\b/.test(text)
  );
}

function asksToCancel(text: string): boolean {
  return /^(cancel|stop|never mind|nevermind|do not start|don t start|forget it)\b/.test(
    text,
  );
}

function rememberFrom(text: string): boolean | undefined {
  if (/\b(don t|do not|never) remember\b|\bjust (this|one) time\b/.test(text)) {
    return false;
  }
  if (
    /\b(always|remember|make (it|this) (my )?default|from now on)\b/.test(text)
  ) {
    return true;
  }
  return undefined;
}

function effortFrom(text: string): (typeof EFFORTS)[number] | undefined {
  if (/\b(xhigh|x high|extra high|very high)\b/.test(text)) return "xhigh";
  if (/\b(max|maximum)\b/.test(text)) return "max";
  if (/\bhigh\b/.test(text)) return "high";
  if (/\bmedium\b|\bnormal effort\b/.test(text)) return "medium";
  if (/\blow\b|\bminimum effort\b/.test(text)) return "low";
  return undefined;
}

function claudeModelFrom(
  text: string,
): (typeof CLAUDE_CODING_MODELS)[number] | undefined {
  return CLAUDE_CODING_MODELS.find((model) =>
    [model.id, model.label, ...model.aliases].some((alias) =>
      text.includes(normalise(alias)),
    ),
  );
}

const MODEL_STOP_WORDS = new Set([
  "a",
  "agent",
  "ai",
  "coding",
  "do",
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
  "the",
  "this",
  "to",
  "use",
  "with",
]);

function modelTokens(value: string): string[] {
  return normalise(value)
    .split(" ")
    .filter((token) => token && !MODEL_STOP_WORDS.has(token));
}

function findLocalModel(
  text: string,
  models: LocalModel[],
): LocalModel | undefined {
  const requested = modelTokens(text);
  if (requested.length === 0) return undefined;

  const ranked = uniqueLocalModels(models)
    .map((model) => {
      const searchable = normalise(
        `${model.provider} ${model.modelName} ${model.displayName}`,
      );
      const compact = searchable.replace(/\s/g, "");
      let score = requested.reduce(
        (sum, token) => sum + (searchable.includes(token) ? 2 : 0),
        0,
      );
      const size = text.match(/\b\d+(?:\.\d+)?\s*b\b/)?.[0].replace(/\s/g, "");
      if (size && compact.includes(size)) score += 4;
      if (text.includes("marta") && model.provider === "marta") score += 5;
      if (text.includes("lm studio") && model.provider === "lmstudio")
        score += 3;
      if (text.includes("ollama") && model.provider === "ollama") score += 3;
      if (text.includes("embedded") && model.provider === "embedded")
        score += 3;
      // The already-running companion is the lowest-latency interpretation
      // when the same GGUF is visible through more than one local provider.
      if (model.provider === "marta") score += 0.25;
      return { model, score };
    })
    .sort((left, right) => right.score - left.score);

  if (!ranked[0] || ranked[0].score < 2) return undefined;
  if (ranked[1]?.score === ranked[0].score) return undefined;
  return ranked[0].model;
}

function claudeModelList(): string {
  return CLAUDE_CODING_MODELS.map(
    (model) => `${model.label} (${model.hint})`,
  ).join(", ");
}

function localModelList(models: LocalModel[]): string {
  const unique = uniqueLocalModels(models);
  if (unique.length === 0) {
    return "No local coding model is available. Start LM Studio or Ollama, or load a GGUF in Orion's Engine.";
  }
  return `Say the model you want: ${unique.slice(0, 8).map(localModelLabel).join(", ")}${
    unique.length > 8 ? `, plus ${unique.length - 8} more` : ""
  }.`;
}

/**
 * Resolve a spoken or typed answer without spending another model turn.
 * Context carries partial answers, so “Claude” → “Haiku” → “low effort” is a
 * natural three-message exchange as well as “Claude Haiku low” in one breath.
 */
export function resolveDelegationReply(
  rawText: string,
  localModels: LocalModel[],
  previous: DelegationConversationContext = {},
): DelegationConversationResolution {
  const text = normalise(rawText);
  if (asksToCancel(text)) {
    return {
      kind: "cancel",
      response: "Okay. I won't start that coding task.",
    };
  }
  if (asksForOptions(text)) {
    return {
      kind: "reply",
      response: describeDelegationOptions(localModels),
      context: previous,
    };
  }

  const explicitClaude = /\bclaude\b/.test(text);
  const explicitLocal = /\b(local|locally|offline|private|orion)\b/.test(text);
  const claudeModel = claudeModelFrom(text);
  const localModel = findLocalModel(text, localModels);
  const nextRemember = rememberFrom(text) ?? previous.remember;
  const nextEffort = effortFrom(text) ?? previous.effort;

  if ((explicitClaude || claudeModel) && (explicitLocal || localModel)) {
    return {
      kind: "reply",
      response:
        "I heard both local and Claude. Which one should run this task? You can include the model in the same reply.",
      context: {},
    };
  }

  const worker = claudeModel
    ? "claude"
    : localModel
      ? "local"
      : explicitClaude
        ? "claude"
        : explicitLocal
          ? "local"
          : previous.worker;

  if (worker === "claude") {
    const modelId =
      claudeModel?.id ??
      (previous.worker === "claude" ? previous.model : undefined);
    const context: DelegationConversationContext = {
      worker: "claude",
      model: modelId,
      effort: nextEffort,
      remember: nextRemember,
    };
    if (!modelId) {
      return {
        kind: "reply",
        response: `Which Claude model? ${claudeModelList()}. You can also say the effort level now.`,
        context,
      };
    }
    if (!nextEffort) {
      const label = CLAUDE_CODING_MODELS.find(
        (model) => model.id === modelId,
      )?.label;
      return {
        kind: "reply",
        response: `${label ?? "Claude"} selected. What effort should I use: low, medium, high, extra-high, or max?`,
        context,
      };
    }
    return {
      kind: "select",
      selection: {
        worker: "claude",
        model: modelId,
        effort: nextEffort,
        remember: nextRemember,
      },
    };
  }

  if (worker === "local") {
    const unique = uniqueLocalModels(localModels);
    const modelKey = localModel
      ? localModelKey(localModel)
      : previous.worker === "local"
        ? previous.model
        : unique.length === 1
          ? localModelKey(unique[0])
          : undefined;
    if (!modelKey) {
      return {
        kind: "reply",
        response: localModelList(unique),
        context: { worker: "local", remember: nextRemember },
      };
    }
    return {
      kind: "select",
      selection: {
        worker: "local",
        model: modelKey,
        remember: nextRemember,
      },
    };
  }

  if (nextEffort && previous.worker !== "claude") {
    return {
      kind: "reply",
      response:
        "That effort level applies to Claude. Should I use Claude, or a local model?",
      context: { effort: nextEffort, remember: nextRemember },
    };
  }

  return {
    kind: "reply",
    response:
      "Tell me which coding brain to use, or ask “what are my options?” You can answer by voice or text.",
    context: { ...previous, remember: nextRemember },
  };
}
