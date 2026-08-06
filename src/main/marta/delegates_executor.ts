/**
 * How Marta hands work to the bigger brains.
 *
 * Each delegate reduces to *one* call on an existing subsystem, because the
 * subsystems already know how to do their jobs. `delegate_workflow` does not
 * decompose the request — `flow:run-command` has a whole intent parser for
 * that, and having a 4B model pre-chew the plan would be strictly worse than
 * letting the flow runner's own parser see the original sentence.
 *
 * Everything returns a *string* for Marta to read back. She is a router: what
 * she needs from a delegate is "did it work, and what came out", not a typed
 * object she would only stringify anyway.
 *
 * Heavy delegates are deliberately fire-and-forget where the work outlives a
 * turn. Blocking a spoken turn on a nine-minute build would leave the user
 * listening to silence; instead she reports that it started, and the ambient
 * rail carries the progress.
 */

import { randomUUID } from "node:crypto";
import log from "electron-log";
import type { LocalModel, MartaDelegationSelection } from "@/ipc/types";

import { callHandler, invokeAction, summariseResult } from "./invoke_action";
import type { DelegateRequest, DelegateResult } from "./marta_runtime";
import { askBigBrain } from "./big_brain";
import {
  getMartaPreferences,
  rememberDelegationSelection,
} from "./marta_memory_store";
import {
  broadcastMartaDelegationChoice,
  createMartaTask,
  updateMartaTask,
} from "./task_registry";
import {
  extractResearchSources,
  performResearch,
} from "@/pro/main/ipc/handlers/local_agent/tools/web_search";
import {
  inferDelegationSelectionFromUtterance,
  mentionsDelegationSelection,
} from "./delegation_selection";
import {
  appendCodingTaskAcceptanceInstructions,
  type CodingTaskAcceptanceTarget,
} from "./task_acceptance";
import {
  prepareCodingTaskAcceptance,
  resolveCodingTaskProjectRoot,
} from "./task_acceptance_verifier";

const logger = log.scope("marta-delegates");

/** Pull a required string argument, or explain to the model what was missing. */
function requireString(
  args: Record<string, unknown>,
  key: string,
): { value: string } | { error: string } {
  const raw = args[key];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { error: `delegate needs a non-empty "${key}".` };
  }
  return { value: raw };
}

function requireNumber(
  args: Record<string, unknown>,
  key: string,
): { value: number } | { error: string } {
  const raw = args[key];
  const num = typeof raw === "string" ? Number(raw) : raw;
  if (typeof num !== "number" || !Number.isFinite(num)) {
    return {
      error: `delegate needs a numeric "${key}". Look the id up first if you do not have it.`,
    };
  }
  return { value: num };
}

async function runWorkflow(
  args: Record<string, unknown>,
  userText: string,
): Promise<DelegateResult> {
  // The 4B model chooses this delegate and the app id; it must not rewrite the
  // actual job. Small models readily turn "do not generate media" into a more
  // elaborate media pipeline while restating it. The trusted runtime already
  // has the exact request, so pass that to the intent parser verbatim.
  const command = userText.trim()
    ? { value: userText.trim() }
    : requireString(args, "command");
  if ("error" in command) return { ok: false, summary: command.error };

  const appId = typeof args.appId === "number" ? args.appId : undefined;

  // Started, not awaited: a media pipeline runs for minutes and the user is
  // waiting on a spoken reply. Failures surface through the flow's own
  // progress events rather than this return value.
  void invokeAction("flow.runCommand", {
    text: command.value,
    ...(appId !== undefined ? { appId } : {}),
  }).then(async (result) => {
    if (!result.ok) {
      logger.warn(`workflow failed: ${result.error}`);
      return;
    }
    const flow = result.data as
      | { steps?: Array<{ output?: Record<string, unknown> }> }
      | undefined;
    for (const step of flow?.steps ?? []) {
      const output = step.output;
      if (
        output?.runBuild !== true ||
        typeof output.appId !== "number" ||
        typeof output.buildGoal !== "string"
      ) {
        continue;
      }
      const preferences = await getMartaPreferences();
      if (preferences.codingWorker === "ask") {
        broadcastMartaDelegationChoice({
          requestId: randomUUID(),
          appId: output.appId,
          goal: output.buildGoal,
          readOnly: false,
        });
        continue;
      }
      const buildResult = await runCodeTask({
        appId: output.appId,
        goal: output.buildGoal,
      });
      if (!buildResult.ok) {
        logger.warn(`workflow build handoff failed: ${buildResult.summary}`);
      }
    }
  });

  return {
    ok: true,
    summary:
      "The workflow started and is running in the background. Results will appear as they arrive.",
  };
}

