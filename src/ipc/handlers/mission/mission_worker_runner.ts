/**
 * Mission worker runtime — workspace prep, branch diff capture, output apply,
 * and the per-worker streaming run that drives the local agent against an
 * isolated workspace.
 */

import crypto from "node:crypto";
import path from "node:path";
import { promises as fsPromises } from "node:fs";
import type { IpcMainInvokeEvent } from "electron";
import { and, eq } from "drizzle-orm";
import log from "electron-log";

import { db } from "@/db";
import { apps, chats, messages, missions, missionWorkers } from "@/db/schema";
import { getServerStatus } from "@/ipc/utils/embedded_inference_server";
import { getOrianBuilderAppPath } from "@/paths/paths";
import { readSettings } from "@/main/settings";
import { constructSystemPrompt, readAiRules } from "@/prompts/system_prompt";
import { handleLocalAgentStream } from "@/pro/main/ipc/handlers/local_agent/local_agent_handler";
import {
  OrianBuilderError,
  OrianBuilderErrorKind,
} from "@/errors/orianbuilder_error";
import {
  createMissionInterrupt,
  logMissionEvent,
} from "../../utils/mission_utils";
import {
  buildWorkerLifecycleMetadata,
  getWorkerReport,
  mergeWorkerMetadata,
  normalizeMissionWorkerReport,
  selectDispatchableWorkers,
} from "../../utils/mission_workers";
import { getMissionWorkspaceProvider } from "../../utils/mission_workspace_provider";
import { execGit } from "../../utils/git_utils";
import {
  assertRelativeWorkerOutputPath,
  parseWorkerNameStatusOutput,
  type WorkerBranchChange,
} from "../../utils/mission_worker_output_apply";
import type { MissionAutoRunReadyWorkers } from "../../utils/mission_auto_scheduler";

import {
  clampParallelism,
  DEFAULT_MAX_PARALLEL_WORKERS,
  getMetadataNumber,
  getMissionOrThrow,
  getMissionWorkerOrThrow,
  isNodeErrorCode,
} from "./mission_helpers";

const logger = log.scope("mission_handlers");

export async function ensureWorkerChat(input: {
  worker: typeof missionWorkers.$inferSelect;
  mission: typeof missions.$inferSelect;
}): Promise<{
  chatId: number;
  worker: typeof missionWorkers.$inferSelect;
}> {
  const existingId = getMetadataNumber(input.worker.metadata, "workerChatId");
  if (existingId) {
    const found = await db.query.chats.findFirst({
      where: eq(chats.id, existingId),
    });
    if (found) {
      return { chatId: found.id, worker: input.worker };
    }
  }
  const [chat] = await db
    .insert(chats)
    .values({
      appId: input.mission.appId,
      title: `Worker ${input.worker.workerKey} · ${input.mission.title}`,
      chatMode: null,
    })
    .returning();
  const now = new Date();
  const [updatedWorker] = await db
    .update(missionWorkers)
    .set({
      metadata: mergeWorkerMetadata(input.worker.metadata, {
        workerChatId: chat.id,
        workerChatCreatedAt: now.toISOString(),
      }),
      updatedAt: now,
    })
    .where(eq(missionWorkers.id, input.worker.id))
    .returning();
  return { chatId: chat.id, worker: updatedWorker ?? input.worker };
}

