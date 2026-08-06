/**
 * Marta's own llama-server: a second inference process, separate from the
 * engine the rest of the app drives.
 *
 * Why a second process rather than sharing the engine's: the engine is a slot
 * the user's work swaps models in and out of. Marta has to answer *while* that
 * is happening — that is the entire point of the companion tier — so she cannot
 * be a tenant of it.
 *
 * **What "demote" really does.** llama.cpp cannot move a loaded model between
 * GPU and CPU in place, so a demotion restarts the server with `n_gpu_layers`
 * at zero. The claim that her *session* survives is still true, and is what
 * matters: the conversation lives in `marta_runtime.ts`, not in the server's KV
 * cache. A restart costs latency and a re-prefill of the transcript; it does
 * not cost the conversation. Calling it "hot migration" would oversell it, so
 * the code calls it a restart and the user-facing wording says "slower".
 *
 * Concurrency: `LlamaServerBackend.start()` already stops any existing child
 * first, and every entry point here goes through one promise chain, so a
 * demote arriving mid-generation cannot interleave with a restart.
 */

import fs from "node:fs";
import path from "node:path";
import log from "electron-log";

import { LlamaServerBackend } from "@/main/llm/llama_server_backend";
import type { CompanionHooks, CompanionSlot } from "@/main/flow/model_gate";
import { recordInferenceSample } from "@/main/telemetry/live_telemetry";
import type { MartaTier } from "./model_ladder";
import { getMartaModelsRoot } from "./marta_model_store";

const logger = log.scope("marta-model");

/**
 * A port of its own, away from the engine's 11435 and clear of the range the
 * user's dev servers occupy.
 */
export const MARTA_PORT = 11_534;
const MARTA_HOST = "127.0.0.1";

/**
 * Marta's context window.
 *
 * Qwen3.5 supports 262K, but the KV cache is charged per token of *allocated*
 * context, not per token used — a 262K window would cost more VRAM than the
 * model. Her turns are a system prompt, a short transcript and a handful of
 * tool results; 16K is generous for that and keeps the working set at the size
 * the ladder's `vramMb` figures assume.
 */
// The local-agent system prompt plus one realistic workspace turn is already
// close to 30K tokens. A 16K companion could orchestrate Marta but failed the
// moment the user explicitly selected it as a private coding worker. Qwen3.5
// supports a much larger native window; 64K leaves room for tool results while
// remaining practical for the resident 4B rung on the machines that select it.
export const MARTA_CONTEXT_SIZE = 65_536;

/** Under this, a request has almost certainly hit a stuck server. */
const REQUEST_TIMEOUT_MS = 120_000;

export interface MartaChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Present on assistant messages that called tools. */
  tool_calls?: MartaToolCall[];
  /** Required on `tool` messages; ties the result to its call. */
  tool_call_id?: string;
}

export interface MartaToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface MartaToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface MartaCompletion {
  content: string;
  toolCalls: MartaToolCall[];
  /** Why generation stopped, as reported by llama-server. */
  finishReason: string | null;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
}

/** A token fragment emitted by llama-server's OpenAI-compatible SSE endpoint. */
export type MartaCompletionDeltaListener = (text: string) => void;

export interface MartaModelStatus {
  running: boolean;
  modelId: string | null;
  modelPath: string | null;
  placement: "gpu" | "cpu" | null;
  port: number | null;
  lastError: string | null;
}

/**
 * Where a downloaded ladder model lives on disk.
 *
 * The root is shared across Electron profiles, so development and the
 * packaged app reuse one download. It remains inside OrianBuilder's managed
 * model storage rather than an opaque private cache.
 */
export function martaModelsDir(): string {
  return path.join(getMartaModelsRoot(), "marta");
}

/** Where a given rung's weights live. One directory per tier. */
export function martaTierDir(tier: MartaTier): string {
  return path.join(martaModelsDir(), tier.id);
}

/**
 * Resolve the GGUF for a tier, or null when it has not been downloaded.
 *
 * Scoped to the tier's own directory, not a scan of the whole models folder.
 * A flat scan would happily hand back the 2B file when asked for the 4B, and
 * everything downstream — the ladder's label, the VRAM arithmetic the gate
 * uses to decide whether she fits beside a heavy model — would then be quietly
 * describing a different model than the one that is running.
 *
 * Within the directory it *is* a scan, because quantisation suffixes vary
 * between publishers and re-quantisations, and pinning one filename would make
 * a perfectly good download invisible.
 */