/**
 * Capture the pre-worker baseline and attach the contract to a ledger entry.
 *
 * One helper for every coding worker. The rule the acceptance gate rests on is
 * that the snapshot predates the first edit; giving each vendor its own copy of
 * that ordering is how one of them ends up capturing it a moment too late.
 */
async function attachCodingAcceptance(input: {
  taskId: string;
  appId: number;
  goal: string;
  readOnly: boolean;
}): Promise<
  | { ok: true; target: CodingTaskAcceptanceTarget }
  | { ok: false; summary: string }
> {
  try {
    const projectRoot = await resolveCodingTaskProjectRoot(input.appId);
    const prepared = await prepareCodingTaskAcceptance({
      goal: input.goal,
      projectRoot,
      readOnly: input.readOnly,
    });
    updateMartaTask(input.taskId, {
      acceptanceTarget: prepared.target,
      acceptanceBaseline: prepared.baseline,
    });
    return { ok: true, target: prepared.target };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateMartaTask(input.taskId, {
      status: "failed",
      phase: "Could not capture the Orion acceptance baseline",
      error: message,
      completedAt: Date.now(),
    });
    return {
      ok: false,
      summary: `Orion could not capture the pre-task workspace baseline, so it cannot verify the result: ${message}`,
    };
  }
}

async function runCodeTask(
  args: Record<string, unknown>,
  requestedSelection?: MartaDelegationSelection,
  userText = "",
): Promise<DelegateResult> {
  const goal = requireString(args, "goal");
  if ("error" in goal) return { ok: false, summary: goal.error };
  const appId = requireNumber(args, "appId");
  if ("error" in appId) return { ok: false, summary: appId.error };

  const preferences = await getMartaPreferences();
  const preferredLocalModels: LocalModel[] = preferences.localModel
    ? [localModelFromPreference(preferences.localModel)]
    : [];
  const utteranceSelection = inferDelegationSelectionFromUtterance(
    userText,
    preferredLocalModels,
  );
  const explicitlyOverridesDefault = mentionsDelegationSelection(userText);
  const explicitSelection = requestedSelection ?? utteranceSelection;
  const selection: MartaDelegationSelection | undefined = explicitSelection
    ? explicitSelection
    : explicitlyOverridesDefault || preferences.codingWorker === "ask"
      ? undefined
      : preferences.codingWorker === "local"
        ? { worker: "local", model: preferences.localModel ?? undefined }
        : {
            worker: "claude",
            model: preferences.claudeModel ?? undefined,
            effort: preferences.claudeEffort ?? undefined,
          };

  if (!selection) {
    return {
      ok: true,
      summary: "A coding worker has not been selected yet.",
      choice: {
        requestId: randomUUID(),
        appId: appId.value,
        goal: goal.value,
        readOnly: args.readOnly === true,
      },
    };
  }

  await rememberDelegationSelection(selection);
  if (selection.worker === "local") {
    return runLocalCodeTask({
      appId: appId.value,
      goal: goal.value,
      readOnly: args.readOnly === true,
      model: selection.model,
    });
  }

  const detect = await invokeAction("claudeCode.detect", {});
  const availability = detect.data as { available?: boolean } | undefined;
  if (!detect.ok || !availability?.available) {
    return {
      ok: false,
      summary:
        "Claude Code is unavailable because it is not installed or signed in on this machine.",
    };
  }

  // Also long-running, and it streams its own events into the chat surface.
  // `callHandler`, not `invokeAction`: `claudeCode.startTurn` is deliberately
  // NOT a granted action, so that the turn id and permission mode are decided
  // here rather than by the model.
  const turnId = randomUUID();
  const taskId = `claude:${turnId}`;
  createMartaTask({
    id: taskId,
    runtimeId: turnId,
    kind: "claude",
    title: goal.value.slice(0, 72),
    goal: goal.value,
    appId: appId.value,
    workerLabel: "Claude Code",
    model: selection.model || "Account default",
    effort: selection.effort || "medium",
    status: "queued",
    phase: "Starting Claude Code",
  });

  // Baseline *before* dispatch, not inside the turn handler.
  //
  // `claude-code:start-turn` also prepares a contract, which is what covers a
  // turn started from the chat UI. But that call is fire-and-forget from here, so
  // relying on it left a window in which the task existed with no contract and
  // the worker was already editing — any writes in that window would be missing
  // from the diff, and a crash inside it left a task that could never be
  // certified. The handler's own preparation is idempotent, so doing it here too
  // costs one snapshot and closes the race.
  const prepared = await attachCodingAcceptance({
    taskId,
    appId: appId.value,
    goal: goal.value,
    readOnly: args.readOnly === true,
  });
  if (!prepared.ok) {
    return {
      ok: false,
      summary: prepared.summary,
      taskId,
    };
  }

  void callHandler(
    "claude-code:start-turn",
    {
      turnId,
      appId: appId.value,
      prompt: goal.value,
      ...(selection.model ? { model: selection.model } : {}),
      ...(selection.effort ? { effort: selection.effort } : {}),
      // Read-only requests run in plan mode, which is Claude Code's own
      // no-edits guarantee rather than one we would have to enforce.
      ...(args.readOnly === true ? { permissionMode: "plan" as const } : {}),
    },
    { label: "delegate.code" },
  ).then((result) => {
    if (!result.ok) {
      logger.warn(`code task failed: ${result.error}`);
      updateMartaTask(taskId, {
        status: "failed",
        phase: "Could not start Claude Code",
        error: result.error,
        completedAt: Date.now(),
      });
      return;
    }
    updateMartaTask(taskId, {
      status: "running",
      phase: "Claude Code is working",
    });
  });

  return {
    ok: true,
    summary: `Claude Code accepted the task and is working now. Task id: ${taskId}.`,
    taskId,
  };
}

