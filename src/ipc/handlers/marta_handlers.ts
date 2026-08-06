import { ipcMain } from "electron";
import log from "electron-log";

import {
  OrianBuilderError,
  OrianBuilderErrorKind,
} from "@/errors/orianbuilder_error";
import {
  martaContracts,
  martaTurnStreamContract,
  MartaTierIdSchema,
} from "../types/marta";
import { createTypedHandler } from "./base";

/** Every ladder rung, for resolving a model id back to its tier. */
const MARTA_TIER_IDS = MartaTierIdSchema.options;

import { buildGraph } from "@/main/marta/graph/build_graph";
import { allContractIds } from "@/main/marta/graph/contract_sources";
import { selectActions } from "@/main/marta/graph/retrieval";
import {
  collectWorldState,
  renderWorldState,
  setWorldStateSources,
  type ActiveProject,
  type RunningWork,
  type StageState,
} from "@/main/marta/graph/world_state";
import { getMediaJobQueue } from "@/main/media_queue/queue";
import { list as generatedMediaList } from "@/main/generated_media/store";
import { getCachedHardwareProfile } from "@/main/hardware/detect";
import { getAvailableVramMb } from "@/main/ipc/utils/vram_accounting";
import { getModelGate } from "@/main/flow/model_gate";
import {
  listActiveFlowActivities,
  listRecentFlowArtifacts,
} from "@/main/flow/activity_store";
import {
  getMartaResidency,
  initMartaResidency,
  whenMartaResidencyReady,
} from "@/main/marta/residency";
import {
  findDownloadedTier,
  getMartaModel,
  martaTierDir,
} from "@/main/marta/marta_model";
import {
  getMartaRuntime,
  setDelegateExecutor,
  type MartaTurnEvent,
} from "@/main/marta/marta_runtime";
import { executeDelegate } from "@/main/marta/delegates_executor";
import {
  getMartaPreferences,
  getPendingMartaDelegation,
  getStoredMartaHistory,
  saveMartaHistory,
  setPendingMartaDelegation,
  updateMartaPreferences,
} from "@/main/marta/marta_memory_store";
import {
  listMartaTaskEvents,
  listMartaTasks,
  loadMartaTasks,
} from "@/main/marta/task_registry";
import { getParallelExecutive } from "@/main/marta/parallel_executive_service";
import { controlMartaTask } from "@/main/marta/task_control";
import {
  safeMartaAssistantText,
  withoutTaskIdClause,
} from "@/main/marta/transcript_sanitizer";
import {
  findMartaTier,
  MARTA_CPU_TIER,
  MARTA_TIERS,
} from "@/main/marta/model_ladder";

const logger = log.scope("marta-handlers");

/**
 * The renderer's half of the digest. Held here rather than in `world_state.ts`
 * so that module stays free of IPC and testable on its own.
 */
let stageState: StageState = { surfaceId: null };

/** The project the user is looking at. Pushed from the renderer, like the stage. */
let activeProject: ActiveProject | null = null;

/** The one live turn. Marta has one llama.cpp slot, so concurrent turns must
 * replace rather than queue behind each other. */
let activeTurn: {
  controller: AbortController;
  completion: Promise<string>;
} | null = null;

let historyReady: Promise<void> | null = null;

function ensureMartaHistoryReady(): Promise<void> {
  if (!historyReady) {
    historyReady = getStoredMartaHistory().then((history) => {
      getMartaRuntime().replaceHistory(history);
    });
  }
  return historyReady;
}

/** How many recent outputs to name. Enough for "the one I just made". */
const RECENT_ARTIFACT_COUNT = 5;

/**
 * Wire the world-state sources that main can answer for itself.
 *
 * Everything here is best-effort by construction — `collectWorldState` catches
 * per-source failures — but the sources are still written to fail loudly rather
 * than return a plausible zero. "Free VRAM: unknown" is useful to Marta;
 * "Free VRAM: 0" would make her refuse work the machine could do.
 */
