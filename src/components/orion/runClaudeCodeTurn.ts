import { ipc } from "@/ipc/types";
import type { ClaudeEvent, ClaudeTurnUsage } from "@/ipc/types";

export interface ClaudeTurnHandlers {
  /** Assistant prose, appended as it streams. */
  onText?: (delta: string) => void;
  /** Extended-thinking text, if the model emits any. */
  onThinking?: (delta: string) => void;
  /** A tool the CLI is about to run with its own Read/Write/Edit/Bash. */
  onToolStart?: (tool: {
    id: string;
    name: string;
    input: Record<string, unknown>;
  }) => void;
  onToolEnd?: (tool: { id: string; ok: boolean; output: string }) => void;
  /** Cumulative cost and last-turn token counts. */
  onUsage?: (usage: ClaudeTurnUsage) => void;
  onSession?: (sessionId: string, model?: string) => void;
}

export interface ClaudeTurnResult {
  ok: boolean;
  error?: string;
  /** Everything the assistant said, joined. */
  text: string;
  usage: ClaudeTurnUsage | null;
}

/**
 * Drives one Claude Code turn from the renderer and resolves when it ends.
 *
 * Shared by the Orion command surface and the Build workspace so both speak to
 * the same runtime — the point of building it as a runtime rather than another
 * one-off `spawn` like the Design Studio had.
 */
export function runClaudeCodeTurn(params: {
  prompt: string;
  appId?: number;
  projectDir?: string;
  model?: string;
  effort?: "low" | "medium" | "high";
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan";
  fresh?: boolean;
  appendSystemPrompt?: string;
  handlers?: ClaudeTurnHandlers;
  /** Aborts the turn and kills the CLI process. */
  signal?: AbortSignal;
}): Promise<ClaudeTurnResult> {
  const turnId = `cc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  return new Promise<ClaudeTurnResult>((resolve) => {
    let text = "";
    let usage: ClaudeTurnUsage | null = null;
    let settled = false;

    const finish = (result: ClaudeTurnResult) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      params.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const onAbort = () => {
      void ipc.claudeCode.cancelTurn({ turnId });
      finish({ ok: false, error: "Cancelled.", text, usage });
    };

    const unsubscribe = ipc.events.claudeCode.onEvent((payload) => {
      if (payload.turnId !== turnId) return;
      const event = payload.event as ClaudeEvent;
      switch (event.kind) {
        case "session":
          params.handlers?.onSession?.(event.sessionId, event.model);
          return;
        case "text":
          text += event.delta;
          params.handlers?.onText?.(event.delta);
          return;
        case "thinking":
          params.handlers?.onThinking?.(event.delta);
          return;
        case "tool-start":
          params.handlers?.onToolStart?.({
            id: event.id,
            name: event.name,
            input: event.input,
          });
          return;
        case "tool-end":
          params.handlers?.onToolEnd?.({
            id: event.id,
            ok: event.ok,
            output: event.output,
          });
          return;
        case "usage":
          usage = event.usage;
          params.handlers?.onUsage?.(event.usage);
          return;
        case "done":
          finish({ ok: event.ok, error: event.error, text, usage });
          return;
        default:
          return;
      }
    });

    params.signal?.addEventListener("abort", onAbort, { once: true });

    void ipc.claudeCode
      .startTurn({
        turnId,
        appId: params.appId,
        projectDir: params.projectDir,
        prompt: params.prompt,
        model: params.model,
        effort: params.effort,
        permissionMode: params.permissionMode,
        fresh: params.fresh,
        appendSystemPrompt: params.appendSystemPrompt,
      })
      .then((res) => {
        if (!res.ok) {
          finish({ ok: false, error: res.error, text, usage });
        }
      })
      .catch((err: unknown) => {
        finish({ ok: false, error: String(err), text, usage });
      });
  });
}