function localModelFromPreference(modelKey: string): LocalModel {
  const separator = modelKey.indexOf(":");
  if (separator <= 0) {
    return {
      provider: "embedded",
      modelName: modelKey,
      displayName: modelKey,
    };
  }
  const provider = modelKey.slice(0, separator);
  const supported = new Set<LocalModel["provider"]>([
    "ollama",
    "lmstudio",
    "embedded",
    "marta",
  ]);
  return {
    provider: supported.has(provider as LocalModel["provider"])
      ? (provider as LocalModel["provider"])
      : "embedded",
    modelName: modelKey.slice(separator + 1),
    displayName: modelKey.slice(separator + 1),
  };
}

async function runLocalCodeTask(input: {
  appId: number;
  goal: string;
  readOnly: boolean;
  model?: string;
}): Promise<DelegateResult> {
  if (!input.model) {
    return {
      ok: false,
      summary:
        "No runnable local coding model was selected. LM Studio or Ollama must be running, or a GGUF must be loaded in Orion's Engine.",
    };
  }
  const chatResult = await callHandler(
    "create-chat",
    { appId: input.appId, initialChatMode: "local-agent" },
    { label: "delegate.local-code-chat" },
  );
  if (!chatResult.ok || typeof chatResult.data !== "number") {
    return {
      ok: false,
      summary: chatResult.error ?? "Could not create the local-agent session.",
    };
  }

  const missionResult = await callHandler(
    "mission:create",
    {
      appId: input.appId,
      chatId: chatResult.data,
      title: input.goal.slice(0, 72),
      goal: input.goal,
      autonomyProfile: "trusted-workspace",
    },
    { label: "delegate.local-code-mission" },
  );
  const mission = missionResult.data as { id?: number } | undefined;
  if (!missionResult.ok || typeof mission?.id !== "number") {
    return {
      ok: false,
      summary: missionResult.error ?? "Could not create the local coding task.",
    };
  }

  const taskId = `mission:${mission.id}`;
  createMartaTask({
    id: taskId,
    runtimeId: String(mission.id),
    kind: "local",
    title: input.goal.slice(0, 72),
    goal: input.goal,
    appId: input.appId,
    workerLabel: "Orion local agent",
    model: input.model || "Current local model",
    status: "queued",
    phase: "Preparing the local agent workspace",
  });

  // Acceptance parity with Claude Code. Without this the local worker's
  // completion reaches `verifyMartaTaskAcceptance` with no baseline, which
  // correctly refuses to certify it — so *every* local delegation ended as
  // "Acceptance verification unavailable" regardless of how well it went. The
  // rule is one contract per coding worker, not one per vendor.
  const prepared = await attachCodingAcceptance({
    taskId,
    appId: input.appId,
    goal: input.goal,
    readOnly: input.readOnly,
  });
  if (!prepared.ok) {
    return { ok: false, summary: prepared.summary, taskId };
  }
  const acceptanceTarget = prepared.target;

  const separator = input.model?.indexOf(":") ?? -1;
  const selectedModel =
    input.model && separator > 0
      ? {
          provider: input.model.slice(0, separator),
          name: input.model.slice(separator + 1),
        }
      : undefined;
  const workerResult = await callHandler(
    "mission:create-worker",
    {
      missionId: mission.id,
      workerKey: `marta-${randomUUID().slice(0, 8)}`,
      role: input.readOnly ? "reviewer" : "builder",
      title: input.readOnly ? "Investigate and report" : "Implement and verify",
      // The worker is told what evidence Orion will require. It is still Orion
      // that collects it — the instructions raise the chance of a first-pass
      // success, they are not the check.
      goal: appendCodingTaskAcceptanceInstructions(
        input.readOnly
          ? `READ ONLY. Do not edit files. ${input.goal}`
          : input.goal,
        acceptanceTarget,
      ),
      workspaceProvider: "local",
      metadata: {
        delegatedBy: "marta",
        readOnly: input.readOnly,
        ...(selectedModel ? { selectedModel } : {}),
      },
    },
    { label: "delegate.local-code-worker" },
  );
  if (!workerResult.ok) {
    updateMartaTask(taskId, {
      status: "failed",
      phase: "Could not start the local agent",
      error: workerResult.error,
      completedAt: Date.now(),
    });
    return {
      ok: false,
      summary: workerResult.error ?? "Could not start the local coding worker.",
    };
  }

  return {
    ok: true,
    summary: `Started an agentic local coding task using ${input.model || "Orion's current local model"}. Task id: ${taskId}. Its live progress is available on the Stage.`,
    taskId,
  };
}