export const runReadyMissionWorkersForMission: MissionAutoRunReadyWorkers =
  async ({ event, missionId, limit, parallel }) => {
    const mission = await getMissionOrThrow(missionId);
    if (!mission.chatId) {
      throw new OrianBuilderError(
        "Mission workers can only run for missions attached to a chat.",
        OrianBuilderErrorKind.Precondition,
      );
    }

    const appRecord = await db.query.apps.findFirst({
      where: eq(apps.id, mission.appId),
    });
    if (!appRecord) {
      throw new OrianBuilderError(
        `App not found for mission: ${mission.appId}`,
        OrianBuilderErrorKind.NotFound,
      );
    }

    const allWorkers = await db
      .select()
      .from(missionWorkers)
      .where(eq(missionWorkers.missionId, missionId))
      .orderBy(missionWorkers.createdAt);
    const settings = readSettings();
    const maxParallel = clampParallelism(
      settings.maxParallelMissionWorkers ?? DEFAULT_MAX_PARALLEL_WORKERS,
    );
    const effectiveLimit = Math.max(1, Math.min(limit, maxParallel));
    const readyWorkers = selectDispatchableWorkers(allWorkers)
      .filter((worker) => worker.status === "ready")
      .slice(0, effectiveLimit);

    if (readyWorkers.length === 0) {
      await logMissionEvent({
        missionId,
        eventType: "mission_worker_run_skipped",
        summary: "No ready workers are available to run",
      });
      return [];
    }

    const appPath = getOrianBuilderAppPath(appRecord.path);

    if (parallel && readyWorkers.length > 1) {
      await logMissionEvent({
        missionId,
        eventType: "mission_workers_parallel_run_started",
        summary: `Dispatching ${readyWorkers.length} workers concurrently`,
        metadata: {
          workerKeys: readyWorkers.map((worker) => worker.workerKey),
          limit: effectiveLimit,
          maxParallel,
        },
      });

      const results = await Promise.allSettled(
        readyWorkers.map((readyWorker) =>
          runMissionWorker({
            event,
            mission,
            appPath,
            worker: readyWorker,
          }),
        ),
      );

      const completedWorkers: (typeof missionWorkers.$inferSelect)[] = [];
      for (let i = 0; i < results.length; i += 1) {
        const result = results[i];
        if (result.status === "fulfilled") {
          completedWorkers.push(result.value);
        } else {
          const failingKey = readyWorkers[i].workerKey;
          logger.warn(
            `Worker ${failingKey} failed during parallel run:`,
            result.reason,
          );
          await logMissionEvent({
            missionId,
            eventType: "mission_worker_run_failed",
            summary: `Worker ${failingKey} threw during parallel run`,
            metadata: {
              workerKey: failingKey,
              error:
                result.reason instanceof Error
                  ? result.reason.message
                  : String(result.reason),
            },
          }).catch(() => {});
        }
      }
      return completedWorkers;
    }

    const completedWorkers = [];
    for (const readyWorker of readyWorkers) {
      const worker = await runMissionWorker({
        event,
        mission,
        appPath,
        worker: readyWorker,
      });
      completedWorkers.push(worker);
    }

    return completedWorkers;
  };