export function resolveMartaModelPath(tier: MartaTier): string | null {
  let entries: string[];
  try {
    entries = fs.readdirSync(martaTierDir(tier));
  } catch {
    return null;
  }
  // Skip the multimodal projector: it is a companion file, not the model.
  const gguf = entries
    .filter((f) => f.toLowerCase().endsWith(".gguf"))
    .filter((f) => !f.toLowerCase().startsWith("mmproj"))
    .sort();
  return gguf.length > 0 ? path.join(martaTierDir(tier), gguf[0]) : null;
}

/**
 * The best rung this machine can actually run *right now*.
 *
 * The ladder says what the hardware deserves; this says what is on disk. When
 * they disagree — a 16GB card whose 4B download has not finished — running the
 * smaller rung that *is* downloaded beats refusing to start. A slower Marta is
 * a working Marta, and the alternative is an orchestrator that is silent until
 * a multi-gigabyte download completes.
 *
 * Never walks *up* the ladder: a rung the hardware cannot hold is not an
 * option however available its weights are.
 */
export function findDownloadedTier(
  preferred: MartaTier,
  ladder: ReadonlyArray<MartaTier>,
): { tier: MartaTier; downgraded: boolean } | null {
  const from = ladder.findIndex((t) => t.id === preferred.id);
  const candidates = from >= 0 ? ladder.slice(from) : [preferred];
  for (const tier of candidates) {
    if (resolveMartaModelPath(tier)) {
      return { tier, downgraded: tier.id !== preferred.id };
    }
  }
  return null;
}

/** The vision projector beside the model, when one was downloaded. */
export function resolveMartaMmprojPath(modelPath: string): string | null {
  try {
    const dir = path.dirname(modelPath);
    const mmproj = fs
      .readdirSync(dir)
      .find(
        (f) =>
          f.toLowerCase().startsWith("mmproj") &&
          f.toLowerCase().endsWith(".gguf"),
      );
    return mmproj ? path.join(dir, mmproj) : null;
  } catch {
    return null;
  }
}

export class MartaModel {
  private readonly backend = new LlamaServerBackend();
  private tier: MartaTier | null = null;
  private modelPath: string | null = null;
  private placement: "gpu" | "cpu" | null = null;
  /** Serialises start/stop/restart against in-flight generations. */
  private queue: Promise<unknown> = Promise.resolve();

  getStatus(): MartaModelStatus {
    const status = this.backend.getStatus();
    return {
      running: status.running,
      modelId: this.tier?.modelId ?? null,
      modelPath: this.modelPath,
      placement: status.running ? this.placement : null,
      port: status.port,
      lastError: status.lastError,
    };
  }

