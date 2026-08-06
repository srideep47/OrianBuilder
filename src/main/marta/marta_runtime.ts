/**
 * Marta's turn loop: digest → retrieve → plan → call → narrate.
 *
 * The conversation lives here, in main-process memory, deliberately. It is what
 * makes the companion tier's promise true — when the gate restarts her model on
 * the CPU to free the GPU, the transcript is untouched and the next turn simply
 * re-prefills it. If history lived in the server's KV cache, a demotion would
 * silently amnesia her mid-sentence.
 *
 * Delegation is not implemented here. Marta *routes* to the flow runner, Claude
 * Code and missions; those executors are wired in by `setDelegateExecutor` so
 * this module stays free of their dependency graphs and testable without a
 * database, a GPU, or Electron.
 */

import log from "electron-log";
import type { MartaDelegationSelection } from "@/ipc/types/marta";

import { buildGraph, getAction } from "./graph/build_graph";
import { selectActions } from "./graph/retrieval";
import { SURFACES_BY_ID } from "./graph/surfaces";
import { collectWorldState, renderWorldState } from "./graph/world_state";
import { invokeAction, summariseActionResult } from "./invoke_action";
import { getMartaModel, type MartaChatMessage } from "./marta_model";
import { inferDelegationSelectionFromUtterance } from "./delegation_selection";
import {
  actionsToTools,
  buildSystemPrompt,
  delegatesToTools,
  DELEGATE_PREFIX,
  SURFACE_TOOL,
  surfaceTool,
  toolNameToActionId,
  toolNameToDelegateId,
} from "./prompt";
import {
  MartaTranscriptDeltaSanitizer,
  safeMartaAssistantText,
  sanitizeMartaTranscriptText,
} from "./transcript_sanitizer";

const logger = log.scope("marta-runtime");

/**
 * Tool calls allowed in one turn before the loop gives up.
 *
 * A small model that has misunderstood the task will keep calling the same tool
 * with slightly different arguments forever. Six is enough for a genuine
 * multi-step answer (look up a project, read its state, show a surface) and
 * short enough that a confused turn fails in seconds rather than minutes.
 */
export const MAX_TOOL_ROUNDS = 6;

/** How many prior messages to carry. Older turns are dropped, not summarised. */
export const MAX_HISTORY_MESSAGES = 24;

/**
 * Facts about Marta's own resident companion are already supplied by trusted
 * main-process state. A 4B tool caller can otherwise confuse those with the
 * separate engine model in Settings, so answer this narrow identity question
 * deterministically instead of asking the model to rediscover it.
 */