export async function runMissionWorker(input: {
  event: IpcMainInvokeEvent;
  mission: typeof missions.$inferSelect;
  appPath: string;
  worker: typeof missionWorkers.$inferSelect;
}) {
  const preparedWorker = await ensureWorkerWorkspacePrepared(input);
  const { chatId: workerChatId, worker: chatBoundWorker } =
    await ensureWorkerChat({
      worker: preparedWorker,
      mission: input.mission,
    });
  const workspacePath = chatBoundWorker.workspaceRef ?? input.appPath;
  const now = new Date();
  const [runningWorker] = await db
    .update(missionWorkers)
    .set({
      status: "running",
      metadata: buildWorkerLifecycleMetadata({
        existing: chatBoundWorker.metadata,
        status: "running",
        reason: "worker_runtime_started",
        now,
      }),
      updatedAt: now,
      startedAt: now,
      completedAt: null,
    })
    .where(
      and(
        eq(missionWorkers.id, chatBoundWorker.id),
        eq(missionWorkers.status, "ready"),
      ),
    )
    .returning();

  if (!runningWorker) {
    const currentWorker = await getMissionWorkerOrThrow(chatBoundWorker.id);
    await logMissionEvent({
      missionId: input.mission.id,
      eventType: "mission_worker_run_skipped",
      summary: `Worker ${currentWorker.workerKey} was not ready to run`,
      metadata: {
        workerId: currentWorker.id,
        workerKey: currentWorker.workerKey,
        status: currentWorker.status,
      },
    });
    return currentWorker;
  }

  await logMissionEvent({
    missionId: input.mission.id,
    eventType: "mission_worker_run_started",
    summary: `Worker ${runningWorker.workerKey} run started`,
    body: getWorkerPromptPackage(runningWorker),
    metadata: {
      workerId: runningWorker.id,
      workerKey: runningWorker.workerKey,
      role: runningWorker.role,
      workspaceProvider: runningWorker.workspaceProvider,
      workspaceRef: workspacePath,
      branchName: runningWorker.branchName,
    },
  });

  const prompt = buildWorkerRuntimePrompt({
    mission: input.mission,
    worker: runningWorker,
  });
  const settings = readSettings();
  const aiRules = await readAiRules(workspacePath);
  const systemPrompt = constructSystemPrompt({
    aiRules,
    chatMode: "local-agent",
    enableTurboEditsV2: false,
    basicAgentMode: false,
    autopilotMode: input.mission.autonomyProfile === "full-autopilot-sandbox",
  });
  const orianbuilderRequestId = `worker:${runningWorker.id}:${crypto.randomUUID()}`;

  const [userMessage] = await db
    .insert(messages)
    .values({
      chatId: workerChatId,
      role: "user",
      content: prompt,
    })
    .returning({ id: messages.id });
  const [assistantMessage] = await db
    .insert(messages)
    .values({
      chatId: workerChatId,
      role: "assistant",
      content: "",
      requestId: orianbuilderRequestId,
      model:
        settings.selectedModel.provider === "embedded"
          ? (getServerStatus().modelName ?? settings.selectedModel.name)
          : settings.selectedModel.name,
    })
    .returning({ id: messages.id });

  const baseRef = await captureGitHead(workspacePath);
  const success = await handleLocalAgentStream(
    input.event,
    {
      chatId: workerChatId,
      prompt,
      missionId: input.mission.id,
    },
    new AbortController(),
    {
      placeholderMessageId: assistantMessage.id,
      systemPrompt,
      orianbuilderRequestId,
      settingsOverride: settings,
      workspacePathOverride: workspacePath,
      workerId: runningWorker.id,
    },
  );

  const diff = await captureWorkerGitDiff(workspacePath, baseRef);
  const completedAt = new Date();
  const report = normalizeMissionWorkerReport({
    summary: success
      ? `Worker ${runningWorker.workerKey} completed its isolated run.`
      : `Worker ${runningWorker.workerKey} failed during its isolated run.`,
    changedFiles: diff.changedFiles,
    validation: diff.stat || null,
    blockers: success ? null : "Local-agent worker stream failed.",
    artifacts: diff.patch
      ? ["mission_worker_diff_captured event body"]
      : ["worker run chat messages"],
  });
  const nextStatus = success ? "completed" : "failed";
  const [finishedWorker] = await db
    .update(missionWorkers)
    .set({
      status: nextStatus,
      metadata: buildWorkerLifecycleMetadata({
        existing: mergeWorkerMetadata(runningWorker.metadata, {
          report,
          reportSubmittedAt: completedAt.toISOString(),
          workerRunUserMessageId: userMessage.id,
          workerRunAssistantMessageId: assistantMessage.id,
          diffStat: diff.stat,
          diffCaptureError: diff.error,
        }),
        status: nextStatus,
        reason: success ? "worker_runtime_completed" : "worker_runtime_failed",
        now: completedAt,
      }),
      updatedAt: completedAt,
      completedAt,
    })
    .where(eq(missionWorkers.id, runningWorker.id))
    .returning();

  await logMissionEvent({
    missionId: input.mission.id,
    eventType: "mission_worker_report_submitted",
    summary: `Worker ${finishedWorker.workerKey} submitted an automatic runtime report`,
    body: report.summary,
    metadata: {
      workerId: finishedWorker.id,
      workerKey: finishedWorker.workerKey,
      role: finishedWorker.role,
      status: finishedWorker.status,
      report,
    },
  });
  await createMissionInterrupt({
    missionId: input.mission.id,
    source: "worker",
    title: `Worker ${finishedWorker.status}: ${finishedWorker.workerKey}`,
    body: report.blockers
      ? `${report.summary} Blockers: ${report.blockers}`
      : report.summary,
    metadata: {
      producer: "mission_worker_runtime_report",
      workerId: finishedWorker.id,
      workerKey: finishedWorker.workerKey,
      role: finishedWorker.role,
      status: finishedWorker.status,
      report,
    },
  });
  if (diff.patch || diff.error) {
    await logMissionEvent({
      missionId: input.mission.id,
      eventType: "mission_worker_diff_captured",
      summary: diff.error
        ? `Worker ${finishedWorker.workerKey} diff capture failed`
        : `Worker ${finishedWorker.workerKey} diff captured`,
      body: diff.error ?? diff.patch,
      metadata: {
        workerId: finishedWorker.id,
        workerKey: finishedWorker.workerKey,
        changedFiles: diff.changedFiles,
        stat: diff.stat,
        error: diff.error,
      },
    });
  }

  return finishedWorker;
}