  get baseUrl(): string {
    return `http://${MARTA_HOST}:${MARTA_PORT}`;
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /**
   * Wait for any in-flight start, demotion or restore to finish.
   *
   * `LlamaServerStatus.running` means "the child process is alive", which is
   * true from the moment it spawns — several seconds *before* `/health` accepts
   * a request. Trusting it and posting anyway is how a turn taken right after
   * launch (or immediately after a GPU→CPU demotion) came back as the words
   * "fetch failed", which tells the user nothing and reads as a broken app.
   *
   * Only lifecycle operations go through `this.queue`; generations do not. So
   * awaiting it here costs nothing during normal conversation and converts that
   * race into a short wait.
   */
  private async whenSettled(): Promise<void> {
    await this.queue.catch(() => {
      // A failed start is reported by the `running` check below, with the
      // backend's own error rather than a rejection from an unrelated caller.
    });
  }

  /**
   * Start (or restart) the server for `tier` at `placement`.
   *
   * Throws when the model has not been downloaded — the caller decides whether
   * that is a setup prompt or a silent skip, because "Marta is unavailable" is
   * a very different message during onboarding than mid-conversation.
   */
  private async launch(
    tier: MartaTier,
    placement: "gpu" | "cpu",
  ): Promise<void> {
    const modelPath = resolveMartaModelPath(tier);
    if (!modelPath) {
      throw new Error(
        `${tier.label} is not downloaded. Expected a .gguf under ${martaTierDir(tier)}.`,
      );
    }

    await this.backend.start({
      modelPath,
      mmprojPath: resolveMartaMmprojPath(modelPath),
      host: MARTA_HOST,
      port: MARTA_PORT,
      contextSize: MARTA_CONTEXT_SIZE,
      // `--jinja` is what turns on llama-server's OpenAI-compatible tool
      // calling. Without it the model emits tool calls as prose and the whole
      // orchestration loop silently degrades to chat.
      enableJinjaTools: true,
      // CPU placement is n_gpu_layers=0; GPU placement leaves it unset, which
      // resolves to "all".
      ...(placement === "cpu"
        ? { gpuLayersMode: "manual" as const, manualGpuLayers: 0 }
        : {}),
      // One slot: her turns are serialised by the runtime anyway, and extra
      // slots duplicate the context working set.
      parallelSlots: 1,
      // She is not the app's inference engine; keep her off the Engine
      // surface's poller and log.
      telemetry: false,
    });

    this.tier = tier;
    this.modelPath = modelPath;
    this.placement = placement;
    logger.info(
      `Marta model up: ${tier.label} on ${placement} at ${this.baseUrl}`,
    );
  }

  start(tier: MartaTier, placement: "gpu" | "cpu"): Promise<void> {
    return this.run(() => this.launch(tier, placement));
  }

  stop(): Promise<void> {
    return this.run(async () => {
      await this.backend.stop();
      this.placement = null;
      logger.info("Marta model stopped.");
    });
  }

  /** Restart at a different placement, keeping the same tier. */
  private async moveTo(placement: "gpu" | "cpu"): Promise<void> {
    if (!this.tier) return;
    if (this.placement === placement) return;
    logger.info(`Marta model moving ${this.placement} → ${placement}`);
    await this.launch(this.tier, placement);
  }

  /**
   * The gate's view of this model. Wired with `setCompanionHooks`.
   *
   * The slot the gate passes carries the placement it wants; the tier comes
   * from here because the gate has no business knowing about model files.
   */
  hooks(resolveTier: (modelId: string) => MartaTier | null): CompanionHooks {
    return {
      load: async (slot: CompanionSlot) => {
        const tier = resolveTier(slot.modelId);
        if (!tier) {
          throw new Error(`Unknown Marta tier for model "${slot.modelId}".`);
        }
        await this.run(() => this.launch(tier, slot.placement));
      },
      unload: async () => {
        await this.run(async () => {
          await this.backend.stop();
          this.placement = null;
        });
      },
      demote: async () => {
        await this.run(() => this.moveTo("cpu"));
      },
      restore: async () => {
        await this.run(() => this.moveTo("gpu"));
      },
    };
  }

  /**
   * One completion. Tool calls come back structured; the caller decides what to
   * execute and loops.
   *
   * Non-streaming on purpose for now: the turn loop needs the complete tool
   * call before it can act, and streaming a partial function-call JSON buys
   * nothing. Streaming matters for the *narration* pass, which is a separate
   * call and lands with the voice bus.
   */
  async complete(
    messages: MartaChatMessage[],
    options: {
      tools?: MartaToolDefinition[];
      temperature?: number;
      maxTokens?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<MartaCompletion> {
    await this.whenSettled();
    const status = this.backend.getStatus();
    if (!status.running) {
      throw new Error(
        status.lastError
          ? `Marta's model is not running: ${status.lastError}`
          : "Marta's model is not running.",
      );
    }

    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    options.signal?.addEventListener("abort", () => controller.abort(), {
      once: true,
    });

    try {
      const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages,
          ...(options.tools?.length ? { tools: options.tools } : {}),
          // Low but not zero: orchestration wants the obvious tool, and a
          // deterministic decode makes a wrong choice repeat forever when the
          // model is asked again after a failure.
          temperature: options.temperature ?? 0.2,
          max_tokens: options.maxTokens ?? 1_024,
          stream: false,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `Marta's model returned ${response.status}: ${body.slice(0, 500)}`,
        );
      }

      const json = (await response.json()) as {
        choices?: Array<{
          message?: {
            content?: string | null;
            tool_calls?: MartaToolCall[];
          };
          finish_reason?: string;
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };

      const choice = json.choices?.[0];
      const completion: MartaCompletion = {
        content: choice?.message?.content ?? "",
        toolCalls: choice?.message?.tool_calls ?? [],
        finishReason: choice?.finish_reason ?? null,
        promptTokens: json.usage?.prompt_tokens ?? 0,
        completionTokens: json.usage?.completion_tokens ?? 0,
        durationMs: Date.now() - startedAt,
      };
      this.recordTelemetry(completion, null);
      return completion;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Complete a turn through llama-server's Server-Sent Events endpoint.
   *
   * Tool calls are still collected before the caller acts on them, but ordinary
   * narration is delivered as it is generated.  This is deliberately here
   * rather than in IPC: cancelling the browser stream must abort the actual
   * inference request, not merely stop rendering its tokens.
   */
  async completeStream(
    messages: MartaChatMessage[],
    options: {
      tools?: MartaToolDefinition[];
      temperature?: number;
      maxTokens?: number;
      signal?: AbortSignal;
    } = {},
    onDelta: MartaCompletionDeltaListener = () => {},
  ): Promise<MartaCompletion> {
    await this.whenSettled();
    const status = this.backend.getStatus();
    if (!status.running) {
      throw new Error(
        status.lastError
          ? `Marta's model is not running: ${status.lastError}`
          : "Marta's model is not running.",
      );
    }

    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    options.signal?.addEventListener("abort", () => controller.abort(), {
      once: true,
    });

    try {
      const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages,
          ...(options.tools?.length ? { tools: options.tools } : {}),
          temperature: options.temperature ?? 0.2,
          max_tokens: options.maxTokens ?? 1_024,
          stream: true,
          // llama-server emits usage in the terminal chunk when this OpenAI
          // extension is supported; older builds simply omit it.
          stream_options: { include_usage: true },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `Marta's model returned ${response.status}: ${body.slice(0, 500)}`,
        );
      }
      if (!response.body) {
        throw new Error("Marta's model did not return a streaming body.");
      }

      let content = "";
      let finishReason: string | null = null;
      let promptTokens = 0;
      let completionTokens = 0;
      // Measured, not estimated: prompt processing dominates first-token
      // latency on a demoted (CPU) placement and is the number that tells the
      // user why she suddenly feels slow.
      let firstTokenAt: number | null = null;
      const toolCalls = new Map<number, MartaToolCall>();
      const decoder = new TextDecoder();
      let pending = "";

      const consume = (line: string) => {
        const payload = line.trim();
        if (!payload.startsWith("data:")) return;
        const data = payload.slice(5).trim();
        if (!data || data === "[DONE]") return;

        let chunk: {
          choices?: Array<{
            delta?: {
              content?: string | null;
              tool_calls?: Array<{
                index?: number;
                id?: string;
                type?: "function";
                function?: { name?: string; arguments?: string };
              }>;
            };
            finish_reason?: string | null;
          }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        try {
          chunk = JSON.parse(data);
        } catch {
          // SSE can carry a non-JSON keepalive from some llama-server builds.
          return;
        }

        const choice = chunk.choices?.[0];
        const delta = choice?.delta;
        if (typeof delta?.content === "string" && delta.content) {
          firstTokenAt ??= Date.now();
          content += delta.content;
          onDelta(delta.content);
        }
        for (const partial of delta?.tool_calls ?? []) {
          const index = partial.index ?? 0;
          const previous = toolCalls.get(index) ?? {
            id: "",
            type: "function" as const,
            function: { name: "", arguments: "" },
          };
          toolCalls.set(index, {
            id: partial.id ?? previous.id,
            type: partial.type ?? previous.type,
            function: {
              // OpenAI-compatible servers may split both the function name
              // and JSON arguments over several deltas.
              name: previous.function.name + (partial.function?.name ?? ""),
              arguments:
                previous.function.arguments +
                (partial.function?.arguments ?? ""),
            },
          });
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (chunk.usage) {
          promptTokens = chunk.usage.prompt_tokens ?? promptTokens;
          completionTokens = chunk.usage.completion_tokens ?? completionTokens;
        }
      };

      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? "";
        for (const line of lines) consume(line);
      }
      pending += decoder.decode();
      if (pending.trim()) consume(pending);

      const completion: MartaCompletion = {
        content,
        toolCalls: [...toolCalls.values()],
        finishReason,
        promptTokens,
        completionTokens,
        durationMs: Date.now() - startedAt,
      };
      this.recordTelemetry(
        completion,
        firstTokenAt === null ? null : firstTokenAt - startedAt,
      );
      return completion;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Publish this call's measured throughput.
   *
   * Recorded here rather than in the turn loop because the turn loop makes
   * several calls per turn: attributing them to one "turn" would hide the fact
   * that a tool round is much cheaper than the round that writes the answer,
   * which is exactly what the inference surface exists to show.
   */
  private recordTelemetry(
    completion: MartaCompletion,
    timeToFirstTokenMs: number | null,
  ): void {
    recordInferenceSample({
      actor: "Marta companion",
      modelId: this.tier?.modelId ?? null,
      promptTokens: completion.promptTokens,
      completionTokens: completion.completionTokens,
      durationMs: completion.durationMs,
      timeToFirstTokenMs,
      contextSize: MARTA_CONTEXT_SIZE,
    });
  }
}

let singleton: MartaModel | null = null;

export function getMartaModel(): MartaModel {
  if (!singleton) singleton = new MartaModel();
  return singleton;
}

export function _resetMartaModelForTests(): void {
  singleton = null;
}

/**
 * Kill her model on app quit.
 *
 * Fire-and-forget by necessity: Electron's `will-quit` cannot await, and a
 * promise that resolves after the process is gone is worthless. Going straight
 * to the backend rather than through the gate is deliberate for the same
 * reason — the gate serialises on a queue that will not drain in time.
 *
 * Without this the llama-server child outlives the app, holding ~5GB of VRAM
 * and port 11534 until the machine reboots.
 */
export function stopMartaModelOnQuit(): void {
  if (!singleton) return;
  void singleton.stop().catch(() => {
    // Quitting anyway.
  });
}
