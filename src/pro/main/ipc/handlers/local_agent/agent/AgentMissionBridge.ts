import log from "electron-log";
import { and, asc, desc, eq, inArray, isNull, or } from "drizzle-orm";

import { db } from "@/db";
import {
  missionInterrupts,
  missionMemories,
  missionPermissionRequests,
} from "@/db/schema";
import type { UserSettings } from "@/lib/schemas";
import { getServerStatus } from "@/ipc/utils/embedded_inference_server";
import { mcpManager } from "@/ipc/utils/mcp_manager";
import {
  createMissionArtifact,
  createMissionCheckpoint,
  createMissionInterrupt,
  logMissionEvent,
} from "@/ipc/utils/mission_utils";
import {
  getMissionEventSummaryForXml,
  getMissionVerificationEventForXml,
} from "@/ipc/utils/mission_verification";
import { getMissionStructuredEventsForXml } from "@/ipc/utils/mission_xml_events";
import { extractMissionVisualEventsForXml } from "@/ipc/utils/mission_visual_events";
import {
  getErrorMessage,
  MAX_TERMINATED_STREAM_RETRIES,
  STREAM_RETRY_BASE_DELAY_MS,
} from "./AgentStepProcessor";

const logger = log.scope("local_agent_handler");

export function getMissionRunModelName(settings: UserSettings): string {
  if (settings.selectedModel.provider !== "embedded") {
    return settings.selectedModel.name;
  }
  return getServerStatus().modelName ?? settings.selectedModel.name;
}

export async function logMissionEventsForXml(input: {
  missionId: number | undefined;
  missionRunId?: number | null;
  workerId?: number | null;
  chatId: number;
  xml: string;
}) {
  const { missionId, missionRunId, workerId, chatId, xml } = input;
  if (!missionId) {
    return;
  }

  await logMissionEvent({
    missionId,
    eventType: "agent_output",
    summary: getMissionEventSummaryForXml(xml),
    body: xml,
    metadata: {
      chatId,
      runId: missionRunId ?? null,
      workerId: workerId ?? null,
    },
  });

  for (const event of getMissionStructuredEventsForXml(xml)) {
    await logMissionEvent({
      missionId,
      eventType: event.eventType,
      summary: event.summary,
      body: xml,
      metadata: {
        chatId,
        workerId: workerId ?? null,
        ...event.metadata,
      },
    });
  }

  const visual = extractMissionVisualEventsForXml(xml);
  for (const event of visual.events) {
    await logMissionEvent({
      missionId,
      eventType: event.eventType,
      summary: event.summary,
      body: xml,
      metadata: {
        chatId,
        workerId: workerId ?? null,
        gate: event.gate,
        status: event.status,
        ...event.metadata,
      },
    });
    if (event.status === "failed") {
      await createMissionInterrupt({
        missionId,
        source: "runtime",
        title: `${getMissionVisualGateLabel(event.gate)} failed`,
        body: event.summary,
        metadata: {
          producer: event.eventType,
          runId: missionRunId ?? null,
          workerId: workerId ?? null,
          chatId,
          gate: event.gate,
          status: event.status,
          ...event.metadata,
        },
      });
    }
  }
  for (const artifact of visual.artifacts) {
    await createMissionArtifact({
      missionId,
      runId: missionRunId ?? null,
      artifactType: artifact.artifactType,
      title: artifact.title,
      uri: artifact.uri ?? null,
      body: artifact.body ?? null,
      mimeType: artifact.mimeType ?? null,
      metadata: {
        chatId,
        workerId: workerId ?? null,
        ...artifact.metadata,
      },
    });
  }

  const verification = getMissionVerificationEventForXml(xml);
  if (!verification) {
    return;
  }

  await logMissionEvent({
    missionId,
    eventType: verification.eventType,
    summary: verification.summary,
    body: xml,
    metadata: {
      chatId,
      workerId: workerId ?? null,
      status: verification.status,
      check: verification.check,
      command: verification.command,
      problemCount: verification.problemCount,
      exitCode: verification.exitCode,
    },
  });
  if (verification.status === "failed") {
    await createMissionInterrupt({
      missionId,
      source: verification.check === "test" ? "test" : "runtime",
      title: `${getMissionVerificationCheckLabel(verification.check)} failed`,
      body: verification.summary,
      metadata: {
        producer: verification.eventType,
        runId: missionRunId ?? null,
        workerId: workerId ?? null,
        chatId,
        status: verification.status,
        check: verification.check,
        command: verification.command,
        problemCount: verification.problemCount,
        exitCode: verification.exitCode,
      },
    });
  }
}

export function getMissionVisualGateLabel(gate: string) {
  switch (gate) {
    case "screenshot":
      return "Screenshot gate";
    case "accessibility":
      return "Accessibility gate";
    case "console":
      return "Console gate";
    case "runtime":
      return "Runtime gate";
    default:
      return "Visual gate";
  }
}