function wireWorldStateSources(): void {
  setWorldStateSources({
    stage: () => stageState,

    resident: () => {
      const slot = getModelGate().getResident();
      if (!slot) return null;
      return {
        kind: slot.kind,
        modelId: slot.modelId,
        vramMb: slot.vramMb,
      };
    },

    companion: () => {
      const slot = getModelGate().getCompanion();
      if (!slot) return null;
      return {
        modelId: slot.modelId,
        placement: slot.placement,
        thrashLatched: getMartaResidency().getStatus().thrashLatched,
      };
    },

    // The active project is renderer state — it is whichever project the user
    // is looking at, which main has no independent notion of. Pushed with the
    // stage state rather than pulled.
    project: () => activeProject,

    running: () => {
      const work: RunningWork[] = [];

      for (const task of listMartaTasks({ includeCompleted: false })) {
        work.push({
          kind: task.kind === "claude" ? "claude" : "local",
          id: task.id,
          label: `${task.title}${task.phase ? ` — ${task.phase}` : ""}`,
          awaitingUser: task.status === "waiting",
        });
      }

      for (const flow of listActiveFlowActivities()) {
        work.push({
          kind: "flow",
          id: flow.flowId,
          label: flow.goal,
          progress: flow.progress,
        });
      }

      for (const job of getMediaJobQueue().list()) {
        if (job.status !== "running" && job.status !== "queued") continue;
        // `stage` ("scene 3/12", "mux") rather than a percentage: media jobs
        // do not report one, and inventing a number from the status enum would
        // be a fiction the rail then displays as a progress bar.
        const label = job.prompt?.slice(0, 60) || job.kind;
        work.push({
          kind: "media",
          id: job.id,
          label: job.stage ? `${label} — ${job.stage}` : label,
        });
      }

      return work;
    },

    recentArtifacts: () => {
      // Newest first, and only a handful: this exists so she can say "the logo
      // I just made", not so she can enumerate the gallery.
      const flowArtifacts = listRecentFlowArtifacts(RECENT_ARTIFACT_COUNT).map(
        (artifact) => ({
          kind: artifact.kind,
          label: artifact.label,
          path: artifact.uri,
        }),
      );
      const generated = generatedMediaList()
        .slice(-RECENT_ARTIFACT_COUNT)
        .reverse()
        .map((item) => ({
          kind: item.kind,
          label: item.fileName,
          path: item.fileName,
        }));
      return [...flowArtifacts, ...generated]
        .filter(
          (item, index, all) =>
            all.findIndex(
              (candidate) =>
                candidate.kind === item.kind && candidate.path === item.path,
            ) === index,
        )
        .slice(0, RECENT_ARTIFACT_COUNT);
    },

    vram: async () => {
      const profile = await getCachedHardwareProfile();
      const gpu = profile.primaryGpu;
      // `getAvailableVramMb` returns 0 for a machine with no discrete GPU,
      // which reads identically to "a full card". Report null instead so the
      // digest says "unknown" and Marta doesn't refuse work on a CPU-only box.
      return {
        freeMb: gpu ? await getAvailableVramMb(profile) : null,
        totalMb: gpu?.vramMb ?? null,
        gpu: gpu ? `${gpu.model} (${profile.bestLlmBackend})` : null,
      };
    },
  });
}

/**
 * Bring Marta up on the best rung this machine can actually run.
 *
 * Shared by the Settings button and by boot, so a manual start and an automatic
 * one cannot diverge — a difference between them would show up as "it works
 * when I press the button" and be miserable to chase.
 */
async function startMarta(): Promise<void> {
  await whenMartaResidencyReady();
  const plan = getMartaResidency().getStatus().plan;
  if (!plan) {
    // Precondition, not Internal: hardware detection having failed is an
    // environment problem the user can act on, and it should not flood PostHog
    // as an exception.
    throw new OrianBuilderError(
      "Marta's hardware profile is not available yet.",
      OrianBuilderErrorKind.Precondition,
    );
  }

  // The ladder says what the hardware deserves; disk says what can run now.
  const available = findDownloadedTier(plan.tier, [
    ...MARTA_TIERS,
    MARTA_CPU_TIER,
  ]);
  if (!available) {
    throw new OrianBuilderError(
      `No Marta model is downloaded. Fetch ${plan.tier.label} into ${martaTierDir(plan.tier)}.`,
      OrianBuilderErrorKind.Precondition,
    );
  }
  if (available.downgraded) {
    logger.warn(
      `${plan.tier.label} is not downloaded; falling back to ${available.tier.label}.`,
    );
  }

  // Through the gate, not directly: it owns whether she gets the GPU, and
  // starting her behind its back would let her hold VRAM the gate is
  // simultaneously promising to a heavy model.
  await getModelGate().enterCompanion({
    modelId: available.tier.modelId,
    vramMb: available.tier.vramMb,
    preferredPlacement: plan.placement,
  });
}