export async function applyWorkerOutput(input: {
  mission: typeof missions.$inferSelect;
  appPath: string;
  worker: typeof missionWorkers.$inferSelect;
  changes?: WorkerBranchChange[];
}) {
  if (!input.worker.workspaceRef) {
    throw new OrianBuilderError(
      `Worker ${input.worker.workerKey} has no prepared workspace to apply.`,
      OrianBuilderErrorKind.Precondition,
    );
  }

  const changes =
    input.changes ??
    (await getWorkerBranchChanges({
      appPath: input.appPath,
      worker: input.worker,
    }));
  if (changes.length === 0) {
    const now = new Date();
    const [worker] = await db
      .update(missionWorkers)
      .set({
        metadata: mergeWorkerMetadata(input.worker.metadata, {
          outputAppliedAt: now.toISOString(),
          outputApplyChangedFiles: [],
          outputApplyNote: "No branch diff to apply.",
        }),
        updatedAt: now,
      })
      .where(eq(missionWorkers.id, input.worker.id))
      .returning();
    await logMissionEvent({
      missionId: input.mission.id,
      eventType: "mission_worker_output_applied",
      summary: `Worker ${worker.workerKey} had no file output to apply`,
      metadata: {
        workerId: worker.id,
        workerKey: worker.workerKey,
        changedFiles: [],
      },
    });
    return worker;
  }

  const appliedFiles: string[] = [];
  for (const change of changes) {
    await applySingleWorkerFileChange({
      sourceRoot: input.worker.workspaceRef,
      targetRoot: input.appPath,
      change,
    });
    appliedFiles.push(change.path);
  }

  const now = new Date();
  const [worker] = await db
    .update(missionWorkers)
    .set({
      metadata: mergeWorkerMetadata(input.worker.metadata, {
        outputAppliedAt: now.toISOString(),
        outputApplyChangedFiles: appliedFiles,
      }),
      updatedAt: now,
    })
    .where(eq(missionWorkers.id, input.worker.id))
    .returning();

  await logMissionEvent({
    missionId: input.mission.id,
    eventType: "mission_worker_output_applied",
    summary: `Worker ${worker.workerKey} output applied`,
    metadata: {
      workerId: worker.id,
      workerKey: worker.workerKey,
      branchName: worker.branchName,
      workspaceRef: worker.workspaceRef,
      changedFiles: appliedFiles,
    },
  });

  return worker;
}