export function getMissionVerificationCheckLabel(check: string) {
  switch (check) {
    case "install":
      return "Install";
    case "typecheck":
      return "Type check";
    case "build":
      return "Build";
    case "test":
      return "Tests";
    case "start_app":
      return "App start";
    default:
      return "Verification";
  }
}

export async function logMissionRetryScheduled(input: {
  missionId: number | undefined;
  missionRunId: number | null;
  chatId: number;
  retryCount: number;
  retryDelayMs: number;
  phase: string;
  error: unknown;
}) {
  const metadata = {
    chatId: input.chatId,
    runId: input.missionRunId,
    retryCount: input.retryCount,
    retryDelayMs: input.retryDelayMs,
    phase: input.phase,
    error: getErrorMessage(input.error),
    retryPolicy: {
      maxRetries: MAX_TERMINATED_STREAM_RETRIES,
      baseDelayMs: STREAM_RETRY_BASE_DELAY_MS,
    },
  };

  await logMissionEvent({
    missionId: input.missionId,
    eventType: "agent_stream_retry_scheduled",
    summary: `Retry ${input.retryCount} scheduled after ${input.retryDelayMs}ms`,
    metadata,
  }).catch((err) => logger.warn("Failed to log mission retry:", err));

  await createMissionCheckpoint({
    missionId: input.missionId,
    runId: input.missionRunId,
    summary: `Retry ${input.retryCount} scheduled`,
    metadata,
  }).catch((err) => logger.warn("Failed to checkpoint mission retry:", err));
}

export async function loadPendingMissionInterrupts(missionId: number) {
  return db
    .select()
    .from(missionInterrupts)
    .where(
      and(
        eq(missionInterrupts.missionId, missionId),
        eq(missionInterrupts.status, "pending"),
      ),
    )
    .orderBy(asc(missionInterrupts.createdAt))
    .limit(8);
}

export function releaseMcpSession(sessionId: string) {
  try {
    mcpManager.releaseSession(sessionId);
  } catch (err) {
    logger.warn("Failed to release MCP session:", err);
  }
}

export async function markMissionInterruptsInjected(input: {
  missionId: number;
  interruptIds: number[];
}) {
  if (input.interruptIds.length === 0) {
    return [];
  }

  return db
    .update(missionInterrupts)
    .set({
      status: "injected",
      injectedAt: new Date(),
    })
    .where(
      and(
        eq(missionInterrupts.missionId, input.missionId),
        inArray(missionInterrupts.id, input.interruptIds),
      ),
    )
    .returning();
}

export async function loadMissionMemoriesForInjection(input: {
  appId: number;
  missionId: number;
}) {
  return db
    .select()
    .from(missionMemories)
    .where(
      and(
        eq(missionMemories.appId, input.appId),
        or(
          eq(missionMemories.missionId, input.missionId),
          isNull(missionMemories.missionId),
        ),
      ),
    )
    .orderBy(desc(missionMemories.updatedAt))
    .limit(8);
}

export async function createMissionPermissionRequestForTool(input: {
  missionId: number;
  runId: number | null;
  toolName: string;
  inputPreview?: string | null;
  risk: "low" | "medium" | "high";
  reason: string;
}) {
  const [request] = await db
    .insert(missionPermissionRequests)
    .values({
      missionId: input.missionId,
      runId: input.runId,
      action: input.toolName,
      risk: input.risk,
      reason: input.reason,
      metadata: {
        inputPreview: input.inputPreview ?? null,
      },
      createdAt: new Date(),
    })
    .returning();

  await logMissionEvent({
    missionId: input.missionId,
    eventType: "mission_permission_requested",
    summary: `Permission requested: ${input.toolName}`,
    body: input.reason,
    metadata: {
      requestId: request.id,
      runId: input.runId,
      risk: input.risk,
      status: request.status,
      inputPreview: input.inputPreview ?? null,
    },
  }).catch((err) => logger.warn("Failed to log permission request:", err));

  return request;
}

export async function resolveMissionPermissionRequestForTool(input: {
  requestId: number;
  status: "approved" | "denied";
}) {
  const [request] = await db
    .update(missionPermissionRequests)
    .set({
      status: input.status,
      resolvedAt: new Date(),
    })
    .where(eq(missionPermissionRequests.id, input.requestId))
    .returning();

  if (!request) {
    return null;
  }

  await logMissionEvent({
    missionId: request.missionId,
    eventType: "mission_permission_resolved",
    summary: `Permission ${input.status}: ${request.action}`,
    body: request.reason,
    metadata: {
      requestId: request.id,
      runId: request.runId,
      risk: request.risk,
      status: request.status,
    },
  }).catch((err) => logger.warn("Failed to log permission resolution:", err));

  return request;
}
