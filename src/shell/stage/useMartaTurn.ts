/**
 * Renderer-side Marta turn coordinator.
 *
 * The main process owns context and tool execution; this hook owns visible
 * transcript state, Stage navigation, and the live narration bridge used by
 * the voice session.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useSetAtom } from "jotai";
import { useQueryClient } from "@tanstack/react-query";

import {
  ipc,
  martaTurnStreamClient,
  type LocalModel,
  type MartaDelegationSelection,
  type MartaTurnEvent,
} from "@/ipc/types";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import { queryKeys } from "@/lib/queryKeys";
import { focusSurfaceAtom, showSurfaceAtom } from "./stage_state";
import { focusedTaskIdAtom } from "./task_state";
import { applyStageLayoutCommandAtom } from "./workspace_state";
import {
  resolveDelegationReply,
  type DelegationConversationContext,
} from "./delegation_conversation";

export interface TranscriptEntry {
  role: "user" | "assistant";
  content: string;
  /** Tool activity that happened while producing an assistant reply. */
  steps?: { label: string; ok: boolean; detail: string }[];
  /**
   * A milestone Marta reported without being asked.
   *
   * Rendered differently, and deliberately *not* written into her durable
   * conversation: the append-only task ledger is already the record of what
   * happened, and replaying every status line into the model's context would
   * spend her window describing work she can simply look up.
   */
  proactive?: boolean;
  /** Set only on proactive entries, which need to be de-duplicated by id. */
  narrationId?: string;
}

export interface PendingApproval {
  actionId: string;
  /** The utterance that triggered it, replayed verbatim once approved. */
  text: string;
}

export interface PendingDelegationChoice {
  requestId: string;
  appId: number;
  goal: string;
  readOnly: boolean;
  /** Original utterance, replayed without adding a duplicate chat bubble. */
  text: string;
  /** Partial natural-language answers, e.g. Claude → Haiku → low effort. */
  conversation?: DelegationConversationContext;
}

export interface LiveMartaStep {
  id: string;
  label: string;
  status: "running" | "success" | "failed";
  detail?: string;
}

export interface MartaTurnSendOptions {
  /** Do not echo a user message when resuming an approval-gated request. */
  echoUser?: boolean;
  /** Called for each generated narration fragment, before the turn ends. */
  onTextDelta?: (text: string) => void;
  /** Called exactly once, when Marta first starts narrating. */
  onReplyStarted?: () => void;
}

async function listLocalCodingModels(): Promise<LocalModel[]> {
  const [lmStudio, ollama, downloaded, embedded, companion] = await Promise.all(
    [
      ipc.languageModel
        .listLMStudioModels()
        .catch(() => ({ models: [] as LocalModel[] })),
      ipc.languageModel
        .listOllamaModels()
        .catch(() => ({ models: [] as LocalModel[] })),
      ipc.languageModel
        .listEmbeddedModels()
        .catch(() => ({ models: [] as LocalModel[] })),
      ipc.embeddedModel.getStatus().catch(() => null),
      ipc.marta.getModelStatus().catch(() => null),
    ],
  );
  const models = [...lmStudio.models, ...ollama.models, ...downloaded.models];
  if (embedded?.modelLoaded && embedded.modelName) {
    models.push({
      provider: "embedded",
      modelName: embedded.modelName,
      displayName: `${embedded.modelName} · loaded`,
    });
  }
  if (companion?.running && companion.modelId) {
    models.push({
      provider: "marta",
      modelName: companion.modelId,
      displayName: `${companion.modelId} · companion`,
    });
  }
  return models;
}

function narrateImmediate(text: string, options: MartaTurnSendOptions): void {
  options.onReplyStarted?.();
  options.onTextDelta?.(text);
}

