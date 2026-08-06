/**
 * Executing one action on Marta's behalf.
 *
 * This is the enforcement point. Everything upstream — retrieval, the model's
 * tool list, the prompt — is advisory: a language model can emit any string it
 * likes, including the name of a contract it was never shown. So the checks
 * here do not trust that the caller already checked:
 *
 *   1. the action must be in `ACTION_REGISTRY` (default deny);
 *   2. a handler must actually be registered for its channel;
 *   3. arguments are validated against the contract's own Zod schema, the same
 *      one the renderer path validates against;
 *   4. anything gated must arrive with an explicit approval token.
 *
 * Failures are returned, not thrown. A tool call that fails is a normal event
 * in an agent loop — the model needs to read the error and try something else,
 * and an exception here would end the turn instead.
 */

import { BrowserWindow, type IpcMainInvokeEvent } from "electron";
import log from "electron-log";

import { getRegisteredHandler } from "@/ipc/handlers/base";
import { getAction, prepareHandlerInput } from "./graph/build_graph";

const logger = log.scope("marta-invoke");

export interface ActionCallResult {
  ok: boolean;
  /** Handler return value, when `ok`. */
  data?: unknown;
  /** Written for the model to read and recover from, not for a user. */
  error?: string;
  /** Set when the call was refused for needing approval it did not have. */
  needsConfirmation?: boolean;
  durationMs: number;
}

export interface InvokeOptions {
  /**
   * True when the user has approved this specific call. Gated actions refuse
   * without it. Deliberately a parameter rather than ambient state: an
   * approval must be attached to a call, not to a session.
   */
  approved?: boolean;
}

/**
 * A stand-in for the `IpcMainInvokeEvent` a renderer would have supplied.
 *
 * Only 24 of the app's 340 typed handlers bind the event at all, and those use
 * it to parent a dialog or reply to a specific window. Pointing `sender` at the
 * main window is right for both. `null` when no window exists — a handler that
 * needs one will throw, which is caught below and reported as a tool failure
 * rather than taking down the turn.
 */
function syntheticEvent(): IpcMainInvokeEvent {
  const win =
    BrowserWindow.getFocusedWindow() ??
    BrowserWindow.getAllWindows()[0] ??
    null;
  return {
    sender: win?.webContents ?? null,
    senderFrame: null,
    frameId: 0,
    processId: 0,
    preventDefault: () => {},
    defaultPrevented: false,
  } as unknown as IpcMainInvokeEvent;
}

function fail(
  error: string,
  startedAt: number,
  extra: Partial<ActionCallResult> = {},
): ActionCallResult {
  return { ok: false, error, durationMs: Date.now() - startedAt, ...extra };
}

/**
 * Call a granted action.
 *
 * `args` arrives in the shape the tool schema advertised, which for the ~27
 * contracts taking a bare scalar means `{ value: ... }`. Unwrapping happens
 * here rather than at the call site so every caller — turn loop, command
 * palette, tests — gets it right by construction.
 */
export async function invokeAction(
  actionId: string,
  args: Record<string, unknown> = {},
  options: InvokeOptions = {},
): Promise<ActionCallResult> {
  const startedAt = Date.now();

  const action = getAction(actionId);
  if (!action) {
    // Covers both a hallucinated name and a real contract that was never
    // granted. The message deliberately does not distinguish them: telling the
    // model "that exists but you may not use it" invites it to keep trying.
    return fail(
      `No such action: "${actionId}". Use one of the actions you were given.`,
      startedAt,
    );
  }

  if (action.confirm && !options.approved) {
    return fail(
      `"${actionId}" changes things outside this app or is destructive, so it needs the user's explicit approval first. Ask them, then call it again once they agree.`,
      startedAt,
      { needsConfirmation: true },
    );
  }

  return callHandler(action.channel, prepareHandlerInput(actionId, args), {
    label: actionId,
    startedAt,
  });
}