/**
 * Start her at boot, quietly.
 *
 * An orchestrator that has to be switched on before it orchestrates anything is
 * not one. The one case that must stay silent is "no model downloaded" — a
 * fresh install has none, and an error toast on first launch about a component
 * the user has not heard of is noise. Settings shows the real reason.
 */
async function autoStartMarta(): Promise<void> {
  try {
    await startMarta();
    logger.info("Marta started automatically.");
  } catch (error) {
    logger.info(
      `Marta did not start automatically: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function registerMartaHandlers(): void {
  wireWorldStateSources();
  void loadMartaTasks();
  void ensureMartaHistoryReady();

  createTypedHandler(martaContracts.getGraph, async () => {
    const graph = buildGraph();
    return {
      actions: graph.actions.map(({ kind: _kind, ...action }) => action),
      surfaces: graph.surfaces.map(({ kind: _kind, ...surface }) => surface),
      delegates: graph.delegates.map(
        ({ kind: _kind, ...delegate }) => delegate,
      ),
      unregistered: graph.unregistered,
      orphaned: graph.orphaned,
      totalContracts: allContractIds().length,
    };
  });

  createTypedHandler(martaContracts.retrieve, async (_event, params) => {
    const actions = selectActions(params.query, params.limit);
    return { actions: actions.map(({ kind: _kind, ...action }) => action) };
  });

  createTypedHandler(martaContracts.getWorldState, async () => {
    const state = await collectWorldState();
    return { state, rendered: renderWorldState(state) };
  });

  createTypedHandler(martaContracts.setStageState, async (_event, next) => {
    stageState = next;
    activeProject = next.activeProject ?? null;
    return { ok: true as const };
  });

  createTypedHandler(martaContracts.getResidency, async () => {
    // Hardware detection takes roughly 700ms on a cold cache. Without this the
    // first caller after launch gets `plan: null` and reports the machine as
    // unsupported.
    await whenMartaResidencyReady();
    const status = getMartaResidency().getStatus();
    const gate = getModelGate();
    return {
      plan: status.plan
        ? {
            tierId: status.plan.tier.id,
            modelId: status.plan.tier.modelId,
            label: status.plan.tier.label,
            vramMb: status.plan.tier.vramMb,
            placement: status.plan.placement,
            speechNative: status.plan.tier.speechNative,
            rationale: status.plan.rationale,
          }
        : null,
      placement: gate.getCompanion()?.placement ?? null,
      recentDemotions: status.recentDemotions,
      thrashLatched: status.thrashLatched,
      budgetMb: gate.getVramBudgetMb(),
    };
  });

  createTypedHandler(martaContracts.getModelStatus, async () =>
    getMartaModel().getStatus(),
  );

  createTypedHandler(martaContracts.startModel, async () => {
    await startMarta();
    return getMartaModel().getStatus();
  });

  createTypedHandler(martaContracts.stopModel, async () => {
    await getModelGate().exitCompanion();
    return getMartaModel().getStatus();
  });

  createTypedHandler(martaContracts.setPlacement, async (_event, params) => {
    const gate = getModelGate();
    const current = gate.getCompanion();
    if (!current) {
      throw new OrianBuilderError(
        "Marta's model is not running.",
        OrianBuilderErrorKind.Precondition,
      );
    }
    // Re-entering with a new `preferredPlacement` is the whole mechanism: the
    // gate reconciles to it, and because it is a *preference* rather than a
    // gate-initiated demotion, it survives the card freeing up.
    await gate.enterCompanion({
      modelId: current.modelId,
      vramMb: current.vramMb,
      preferredPlacement: params.placement,
    });
    return getMartaModel().getStatus();
  });

  createTypedHandler(martaContracts.sendTurn, async (_event, params) => {
    await ensureMartaHistoryReady();
    await loadMartaTasks();
    // A second request can arrive just after a barge-in's renderer-side state
    // changed. Ensure the first fetch is actually gone before giving the
    // single llama-server slot to the replacement.
    if (activeTurn) {
      activeTurn.controller.abort();
      await activeTurn.completion.catch(() => {});
    }

    const events: MartaTurnEvent[] = [];
    const controller = new AbortController();
    const completion = getMartaRuntime().runTurn(
      params.text,
      {
        approvedActions: params.approvedActions,
        delegationSelection: params.delegationSelection,
        signal: controller.signal,
      },
      (event) => events.push(event),
    );
    activeTurn = { controller, completion };

    try {
      const text = await completion;
      await saveMartaHistory(getMartaRuntime().getHistory());
      return { text, events };
    } finally {
      if (activeTurn?.completion === completion) activeTurn = null;
    }
  });

  /**
   * Live narration for the Stage/voice bus.  The legacy `sendTurn` endpoint is
   * intentionally retained for callers that need a single result; interactive
   * surfaces use this channel so the first complete sentence can be spoken
   * before Marta has finished producing the rest of her answer.
   */
  ipcMain.handle(martaTurnStreamContract.channel, async (event, raw) => {
    const parsed = martaTurnStreamContract.input.safeParse(raw);
    if (!parsed.success) {
      throw new OrianBuilderError(
        `[${martaTurnStreamContract.channel}] Invalid input: ${parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")}`,
        OrianBuilderErrorKind.Validation,
      );
    }

    const { turnId, text, approvedActions, delegationSelection } = parsed.data;
    await ensureMartaHistoryReady();
    await loadMartaTasks();
    if (activeTurn) {
      activeTurn.controller.abort();
      await activeTurn.completion.catch(() => {});
    }

    const controller = new AbortController();
    const completion = getMartaRuntime().runTurn(
      text,
      { approvedActions, delegationSelection, signal: controller.signal },
      (eventPayload) => {
        event.sender.send(martaTurnStreamContract.events.chunk.channel, {
          turnId,
          event: eventPayload,
        });
      },
    );
    activeTurn = { controller, completion };

    try {
      const reply = await completion;
      await saveMartaHistory(getMartaRuntime().getHistory());
      event.sender.send(martaTurnStreamContract.events.end.channel, {
        turnId,
        text: reply,
      });
    } catch (error) {
      event.sender.send(martaTurnStreamContract.events.error.channel, {
        turnId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (activeTurn?.completion === completion) activeTurn = null;
    }
  });

  createTypedHandler(martaContracts.cancelActiveTurn, async () => {
    if (!activeTurn || activeTurn.controller.signal.aborted) {
      return { cancelled: false };
    }
    activeTurn.controller.abort();
    return { cancelled: true };
  });

  createTypedHandler(martaContracts.getTranscript, async () => {
    await ensureMartaHistoryReady();
    return {
      // Tool calls and their results are stripped: they are protocol, not
      // conversation, and the renderer renders them from the turn's event list.
      messages: getMartaRuntime()
        .getHistory()
        .filter((m) => m.role === "user" || m.role === "assistant")
        .filter((m) => !m.tool_calls)
        .map((m) => ({
          role: m.role,
          content:
            m.role === "assistant"
              ? safeMartaAssistantText(m.content)
              : m.content,
        }))
        .filter((m) => m.content.length > 0),
    };
  });

  createTypedHandler(martaContracts.clearTranscript, async () => {
    await ensureMartaHistoryReady();
    getMartaRuntime().clearHistory();
    await saveMartaHistory([]);
    await setPendingMartaDelegation(null);
    return { ok: true as const };
  });

  createTypedHandler(martaContracts.getPreferences, async () =>
    getMartaPreferences(),
  );

  createTypedHandler(martaContracts.setPreferences, async (_event, patch) =>
    updateMartaPreferences(patch),
  );

  createTypedHandler(
    martaContracts.startDelegation,
    async (_event, request) => {
      await ensureMartaHistoryReady();
      await loadMartaTasks();
      await setPendingMartaDelegation(null);
      if (request.userReply) {
        getMartaRuntime().appendUserMessage(request.userReply);
      }
      const result = await executeDelegate({
        delegateId: "delegate.code",
        args: {
          appId: request.appId,
          goal: request.goal,
          readOnly: request.readOnly,
        },
        userText: request.goal,
        delegationSelection: request.selection,
      });
      const taskId = "taskId" in result ? result.taskId : undefined;
      // The task id is a handle, not conversation. Returning it structurally is
      // what lets the Stage follow this exact delegation instead of scraping a
      // UUID out of prose — and keeping it out of the transcript stops a voice
      // reply from reading a GUID aloud.
      getMartaRuntime().appendAssistantMessage(
        withoutTaskIdClause(result.summary),
      );
      await saveMartaHistory(getMartaRuntime().getHistory());
      return {
        ok: result.ok,
        summary: result.summary,
        ...(taskId ? { taskId } : {}),
      };
    },
  );

  createTypedHandler(
    martaContracts.appendConversation,
    async (_event, message) => {
      await ensureMartaHistoryReady();
      getMartaRuntime().appendUserMessage(message.user);
      getMartaRuntime().appendAssistantMessage(message.assistant);
      await saveMartaHistory(getMartaRuntime().getHistory());
      return { ok: true as const };
    },
  );

  createTypedHandler(martaContracts.getPendingDelegation, async () => ({
    pending: await getPendingMartaDelegation(),
  }));

  createTypedHandler(
    martaContracts.setPendingDelegation,
    async (_event, { pending }) => {
      await setPendingMartaDelegation(pending);
      return { ok: true as const };
    },
  );

  createTypedHandler(martaContracts.listTasks, async (_event, options) => {
    await loadMartaTasks();
    return {
      tasks: listMartaTasks({
        includeCompleted: options?.includeCompleted ?? true,
        limit: options?.limit,
      }),
    };
  });

  createTypedHandler(martaContracts.listTaskEvents, async (_event, options) => {
    await loadMartaTasks();
    return {
      events: listMartaTaskEvents({
        taskId: options?.taskId,
        goalId: options?.goalId,
        after: options?.after,
        limit: options?.limit,
      }),
    };
  });

  createTypedHandler(martaContracts.controlTask, async (_event, request) => {
    await loadMartaTasks();
    return controlMartaTask(
      request.action === "prioritize"
        ? {
            taskId: request.taskId,
            action: request.action,
            priority: request.priority,
          }
        : { taskId: request.taskId, action: request.action },
    );
  });

  createTypedHandler(martaContracts.createGoal, async (_event, request) =>
    getParallelExecutive().createGoal({
      ...(request.id ? { id: request.id } : {}),
      title: request.title,
      userRequest: request.userRequest,
      ...(request.maxConcurrency !== undefined
        ? { maxConcurrency: request.maxConcurrency }
        : {}),
      nodes: request.nodes,
      ...(request.start !== undefined ? { start: request.start } : {}),
    }),
  );

  createTypedHandler(martaContracts.listGoals, async () => ({
    goals: await getParallelExecutive().listGoals(),
  }));

  createTypedHandler(martaContracts.controlGoal, async (_event, request) => {
    const command =
      request.action === "prioritize"
        ? {
            action: request.action,
            nodeId: request.nodeId,
            priority: request.priority,
          }
        : request.action === "cancel-node"
          ? { action: request.action, nodeId: request.nodeId }
          : { action: request.action };
    return getParallelExecutive().control(request.goalId, command);
  });

  // The runtime routes to the delegates but must not import them: they pull in
  // the flow runner, the DB and the Claude Code bridge, which would make the
  // turn loop untestable without all three.
  setDelegateExecutor(executeDelegate);

  // Give the gate a way to actually start and move Marta's model. Separate
  // setter from the exclusive tier's hooks — see `setCompanionHooks`.
  getModelGate().setCompanionHooks(
    getMartaModel().hooks((modelId) => {
      const tiers = getMartaResidency().getStatus().plan;
      if (tiers && tiers.tier.modelId === modelId) return tiers.tier;
      // Fall back to a ladder lookup so a tier chosen before the plan resolved
      // still starts.
      return (
        [...MARTA_TIER_IDS]
          .map((id) => findMartaTier(id))
          .find((tier) => tier?.modelId === modelId) ?? null
      );
    }),
  );

  // Hand the gate its VRAM budget and Marta's residency policy, then bring her
  // up. Not awaited: hardware detection is slow on a cold cache and the model
  // takes seconds to load, and neither should hold up IPC registration. Until
  // it lands the gate uses its default policy with an unknown budget, which is
  // the same behaviour the app had before Marta existed.
  void initMartaResidency()
    .then(() => autoStartMarta())
    .catch((error) => {
      logger.error(
        "Failed to initialise Marta residency; the gate keeps its default policy.",
        error,
      );
    });

  const graph = buildGraph();
  if (graph.orphaned.length > 0) {
    logger.error(
      `Marta action registry is stale — ${graph.orphaned.length} entries name missing contracts.`,
    );
  }
}

/** Test seam: the handler module owns the stage state, so tests must reset it. */
export function _resetStageStateForTests(): void {
  stageState = { surfaceId: null };
  historyReady = null;
}
