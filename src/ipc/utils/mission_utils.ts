import { db } from "@/db";
import {
  missionArtifacts,
  missionCheckpoints,
  missionEvents,
  missionRuns,
} from "@/db/schema";
import { eq } from "drizzle-orm";

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
      summary: input.summary,
      body: input.body ?? null,
      metadata: input.metadata ?? null,
    })
    .returning();

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
      metadata: input.metadata ?? null,
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
      error: input.error ?? null,
      metadata: input.metadata ?? undefined,
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
      summary: input.summary,
      metadata: input.metadata ?? null,
    })
    .returning();

  return checkpoint;
}

export async function createMissionArtifact(input: {
  missionId: number | undefined | null;
  runId?: number | null;
  artifactType:
    | "screenshot"
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
      title: input.title,
      uri: input.uri ?? null,
      body: input.body ?? null,
      mimeType: input.mimeType ?? null,
      metadata: input.metadata ?? null,
    })
    .returning();

  return artifact;
}