export function answerMartaIdentityFromWorldState(
  userText: string,
  worldState: string,
): string | null {
  // Keep this deliberately phrasing-specific. Broad keyword checks such as
  // `your + model + GPU` also match genuine work requests (for example, "use
  // your 35B model and propose a GPU handoff policy") and bypass delegation.
  const asksOwnRuntime =
    /\b(?:which|what)\s+(?:(?:marta(?:'s)?|your)\s+)?(?:model|llm)\s+(?:(?:is\s+(?:marta\s+)?)|(?:are\s+you\s+))?(?:currently\s+|right\s+now\s+)?(?:running|using|loaded)\b/i.test(
      userText,
    ) ||
    /\b(?:which|what)\s+(?:model|llm)\s+(?:is\s+marta|are\s+you)\s+(?:currently\s+|right\s+now\s+)?(?:running|using)\b/i.test(
      userText,
    );
  if (!asksOwnRuntime) return null;

  const match = worldState.match(
    /You are running as (.+?) on (GPU|CPU)(?:\s|$|â€”)/i,
  );
  if (!match) return null;
  return `I'm running as ${match[1]} on ${match[2].toUpperCase()}. Orion's selected big engine model is separate from me.`;
}

// ─── Events ──────────────────────────────────────────────────────────────────

export type MartaTurnEvent =
  | { kind: "thinking" }
  | { kind: "tool-start"; id: string; label: string; needsApproval: boolean }
  | { kind: "tool-end"; id: string; ok: boolean; detail: string }
  | { kind: "surface"; surfaceId: string; params?: Record<string, unknown> }
  | {
      kind: "delegation-choice";
      requestId: string;
      appId: number;
      goal: string;
      readOnly: boolean;
    }
  /** A narration fragment. The renderer can show and speak it immediately. */
  | { kind: "text-delta"; text: string }
  | { kind: "text"; text: string }
  | { kind: "done"; text: string; rounds: number; durationMs: number }
  | { kind: "error"; message: string };

export type MartaTurnListener = (event: MartaTurnEvent) => void;

// ─── Delegation ──────────────────────────────────────────────────────────────

export interface DelegateRequest {
  delegateId: string;
  args: Record<string, unknown>;
  /** Exact turn text, supplied by the trusted runtime rather than rewritten by the model. */
  userText: string;
  delegationSelection?: MartaDelegationSelection;
  signal?: AbortSignal;
}

export interface DelegateResult {
  ok: boolean;
  /** What to tell the model happened. */
  summary: string;
  /** Durable ledger identity for background work, when one was created. */
  taskId?: string;
  choice?: {
    requestId: string;
    appId: number;
    goal: string;
    readOnly: boolean;
  };
}

export type DelegateExecutor = (
  request: DelegateRequest,
) => Promise<DelegateResult>;

let delegateExecutor: DelegateExecutor | null = null;
let memoryDigestProvider: ((projectId?: number) => Promise<string>) | null =
  null;

/** Wire the heavy executors. Called from the IPC layer, which owns those deps. */
export function setDelegateExecutor(executor: DelegateExecutor | null): void {
  delegateExecutor = executor;
}

/** Inject durable cross-chat/project memory without coupling the turn loop to disk. */
export function setMartaMemoryDigestProvider(
  provider: ((projectId?: number) => Promise<string>) | null,
): void {
  memoryDigestProvider = provider;
}

// ─── Approvals ───────────────────────────────────────────────────────────────

/**
 * Approvals granted for this turn, keyed by action id.
 *
 * Per-turn rather than per-session on purpose: "yes, delete that file" must not
 * authorise deleting a different file ten minutes later.
 */
export interface TurnOptions {
  approvedActions?: string[];
  delegationSelection?: MartaDelegationSelection;
  signal?: AbortSignal;
}

// ─── Runtime ─────────────────────────────────────────────────────────────────

export class MartaRuntime {
  private history: MartaChatMessage[] = [];

  /** The conversation so far, excluding the system message. */
  getHistory(): MartaChatMessage[] {
    return [...this.history];
  }

  /** Restore the durable conversational portion saved by the IPC owner. */
  replaceHistory(history: MartaChatMessage[]): void {
    this.history = history.map((message) =>
      message.role === "assistant" && !message.tool_calls
        ? {
            ...message,
            content: safeMartaAssistantText(message.content),
          }
        : message,
    );
    this.trimHistory();
  }

  clearHistory(): void {
    this.history = [];
  }

  /** Record a renderer-resolved voice/text choice in durable conversation. */
  appendUserMessage(content: string): void {
    this.history.push({ role: "user", content });
    this.trimHistory();
  }

  /** Record a system-executed delegation result in the durable conversation. */
  appendAssistantMessage(content: string): void {
    this.history.push({
      role: "assistant",
      content: safeMartaAssistantText(content),
    });
    this.trimHistory();
  }

  /**
   * Drop the oldest turns once history grows past the cap.
   *
   * Truncation, not summarisation: summarising costs a whole extra generation
   * on a model that is already the latency budget, and Marta's turns are
   * short-lived requests rather than a long narrative. A `tool` message can
   * never lead the history — an orphaned tool result with no preceding call is
   * a hard error in the OpenAI message format, not a soft one.
   */
  private trimHistory(): void {
    if (this.history.length <= MAX_HISTORY_MESSAGES) return;
    let start = this.history.length - MAX_HISTORY_MESSAGES;
    while (
      start < this.history.length &&
      (this.history[start].role === "tool" ||
        (this.history[start].role === "assistant" &&
          this.history[start].tool_calls))
    ) {
      start += 1;
    }
    this.history = this.history.slice(start);
  }

  async runTurn(
    userText: string,
    options: TurnOptions = {},
    onEvent: MartaTurnListener = () => {},
  ): Promise<string> {
    const startedAt = Date.now();
    // A cancelled turn must not poison the next one with a half-finished user
    // request or orphaned tool protocol messages. Work that already reached a
    // real tool is not undone here; its history, however, is not presented as
    // a completed conversational turn.
    const historyBeforeTurn = [...this.history];
    const approved = new Set(options.approvedActions ?? []);
    // A complete choice in the original request is authoritative. The Stage's
    // follow-up chooser remains the fallback for partial phrases, but Marta
    // must not ask again after "with Claude Haiku, low effort" already said it.
    const delegationSelection =
      options.delegationSelection ??
      inferDelegationSelectionFromUtterance(userText);

    const graph = buildGraph();
    const worldSnapshot = await collectWorldState();
    const durableMemory = memoryDigestProvider
      ? await memoryDigestProvider(worldSnapshot.project?.id)
      : "No durable facts yet.";
    const worldState = `${renderWorldState(worldSnapshot)}\n\nDurable memory (preferences and verified outcomes only):\n${durableMemory}`;
    const actions = selectActions(userText);

    const tools = [
      ...actionsToTools(actions),
      ...delegatesToTools(graph.delegates),
      surfaceTool(graph.surfaces),
    ];

    this.history.push({ role: "user", content: userText });
    this.trimHistory();

    const identityAnswer = answerMartaIdentityFromWorldState(
      userText,
      worldState,
    );
    if (identityAnswer) {
      this.history.push({ role: "assistant", content: identityAnswer });
      this.trimHistory();
      onEvent({ kind: "text", text: identityAnswer });
      onEvent({
        kind: "done",
        text: identityAnswer,
        rounds: 0,
        durationMs: Date.now() - startedAt,
      });
      return identityAnswer;
    }

    const model = getMartaModel();
    let rounds = 0;
    let finalText = "";

    while (rounds < MAX_TOOL_ROUNDS) {
      if (options.signal?.aborted) {
        this.history = historyBeforeTurn;
        onEvent({ kind: "error", message: "Cancelled." });
        return "";
      }
      onEvent({ kind: "thinking" });

      // On the last round the tools are withheld, which forces a text answer.
      // Without this a confused model spends its final round on yet another
      // tool call and the turn ends with a canned apology instead of whatever
      // it had actually worked out. Removing the option is far more reliable
      // than asking a 2–4B model to stop.
      const lastRound = rounds === MAX_TOOL_ROUNDS - 1;

      let completion;
      try {
        const finalRoundInstruction = lastRound
          ? "\n\nYou have no more tool calls left. Answer the user now, in one or two sentences, using what you already know. If you could not do what they asked, say so plainly."
          : "";
        const messages = [
          {
            role: "system" as const,
            content: `${buildSystemPrompt(worldState)}${finalRoundInstruction}`,
          },
          ...this.history,
        ];
        const completionOptions = {
          tools: lastRound ? undefined : tools,
          signal: options.signal,
        };
        // The real companion model always exposes `completeStream`. The
        // compatibility path keeps unit-test doubles and an older hot-reloaded
        // main process functional while still exercising the exact same turn
        // and tool protocol.
        const deltaSanitizer = new MartaTranscriptDeltaSanitizer();
        completion =
          typeof model.completeStream === "function"
            ? await model.completeStream(
                messages,
                completionOptions,
                (text) => {
                  for (const safeText of deltaSanitizer.push(text)) {
                    onEvent({ kind: "text-delta", text: safeText });
                  }
                },
              )
            : await model.complete(messages, completionOptions);
        for (const safeText of deltaSanitizer.finish()) {
          onEvent({ kind: "text-delta", text: safeText });
        }
      } catch (error) {
        if (options.signal?.aborted) {
          this.history = historyBeforeTurn;
          onEvent({ kind: "error", message: "Cancelled." });
          return "";
        }
        const message = safeMartaAssistantText(
          error instanceof Error ? error.message : String(error),
        );
        logger.error("Completion failed:", error);
        onEvent({ kind: "error", message });
        return "";
      }

      if (completion.toolCalls.length === 0) {
        finalText = safeMartaAssistantText(completion.content);
        this.history.push({ role: "assistant", content: finalText });
        this.trimHistory();
        onEvent({ kind: "text", text: finalText });
        break;
      }

      rounds += 1;
      this.history.push({
        role: "assistant",
        content: completion.content ?? "",
        tool_calls: completion.toolCalls,
      });

      for (const call of completion.toolCalls) {
        const detail = await this.executeToolCall(
          call,
          approved,
          onEvent,
          userText,
          options.signal,
          delegationSelection,
        );
        this.history.push({
          role: "tool",
          tool_call_id: call.id,
          content: detail,
        });
      }
      this.trimHistory();
    }

    if (rounds >= MAX_TOOL_ROUNDS && !finalText) {
      // Say so rather than returning empty. Silence after a spoken request is
      // the worst possible failure mode for a voice assistant.
      finalText =
        "I went round in circles on that one and stopped. Could you tell me more specifically what you want?";
      this.history.push({ role: "assistant", content: finalText });
      onEvent({ kind: "text", text: finalText });
    }

    const durationMs = Date.now() - startedAt;
    onEvent({ kind: "done", text: finalText, rounds, durationMs });
    logger.info(`turn done in ${durationMs}ms after ${rounds} tool round(s)`);
    return finalText;
  }

  /** Run one tool call and return the string the model should read back. */
  private async executeToolCall(
    call: { id: string; function: { name: string; arguments: string } },
    approved: Set<string>,
    onEvent: MartaTurnListener,
    userText: string,
    signal?: AbortSignal,
    delegationSelection?: MartaDelegationSelection,
  ): Promise<string> {
    const name = call.function.name;

    let args: Record<string, unknown> = {};
    if (call.function.arguments?.trim()) {
      try {
        args = JSON.parse(call.function.arguments) as Record<string, unknown>;
      } catch {
        // Small models do emit malformed JSON. Report it so the model can
        // retry rather than failing the turn.
        const detail = `Your arguments for ${name} were not valid JSON. Send a single JSON object.`;
        onEvent({ kind: "tool-end", id: call.id, ok: false, detail });
        return detail;
      }
    }

    // ── Surfaces ──
    if (name === SURFACE_TOOL) {
      const surfaceId = String(args.surfaceId ?? "");
      const surface = SURFACES_BY_ID.get(surfaceId);
      if (!surface) {
        const detail = `No surface called "${surfaceId}".`;
        onEvent({ kind: "tool-end", id: call.id, ok: false, detail });
        return detail;
      }
      const params = (args.params as Record<string, unknown>) ?? undefined;
      onEvent({ kind: "surface", surfaceId, params });
      onEvent({
        kind: "tool-end",
        id: call.id,
        ok: true,
        detail: `Showing ${surface.title}.`,
      });
      return `Showing ${surface.title} on screen.`;
    }

    // ── Delegates ──
    if (name.startsWith(DELEGATE_PREFIX)) {
      const delegateId = toolNameToDelegateId(name);
      onEvent({
        kind: "tool-start",
        id: call.id,
        label: delegateId,
        needsApproval: false,
      });
      if (!delegateExecutor) {
        const detail = `${delegateId} is not available in this build.`;
        onEvent({ kind: "tool-end", id: call.id, ok: false, detail });
        return detail;
      }
      try {
        const result = await delegateExecutor({
          delegateId,
          args,
          userText,
          delegationSelection,
          signal,
        });
        if (result.choice) {
          onEvent({ kind: "delegation-choice", ...result.choice });
        }
        const visibleDetail =
          sanitizeMartaTranscriptText(result.summary) ||
          (result.ok ? "Delegate started." : "The delegate failed.");
        onEvent({
          kind: "tool-end",
          id: call.id,
          ok: result.ok,
          detail: visibleDetail,
        });
        return result.summary;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const visibleDetail =
          sanitizeMartaTranscriptText(detail) || "The delegate failed.";
        onEvent({
          kind: "tool-end",
          id: call.id,
          ok: false,
          detail: visibleDetail,
        });
        return detail;
      }
    }

    // ── Actions ──
    const actionId = toolNameToActionId(name);
    // `needsApproval` is about the *gate*, not about whether an approval
    // happens to be present. Reporting `true` for every unapproved call made
    // the UI offer to approve reads, which trains the user to click through
    // approvals — the exact instinct the gate exists to preserve.
    const gated = getAction(actionId)?.confirm ?? false;
    onEvent({
      kind: "tool-start",
      id: call.id,
      label: actionId,
      needsApproval: gated && !approved.has(actionId),
    });

    const result = await invokeAction(actionId, args, {
      approved: approved.has(actionId),
    });

    const detail = result.ok
      ? summariseActionResult(actionId, result.data)
      : (result.error ?? "Failed.");
    const visibleDetail =
      sanitizeMartaTranscriptText(detail) ||
      (result.ok ? "Tool completed." : "Tool failed.");
    onEvent({
      kind: "tool-end",
      id: call.id,
      ok: result.ok,
      detail: visibleDetail,
    });
    return detail;
  }
}

let singleton: MartaRuntime | null = null;

export function getMartaRuntime(): MartaRuntime {
  if (!singleton) singleton = new MartaRuntime();
  return singleton;
}

export function _resetMartaRuntimeForTests(): void {
  singleton = null;
  delegateExecutor = null;
  memoryDigestProvider = null;
}