async function runMission(
  args: Record<string, unknown>,
): Promise<DelegateResult> {
  const appId = requireNumber(args, "appId");
  if ("error" in appId) return { ok: false, summary: appId.error };
  const title = requireString(args, "title");
  if ("error" in title) return { ok: false, summary: title.error };
  const goal = requireString(args, "goal");
  if ("error" in goal) return { ok: false, summary: goal.error };

  // Not a granted action either: creating an autonomous mission is a decision
  // the delegate makes, with the autonomy profile pinned below.
  const result = await callHandler(
    "mission:create",
    {
      appId: appId.value,
      title: title.value,
      goal: goal.value,
      // Supervised unless the user explicitly asked otherwise. An orchestrator
      // that quietly grants itself autonomy is the failure mode worth designing
      // against.
      autonomyProfile:
        args.autonomyProfile === "trusted-workspace" ||
        args.autonomyProfile === "full-autopilot-sandbox"
          ? args.autonomyProfile
          : "supervised",
    },
    { label: "delegate.mission" },
  );

  if (!result.ok) {
    return {
      ok: false,
      summary: result.error ?? "Could not start the mission.",
    };
  }

  // Registered in the ledger like every other worker. Without this a mission
  // Marta started herself was invisible to the task deck, to her own status
  // answers, and to restart reconciliation — and `updateMartaTaskFromMissionEvent`
  // dropped all of its progress on the floor because no task by that id existed.
  const mission = result.data as { id?: number } | undefined;
  if (typeof mission?.id !== "number") {
    return {
      ok: true,
      summary: `Mission created and queued: ${summariseResult(result.data, 300)}`,
    };
  }
  const taskId = `mission:${mission.id}`;
  createMartaTask({
    id: taskId,
    runtimeId: String(mission.id),
    kind: "mission",
    title: title.value.slice(0, 72),
    goal: goal.value,
    appId: appId.value,
    workerLabel: "Orion mission",
    status: "queued",
    phase: "Mission queued",
  });
  try {
    const projectRoot = await resolveCodingTaskProjectRoot(appId.value);
    const prepared = await prepareCodingTaskAcceptance({
      goal: goal.value,
      projectRoot,
    });
    updateMartaTask(taskId, {
      acceptanceTarget: prepared.target,
      acceptanceBaseline: prepared.baseline,
    });
  } catch (error) {
    // The mission still runs — it is the user's project and their instruction.
    // But say so on the card now, rather than letting the task look healthy for
    // ten minutes and then fail at the acceptance gate with no explanation.
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("Could not baseline a Marta-started mission:", error);
    updateMartaTask(taskId, {
      requiresAttention: true,
      blockedReason: `Orion could not capture a pre-task baseline (${message}), so it will not be able to certify this mission's result.`,
    });
  }
  return {
    ok: true,
    summary: `Mission created and queued: ${summariseResult(result.data, 300)}. Task id: ${taskId}.`,
    taskId,
  };
}