export function useMartaTurn() {
  const showSurface = useSetAtom(showSurfaceAtom);
  const focusSurface = useSetAtom(focusSurfaceAtom);
  const setSelectedAppId = useSetAtom(selectedAppIdAtom);
  const setFocusedTaskId = useSetAtom(focusedTaskIdAtom);
  const applyStageLayoutCommand = useSetAtom(applyStageLayoutCommandAtom);
  const queryClient = useQueryClient();
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingApproval | null>(null);
  const [delegationChoice, setDelegationChoice] =
    useState<PendingDelegationChoice | null>(null);
  const [liveReply, setLiveReply] = useState("");
  const [liveSteps, setLiveSteps] = useState<LiveMartaStep[]>([]);
  // Refs change synchronously, so a new spoken request immediately after
  // barge-in is not rejected by a render that still sees `busy: true`.
  const busyRef = useRef(false);
  const turnGenerationRef = useRef(0);
  const activeStreamRef = useRef<{
    turnId: string;
    resolve: (reply: string) => void;
  } | null>(null);

  // Main owns the conversation so a renderer reload or a model migration does
  // not erase the real context.
  useEffect(() => {
    void Promise.all([
      ipc.marta.getTranscript(),
      ipc.marta.getPendingDelegation(),
    ])
      .then(([{ messages }, { pending }]) => {
        setTranscript(
          messages.filter(
            (message): message is TranscriptEntry =>
              message.role === "user" || message.role === "assistant",
          ),
        );
        if (pending) {
          setDelegationChoice({ ...pending, text: pending.goal });
        }
      })
      .catch(() => {
        // Nothing to restore, or main is not up yet.
      });
  }, []);

  // A media/workflow pipeline can discover a build step after Marta's spoken
  // turn has already ended. Surface that later choice through the same prompt;
  // never let an asynchronous flow silently spend Claude tokens.
  useEffect(
    () =>
      ipc.events.marta.onDelegationChoice((choice) => {
        setDelegationChoice({ ...choice, text: choice.goal });
        void ipc.marta.setPendingDelegation({ pending: choice });
        setTranscript((previous) => [
          ...previous,
          {
            role: "assistant",
            content:
              "The workflow is ready for its coding step. Tell me which local or Claude model should continue, or ask me for the options.",
          },
        ]);
      }),
    [],
  );

  const runMartaTurn = useCallback(
    async (
      text: string,
      approvedActions: string[] = [],
      options: MartaTurnSendOptions = {},
      delegationSelection?: MartaDelegationSelection,
    ): Promise<string> => {
      const trimmed = text.trim();
      if (!trimmed || busyRef.current) return "";

      const generation = ++turnGenerationRef.current;
      busyRef.current = true;
      setBusy(true);
      setPending(null);
      setDelegationChoice(null);
      setLiveReply("");
      setLiveSteps([]);
      if (options.echoUser !== false) {
        setTranscript((previous) => [
          ...previous,
          { role: "user", content: trimmed },
        ]);
      }

      return new Promise<string>((resolve) => {
        const turnId = crypto.randomUUID();
        const steps: NonNullable<TranscriptEntry["steps"]> = [];
        const labels = new Map<string, string>();
        let blocked: string | null = null;
        let streamedText = "";
        let finalText = "";
        let streamError: string | null = null;
        let narrationStarted = false;

        const finish = (reply: string) => {
          if (activeStreamRef.current?.turnId === turnId) {
            activeStreamRef.current = null;
          }
          if (generation !== turnGenerationRef.current) {
            resolve("");
            return;
          }

          const spoken =
            streamError ??
            (reply ||
              finalText ||
              streamedText ||
              "I did not get anywhere with that. Could you say it another way?");
          setTranscript((previous) => [
            ...previous,
            {
              role: "assistant",
              content: spoken,
              steps: steps.length > 0 ? steps : undefined,
            },
          ]);
          setLiveReply("");
          setLiveSteps([]);
          if (blocked) setPending({ actionId: blocked, text: trimmed });
          void queryClient.invalidateQueries();
          busyRef.current = false;
          setBusy(false);
          resolve(spoken);
        };

        const onEvent = (event: MartaTurnEvent) => {
          if (generation !== turnGenerationRef.current) return;
          switch (event.kind) {
            case "surface":
              if (typeof event.params?.appId === "number") {
                setSelectedAppId(event.params.appId);
              }
              if (typeof event.params?.taskId === "string") {
                setFocusedTaskId(event.params.taskId);
              }
              (typeof event.params?.taskId === "string"
                ? focusSurface
                : showSurface)({
                surfaceId: event.surfaceId,
                params: event.params,
              });
              break;
            case "delegation-choice":
              setDelegationChoice({ ...event, text: trimmed });
              void ipc.marta.setPendingDelegation({
                pending: {
                  requestId: event.requestId,
                  appId: event.appId,
                  goal: event.goal,
                  readOnly: event.readOnly,
                },
              });
              break;
            case "tool-start":
              labels.set(event.id, event.label);
              setLiveSteps((previous) => [
                ...previous.filter((step) => step.id !== event.id),
                {
                  id: event.id,
                  label: event.label,
                  status: "running",
                },
              ]);
              if (event.needsApproval) blocked = event.label;
              break;
            case "tool-end":
              steps.push({
                label: labels.get(event.id) ?? "step",
                ok: event.ok,
                detail: event.detail,
              });
              setLiveSteps((previous) =>
                previous.map((step) =>
                  step.id === event.id
                    ? {
                        ...step,
                        status: event.ok ? "success" : "failed",
                        detail: event.detail,
                      }
                    : step,
                ),
              );
              break;
            case "text-delta":
              streamedText += event.text;
              setLiveReply(streamedText);
              if (!narrationStarted) {
                narrationStarted = true;
                options.onReplyStarted?.();
              }
              options.onTextDelta?.(event.text);
              break;
            case "text":
              finalText = event.text;
              break;
            case "error":
              // Cancellation is an expected barge-in outcome. `cancel` settles
              // the renderer promise and suppresses the delayed old response.
              if (event.message !== "Cancelled.") streamError = event.message;
              break;
            default:
              break;
          }
        };

        activeStreamRef.current = { turnId, resolve };
        martaTurnStreamClient.start(
          { turnId, text: trimmed, approvedActions, delegationSelection },
          {
            onChunk: ({ event }) => onEvent(event),
            onEnd: ({ text: reply }) => finish(reply),
            onError: ({ error }) => {
              streamError = `Something went wrong: ${error}`;
              finish("");
            },
          },
        );
      });
    },
    [
      focusSurface,
      queryClient,
      setFocusedTaskId,
      setSelectedAppId,
      showSurface,
    ],
  );

  /** Discard the visible result and abort the main-process model request. */
  const cancel = useCallback(() => {
    turnGenerationRef.current += 1;
    busyRef.current = false;
    setBusy(false);
    setPending(null);
    setDelegationChoice(null);
    void ipc.marta.setPendingDelegation({ pending: null });
    setLiveReply("");
    setLiveSteps([]);
    const active = activeStreamRef.current;
    if (active) {
      martaTurnStreamClient.cancel(active.turnId);
      activeStreamRef.current = null;
      active.resolve("");
    }
    void ipc.marta.cancelActiveTurn().catch(() => {
      // The generation guard still prevents an old reply from rendering if main
      // has already gone away during a surface change.
    });
  }, []);

  const approve = useCallback(async () => {
    if (!pending) return;
    const { actionId, text } = pending;
    setPending(null);
    await runMartaTurn(text, [actionId], { echoUser: false });
  }, [pending, runMartaTurn]);

  const chooseDelegation = useCallback(
    async (
      selection: MartaDelegationSelection,
      userReply: string,
      options: MartaTurnSendOptions = {},
    ): Promise<string> => {
      if (!delegationChoice) return "";
      const request = delegationChoice;
      setDelegationChoice(null);
      busyRef.current = true;
      setBusy(true);
      setLiveReply("");
      setTranscript((previous) => [
        ...previous,
        { role: "user", content: userReply },
      ]);
      setLiveSteps([
        {
          id: request.requestId,
          label: "delegate.code",
          status: "running",
        },
      ]);
      try {
        const result = await ipc.marta.startDelegation({
          requestId: request.requestId,
          appId: request.appId,
          goal: request.goal,
          readOnly: request.readOnly,
          userReply,
          selection,
        });
        setTranscript((previous) => [
          ...previous,
          {
            role: "assistant",
            content: result.summary,
            steps: [
              {
                label: "delegate.code",
                ok: result.ok,
                detail: result.summary,
              },
            ],
          },
        ]);
        void queryClient.invalidateQueries();
        narrateImmediate(result.summary, options);
        return result.summary;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Could not start the task.";
        setTranscript((previous) => [
          ...previous,
          { role: "assistant", content: message },
        ]);
        narrateImmediate(message, options);
        return message;
      } finally {
        setLiveReply("");
        setLiveSteps([]);
        busyRef.current = false;
        setBusy(false);
      }
    },
    [delegationChoice, queryClient],
  );

  const respondToDelegation = useCallback(
    async (
      text: string,
      options: MartaTurnSendOptions = {},
    ): Promise<string> => {
      const trimmed = text.trim();
      const request = delegationChoice;
      if (!trimmed || !request || busyRef.current) return "";

      busyRef.current = true;
      setBusy(true);
      const localModels = await listLocalCodingModels();
      const resolution = resolveDelegationReply(
        trimmed,
        localModels,
        request.conversation,
      );

      if (resolution.kind === "select") {
        // `chooseDelegation` owns the busy state through the actual task start.
        return chooseDelegation(resolution.selection, trimmed, options);
      }

      const response = resolution.response;
      setTranscript((previous) => [
        ...previous,
        { role: "user", content: trimmed },
        { role: "assistant", content: response },
      ]);
      if (resolution.kind === "cancel") {
        setDelegationChoice(null);
        void ipc.marta.setPendingDelegation({ pending: null });
      } else {
        const pendingChoice = {
          ...request,
          conversation: resolution.context,
        };
        setDelegationChoice(pendingChoice);
        void ipc.marta.setPendingDelegation({ pending: pendingChoice });
      }
      await ipc.marta
        .appendConversation({ user: trimmed, assistant: response })
        .catch(() => {
          // The visible conversation remains useful if persistence is briefly
          // unavailable during a hot reload.
        });
      narrateImmediate(response, options);
      busyRef.current = false;
      setBusy(false);
      return response;
    },
    [chooseDelegation, delegationChoice],
  );

  /**
   * Record a milestone Marta narrated on her own.
   *
   * Idempotent by narration id because the main-process coordinator can
   * re-emit an aggregate that overlaps a previous one, and every open window
   * receives the same broadcast.
   */
  const noteProactiveNarration = useCallback(
    (narration: { id: string; text: string }) => {
      setTranscript((previous) => {
        if (previous.some((entry) => entry.narrationId === narration.id)) {
          return previous;
        }
        return [
          ...previous,
          {
            role: "assistant" as const,
            content: narration.text,
            proactive: true,
            narrationId: narration.id,
          },
        ];
      });
    },
    [],
  );

  /** Stop / retry / reprioritise, reported by outcome rather than by intent. */
  const runTaskControl = useCallback(
    (command: {
      taskId: string;
      taskTitle: string;
      action: "stop" | "retry" | "prioritize";
      priority?: number;
    }) => {
      const { taskId, taskTitle, action, priority } = command;
      void ipc.marta
        .controlTask(
          action === "prioritize"
            ? { taskId, action, priority: priority ?? 100 }
            : { taskId, action },
        )
        .then((outcome) =>
          noteProactiveNarration({
            id: `control:${taskId}:${action}:${outcome.ok}`,
            text: outcome.summary,
          }),
        )
        .catch((error: unknown) =>
          noteProactiveNarration({
            id: `control:${taskId}:${action}:error`,
            text: `I could not ${action} ${taskTitle}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          }),
        );
    },
    [noteProactiveNarration],
  );

  /**
   * One input path for keyboard and microphone. While a coding choice is
   * pending, natural language is resolved deterministically and remains in
   * that conversation; otherwise it is a normal Marta model turn.
   */
  const send = useCallback(
    (
      text: string,
      approvedActions: string[] = [],
      options: MartaTurnSendOptions = {},
      delegationSelection?: MartaDelegationSelection,
    ): Promise<string> => {
      const layoutResult = applyStageLayoutCommand(text);
      if (layoutResult?.command.kind === "control-task") {
        // Executed here rather than inside the atom because it is a
        // main-process call that can fail, and the user has to be told what
        // actually happened. An optimistic "stopping task two" for a stop that
        // never landed is the same false confidence the acceptance contract
        // exists to eliminate.
        runTaskControl(layoutResult.command);
      }
      const hasNonLayoutRequest =
        /\b(?:why|explain|what happened|also|then|and (?:tell|fix|run|build|research|check))\b/i.test(
          text,
        );
      if (layoutResult && !hasNonLayoutRequest) {
        const trimmed = text.trim();
        const response = layoutResult.acknowledgement;
        setTranscript((previous) => [
          ...previous,
          { role: "user", content: trimmed },
          { role: "assistant", content: response },
        ]);
        void ipc.marta
          .appendConversation({ user: trimmed, assistant: response })
          .catch(() => {
            // Layout remains applied if persistence is unavailable during a
            // hot reload. Main is still the durable owner when it is healthy.
          });
        narrateImmediate(response, options);
        return Promise.resolve(response);
      }
      if (
        delegationChoice &&
        approvedActions.length === 0 &&
        !delegationSelection
      ) {
        return respondToDelegation(text, options);
      }
      return runMartaTurn(text, approvedActions, options, delegationSelection);
    },
    [
      applyStageLayoutCommand,
      delegationChoice,
      respondToDelegation,
      runMartaTurn,
      runTaskControl,
    ],
  );

  const clear = useCallback(async () => {
    await ipc.marta.clearTranscript();
    setTranscript([]);
    setPending(null);
    setDelegationChoice(null);
    setLiveReply("");
    setLiveSteps([]);
    void queryClient.invalidateQueries({ queryKey: queryKeys.marta.all });
  }, [queryClient]);

  return {
    transcript,
    busy,
    pending,
    delegationChoice,
    liveReply,
    liveSteps,
    send,
    approve,
    clear,
    cancel,
    noteProactiveNarration,
  };
}