export async function cleanupWorkerWorkspace(
  worker: typeof missionWorkers.$inferSelect,
) {
  const workspaceRef = worker.workspaceRef;
  if (!workspaceRef) {
    throw new OrianBuilderError(
      `Worker ${worker.workerKey} has no workspace to clean up.`,
      OrianBuilderErrorKind.Precondition,
    );
  }

  const result = await execGit(
    ["-C", workspaceRef, "worktree", "remove", workspaceRef],
    path.dirname(workspaceRef),
  );
  if (result.exitCode !== 0) {
    throw new OrianBuilderError(
      `Failed to remove worker workspace ${workspaceRef}: ${
        result.stderr.trim() || result.stdout.trim()
      }`,
      OrianBuilderErrorKind.External,
    );
  }

  const now = new Date();
  const [updatedWorker] = await db
    .update(missionWorkers)
    .set({
      metadata: mergeWorkerMetadata(worker.metadata, {
        workspaceCleanedAt: now.toISOString(),
        workspaceCleanedRef: workspaceRef,
      }),
      workspaceRef: null,
      updatedAt: now,
    })
    .where(eq(missionWorkers.id, worker.id))
    .returning();

  await logMissionEvent({
    missionId: worker.missionId,
    eventType: "mission_worker_workspace_cleaned",
    summary: `Worker ${worker.workerKey} workspace cleaned`,
    metadata: {
      workerId: worker.id,
      workerKey: worker.workerKey,
      workspaceRef,
      branchName: worker.branchName,
    },
  });

  return updatedWorker;
}

export async function getWorkerBranchChanges(input: {
  appPath: string;
  worker: typeof missionWorkers.$inferSelect;
}): Promise<WorkerBranchChange[]> {
  if (!input.worker.branchName) {
    const report = getWorkerReport(input.worker.metadata);
    return (report?.changedFiles ?? []).map((filePath) => ({
      status: "M",
      path: filePath,
    }));
  }

  const result = await execGit(
    ["diff", "--name-status", "HEAD", input.worker.branchName],
    input.appPath,
  );
  if (result.exitCode !== 0) {
    throw new OrianBuilderError(
      `Failed to inspect worker branch ${input.worker.branchName}: ${
        result.stderr.trim() || result.stdout.trim()
      }`,
      OrianBuilderErrorKind.External,
    );
  }

  return parseWorkerNameStatusOutput(result.stdout);
}

async function applySingleWorkerFileChange(input: {
  sourceRoot: string;
  targetRoot: string;
  change: WorkerBranchChange;
}) {
  assertRelativeWorkerOutputPath(input.change.path);
  const targetPath = path.join(input.targetRoot, input.change.path);

  if (
    input.change.previousPath &&
    input.change.previousPath !== input.change.path
  ) {
    assertRelativeWorkerOutputPath(input.change.previousPath);
    await fsPromises
      .unlink(path.join(input.targetRoot, input.change.previousPath))
      .catch((err: unknown) => {
        if (!isNodeErrorCode(err, "ENOENT")) throw err;
      });
  }

  if (input.change.status.startsWith("D")) {
    await fsPromises.unlink(targetPath).catch((err: unknown) => {
      if (!isNodeErrorCode(err, "ENOENT")) throw err;
    });
    return;
  }

  const sourcePath = path.join(input.sourceRoot, input.change.path);
  await fsPromises.mkdir(path.dirname(targetPath), { recursive: true });
  await fsPromises.copyFile(sourcePath, targetPath);
}

async function ensureWorkerWorkspacePrepared(input: {
  mission: typeof missions.$inferSelect;
  appPath: string;
  worker: typeof missionWorkers.$inferSelect;
}) {
  if (input.worker.workspaceRef) {
    return input.worker;
  }

  const provider = getMissionWorkspaceProvider(input.worker.workspaceProvider);
  const prepared = await provider.prepare({
    appPath: input.appPath,
    missionId: input.mission.id,
    worker: input.worker,
  });
  const now = new Date();
  const [worker] = await db
    .update(missionWorkers)
    .set({
      workspaceRef: prepared.workspaceRef,
      branchName: prepared.branchName,
      metadata: mergeWorkerMetadata(input.worker.metadata, {
        workspacePreparedAt: now.toISOString(),
        workspaceProvider: prepared.provider,
        promptPackage: prepared.promptPackage,
      }),
      updatedAt: now,
    })
    .where(eq(missionWorkers.id, input.worker.id))
    .returning();
  return worker;
}