async function runResearch(
  args: Record<string, unknown>,
): Promise<DelegateResult> {
  const question = requireString(args, "question");
  if ("error" in question) return { ok: false, summary: question.error };

  // Research is a ledger task like any other work, so its sources survive the
  // turn. Without this the URLs existed only inside one model context: the
  // research surface had nothing to show, and "where did that come from?" was
  // unanswerable ten minutes later.
  const taskId = `research:${randomUUID()}`;
  createMartaTask({
    id: taskId,
    kind: "flow",
    title: question.value.slice(0, 72),
    goal: question.value,
    workerLabel: "Web research",
    status: "running",
    phase: "Searching and reading sources",
  });

  // Use the same searched result source as the local-agent web tool. Marta must
  // not answer from memory and call it
  // research — that is precisely the failure the delegate exists to prevent.
  try {
    const results = await performResearch(question.value);
    const sources = extractResearchSources(results);
    const now = Date.now();
    updateMartaTask(taskId, {
      status: "succeeded",
      phase:
        sources.length > 0
          ? `Read ${sources.filter((source) => source.read).length} of ${sources.length} sources`
          : "No sources were returned",
      progress: 1,
      completedAt: now,
      evidence: sources.slice(0, 20).map((source, index) => ({
        id: `${taskId}:source:${index}`,
        kind: "artifact" as const,
        label: source.title ?? source.url,
        // Read pages are the ones the conclusion can actually rest on; a
        // search-result title is a lead, not evidence.
        ok: source.read,
        uri: source.url,
        detail: source.read
          ? "Fetched and read now"
          : "Listed by the search engine; body not read",
        timestamp: now,
      })),
    });
    return {
      ok: true,
      summary: `Live web results (cite the URLs you use and say these were searched now):\n${results.slice(0, 8_000)}`,
      taskId,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateMartaTask(taskId, {
      status: "failed",
      phase: "Web research failed",
      error: message,
      completedAt: Date.now(),
    });
    return {
      ok: false,
      summary: `Web search failed: ${message}`,
      taskId,
    };
  }
}

async function runBigBrain(
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<DelegateResult> {
  const question = requireString(args, "question");
  if ("error" in question) return { ok: false, summary: question.error };
  try {
    const result = await askBigBrain(question.value, signal);
    return {
      ok: true,
      summary: `Deep reasoning from ${result.modelId} (${result.placement}):\n${result.answer}`,
    };
  } catch (error) {
    return {
      ok: false,
      summary: `The local big brain could not run: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function executeDelegate(
  request: DelegateRequest,
): Promise<DelegateResult> {
  logger.info(`delegate ${request.delegateId}`);
  switch (request.delegateId) {
    case "delegate.brain":
      return runBigBrain(request.args, request.signal);
    case "delegate.workflow":
      return runWorkflow(request.args, request.userText);
    case "delegate.code":
      return runCodeTask(
        request.args,
        request.delegationSelection,
        request.userText,
      );
    case "delegate.mission":
      return runMission(request.args);
    case "delegate.research":
      return runResearch(request.args);
    default:
      return {
        ok: false,
        summary: `No delegate called "${request.delegateId}".`,
      };
  }
}