/**
 * Call an IPC handler directly, skipping the grant check.
 *
 * **Not for model output.** This is for trusted main-process code — the
 * delegate executors — which legitimately needs endpoints Marta is not granted
 * as raw actions. `claudeCode.startTurn` is the clearest case: she must be able
 * to hand a coding task to Claude Code, and she must *not* be able to call
 * `claudeCode.startTurn` herself with arguments she invented, because the
 * delegate is where the app id is validated and the permission mode is chosen.
 *
 * Zod validation still applies. The grant is a policy about the *caller*; the
 * schema is a fact about the *endpoint*, and skipping it would just move
 * crashes deeper into the app.
 */
export async function callHandler(
  channel: string,
  input: unknown,
  options: { label?: string; startedAt?: number } = {},
): Promise<ActionCallResult> {
  const startedAt = options.startedAt ?? Date.now();
  const label = options.label ?? channel;

  const registered = getRegisteredHandler(channel);
  if (!registered) {
    // The graph is built from contracts; handlers are registered separately.
    // A contract with no handler means a real wiring gap, so this is logged as
    // an error rather than quietly returned.
    logger.error(`No handler registered for ${channel} (${label}).`);
    return fail(`"${label}" is not available in this build.`, startedAt);
  }

  const parsed = registered.contract.input.safeParse(input);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) =>
        issue.path.length
          ? `${issue.path.join(".")}: ${issue.message}`
          : issue.message,
      )
      .join("; ");
    // Returned verbatim: the field-level detail is exactly what lets the model
    // fix the call itself instead of giving up.
    return fail(`Invalid arguments for "${label}" — ${detail}`, startedAt);
  }

  try {
    const data = await registered.handler(syntheticEvent(), parsed.data);
    logger.info(`${label} ok in ${Date.now() - startedAt}ms`);
    return { ok: true, data, durationMs: Date.now() - startedAt };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`${label} failed: ${message}`);
    return fail(message, startedAt);
  }
}

/**
 * Trim a handler result down to something worth putting in a prompt.
 *
 * Several endpoints return a lot: `app.listApps` on a busy workspace, or a file
 * read, can be tens of kilobytes. Feeding that back verbatim burns the context
 * a small model needs for the actual task, so results are truncated with an
 * explicit marker — the model must be able to tell "that's all of it" from
 * "there was more".
 */
export function summariseResult(data: unknown, maxChars = 4_000): string {
  if (data === undefined || data === null) return "(no output)";
  let text: string;
  try {
    text = typeof data === "string" ? data : JSON.stringify(data);
  } catch {
    text = String(data);
  }
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…[truncated ${text.length - maxChars} more characters. Narrow the request if you need the rest.]`;
}

/**
 * Keep broad read endpoints useful without feeding private identifiers or an
 * entire preference database into the prompt and visible tool trace.
 */
export function summariseActionResult(actionId: string, data: unknown): string {
  if (
    actionId !== "settings.getUserSettings" ||
    !data ||
    typeof data !== "object" ||
    Array.isArray(data)
  ) {
    return summariseResult(data);
  }

  const settings = data as Record<string, unknown>;
  const embedded =
    settings.embeddedConfig && typeof settings.embeddedConfig === "object"
      ? (settings.embeddedConfig as Record<string, unknown>)
      : null;
  return summariseResult({
    note: "These are Orion engine preferences, not Marta's companion model. Marta's own model is in live world state.",
    selectedModel: settings.selectedModel,
    runtimeMode: settings.runtimeMode,
    selectedChatMode: settings.selectedChatMode,
    autonomousMode: settings.autonomousMode,
    orionNetworkEnabled: settings.orionNetworkEnabled,
    selectedTemplateId: settings.selectedTemplateId,
    selectedThemeId: settings.selectedThemeId,
    orionMediaModels: settings.orionMediaModels,
    embeddedConfig: embedded
      ? {
          modelPath: embedded.modelPath,
          inferenceBackend: embedded.inferenceBackend,
          contextSize: embedded.contextSize,
          gpuLayersMode: embedded.gpuLayersMode,
          manualGpuLayers: embedded.manualGpuLayers,
          selectedGpuModel: embedded.selectedGpuModel,
        }
      : undefined,
  });
}