function buildWorkerRuntimePrompt(input: {
  mission: typeof missions.$inferSelect;
  worker: typeof missionWorkers.$inferSelect;
}) {
  return [
    "Run this mission worker package now.",
    "",
    `Mission: ${input.mission.title}`,
    `Mission goal: ${input.mission.goal}`,
    "",
    getWorkerPromptPackage(input.worker),
    "",
    "Rules:",
    "- Work only inside this worker workspace.",
    "- Stay within the file scopes unless a dependency is absolutely required.",
    "- Run focused validation when practical.",
    "- End with a concise summary of changed files, validation, and blockers.",
  ].join("\n");
}

function getWorkerPromptPackage(worker: typeof missionWorkers.$inferSelect) {
  const metadata = worker.metadata;
  const promptPackage =
    metadata && typeof metadata === "object" && "promptPackage" in metadata
      ? metadata.promptPackage
      : null;
  if (typeof promptPackage === "string" && promptPackage.trim()) {
    return promptPackage;
  }
  return [
    `Mission worker: ${worker.workerKey}`,
    `Role: ${worker.role}`,
    `Title: ${worker.title}`,
    `Goal: ${worker.goal}`,
    `Workspace provider: ${worker.workspaceProvider}`,
    `Workspace path: ${worker.workspaceRef ?? "(not prepared)"}`,
    `Branch: ${worker.branchName ?? "(none)"}`,
    `File scopes: ${(worker.fileScopes ?? []).join(", ") || "(none)"}`,
    `Depends on: ${(worker.dependsOn ?? []).join(", ") || "(none)"}`,
  ].join("\n");
}

async function captureWorkerGitDiff(
  workspacePath: string,
  baseRef: string | null,
) {
  if (!baseRef) {
    const changedFiles = await captureUncommittedChangedFiles(workspacePath);
    const patch = await execGit(["diff"], workspacePath);
    return {
      changedFiles,
      stat: null,
      patch: patch.exitCode === 0 ? patch.stdout.trim() : null,
      error: patch.exitCode === 0 ? null : patch.stderr.trim() || null,
    };
  }

  const lastCommitFiles = await execGit(
    ["diff", "--name-only", baseRef, "HEAD"],
    workspacePath,
  );
  const changedFiles =
    lastCommitFiles.exitCode === 0
      ? lastCommitFiles.stdout
          .split(/\r?\n/)
          .map((file) => file.trim())
          .filter(Boolean)
      : await captureUncommittedChangedFiles(workspacePath);
  const stat = await execGit(
    ["diff", "--stat", baseRef, "HEAD"],
    workspacePath,
  );
  let patch = await execGit(["diff", baseRef, "HEAD"], workspacePath);
  if (patch.exitCode !== 0) {
    patch = await execGit(["diff"], workspacePath);
  }

  return {
    changedFiles,
    stat: stat.exitCode === 0 ? stat.stdout.trim() : null,
    patch: patch.exitCode === 0 ? patch.stdout.trim() : null,
    error:
      lastCommitFiles.exitCode === 0 || changedFiles.length > 0
        ? null
        : lastCommitFiles.stderr.trim() || null,
  };
}

async function captureGitHead(workspacePath: string) {
  const result = await execGit(["rev-parse", "HEAD"], workspacePath);
  if (result.exitCode !== 0) {
    return null;
  }
  return result.stdout.trim() || null;
}

async function captureUncommittedChangedFiles(workspacePath: string) {
  const result = await execGit(["diff", "--name-only"], workspacePath);
  if (result.exitCode !== 0) {
    return [];
  }
  return result.stdout
    .split(/\r?\n/)
    .map((file) => file.trim())
    .filter(Boolean);
}
