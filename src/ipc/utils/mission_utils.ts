import { db } from "@/db";
import {
  missionArtifacts,
  missionCheckpoints,
  missionEvents,
  missionInterrupts,
  missionPermissionRequests,
  missionRuns,
} from "@/db/schema";
import { and, eq, lt } from "drizzle-orm";
import {
  sanitizeMissionMetadata,
  sanitizeMissionText,
} from "./mission_hardening";
import { updateMartaTaskFromMissionEvent } from "@/main/marta/task_registry";

export async function logMissionEvent(input: {
  missionId: number | undefined | null;
  eventType: string;
  summary: string;
  body?: string | null;
  metadata?: Record<string, unknown> | null;
}) {
  if (!input.missionId) {
    return null;
  }

  const [event] = await db
    .insert(missionEvents)
    .values({
      missionId: input.missionId,
      eventType: input.eventType,
      summary: sanitizeMissionText(input.summary, "summary") ?? input.summary,
      body: sanitizeMissionText(input.body ?? null),
      metadata: sanitizeMissionMetadata(input.metadata),
    })
    .returning();

  updateMartaTaskFromMissionEvent({
    missionId: input.missionId,
    eventType: input.eventType,
    summary: event.summary,
    metadata: event.metadata,
  });

  return event;
}

export async function startMissionRun(input: {
  missionId: number | undefined | null;
  chatId: number;
  messageId: number;
  model?: string | null;
  requestId?: string | null;
  metadata?: Record<string, unknown> | null;
}) {
  if (!input.missionId) {
    return null;
  }

  const [run] = await db
    .insert(missionRuns)
    .values({
      missionId: input.missionId,
      chatId: input.chatId,
      messageId: input.messageId,
      model: input.model ?? null,
      requestId: input.requestId ?? null,
      metadata: sanitizeMissionMetadata(input.metadata),
    })
    .returning();

  return run;
}

export async function finishMissionRun(input: {
  runId: number | undefined | null;
  status: "completed" | "failed" | "cancelled";
  totalStepsExecuted: number;
  error?: string | null;
  metadata?: Record<string, unknown> | null;
}) {
  if (!input.runId) {
    return null;
  }

  const [run] = await db
    .update(missionRuns)
    .set({
      status: input.status,
      totalStepsExecuted: input.totalStepsExecuted,
      error: sanitizeMissionText(input.error ?? null),
      metadata: sanitizeMissionMetadata(input.metadata) ?? undefined,
      completedAt: new Date(),
    })
    .where(eq(missionRuns.id, input.runId))
    .returning();

  return run;
}

export async function createMissionCheckpoint(input: {
  missionId: number | undefined | null;
  runId?: number | null;
  summary: string;
  metadata?: Record<string, unknown> | null;
}) {
  if (!input.missionId) {
    return null;
  }

  const [checkpoint] = await db
    .insert(missionCheckpoints)
    .values({
      missionId: input.missionId,
      runId: input.runId ?? null,
      summary: sanitizeMissionText(input.summary, "summary") ?? input.summary,
      metadata: sanitizeMissionMetadata(input.metadata),
    })
    .returning();

  return checkpoint;
}

export async function createMissionArtifact(input: {
  missionId: number | undefined | null;
  runId?: number | null;
  artifactType:
    | "screenshot"
    | "image"
    | "audio"
    | "video"
    | "deployment"
    | "accessibility_tree"
    | "console_output"
    | "runtime";
  title: string;
  uri?: string | null;
  body?: string | null;
  mimeType?: string | null;
  metadata?: Record<string, unknown> | null;
}) {
  if (!input.missionId) {
    return null;
  }

  const [artifact] = await db
    .insert(missionArtifacts)
    .values({
      missionId: input.missionId,
      runId: input.runId ?? null,
      artifactType: input.artifactType,
      title: sanitizeMissionText(input.title, "summary") ?? input.title,
      uri: input.uri ?? null,
      body: sanitizeMissionText(input.body ?? null, "artifact_body"),
      mimeType: input.mimeType ?? null,
      metadata: sanitizeMissionMetadata(input.metadata),
    })
    .returning();

  return artifact;
}

export async function createMissionInterrupt(input: {
  missionId: number | undefined | null;
  source?: "user" | "worker" | "system" | "runtime" | "test";
  title: string;
  body: string;
  metadata?: Record<string, unknown> | null;
}) {
  if (!input.missionId) {
    return null;
  }

  const [interrupt] = await db
    .insert(missionInterrupts)
    .values({
      missionId: input.missionId,
      source: input.source ?? "system",
      title: sanitizeMissionText(input.title, "summary") ?? input.title,
      body: sanitizeMissionText(input.body) ?? input.body,
      metadata: sanitizeMissionMetadata(input.metadata),
    })
    .returning();

  return interrupt;
}

export async function createMissionPermissionRequest(input: {
  missionId: number | undefined | null;
  runId?: number | null;
  action: string;
  risk: "low" | "medium" | "high";
  reason: string;
  metadata?: Record<string, unknown> | null;
}) {
  if (!input.missionId) {
    return null;
  }

  const [request] = await db
    .insert(missionPermissionRequests)
    .values({
      missionId: input.missionId,
      runId: input.runId ?? null,
      action: sanitizeMissionText(input.action, "summary") ?? input.action,
      risk: input.risk,
      reason: sanitizeMissionText(input.reason) ?? input.reason,
      metadata: sanitizeMissionMetadata(input.metadata),
    })
    .returning();

  await logMissionEvent({
    missionId: input.missionId,
    eventType: "mission_permission_requested",
    summary: `Permission requested: ${request.action}`,
    body: request.reason,
    metadata: {
      requestId: request.id,
      runId: request.runId,
      risk: request.risk,
      status: request.status,
      ...request.metadata,
    },
  });

  return request;
}

export async function resolveMissionPermissionRequest(input: {
  requestId: number;
  status: "approved" | "denied" | "expired" | "cancelled";
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
    summary: `Permission ${request.status}: ${request.action}`,
    body: request.reason,
    metadata: {
      requestId: request.id,
      runId: request.runId,
      risk: request.risk,
      status: request.status,
    },
  });

  return request;
}

export async function expireMissionPermissionRequests(input: {
  missionId: number | undefined | null;
  olderThanMs: number;
}) {
  if (!input.missionId) {
    return [];
  }

  const now = new Date();
  const cutoff = new Date(now.getTime() - input.olderThanMs);
  const expired = await db
    .update(missionPermissionRequests)
    .set({
      status: "expired",
      resolvedAt: now,
    })
    .where(
      and(
        eq(missionPermissionRequests.missionId, input.missionId),
        eq(missionPermissionRequests.status, "pending"),
        lt(missionPermissionRequests.createdAt, cutoff),
      ),
    )
    .returning();

  if (expired.length > 0) {
    await logMissionEvent({
      missionId: input.missionId,
      eventType: "mission_permission_requests_expired",
      summary: `${expired.length} permission request${
        expired.length === 1 ? "" : "s"
      } expired`,
      metadata: {
        requestIds: expired.map((request) => request.id),
        olderThanMs: input.olderThanMs,
      },
    });
  }

  return expired;
}
