/**
 * Small utility helpers shared by the mission handler and the worker runner.
 *
 * Kept separate from mission_setup.ts so the worker runner can use them
 * without dragging in the full registerMissionHandlers dependency graph.
 */

import { eq } from "drizzle-orm";

import { db } from "@/db";
import { missions, missionWorkers } from "@/db/schema";
import {
  OrianBuilderError,
  OrianBuilderErrorKind,
} from "@/errors/orianbuilder_error";

export const DEFAULT_MAX_PARALLEL_WORKERS = 3;
export const MAX_PARALLEL_WORKERS_CAP = 8;

export function clampParallelism(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_PARALLEL_WORKERS;
  return Math.max(1, Math.min(MAX_PARALLEL_WORKERS_CAP, Math.floor(value)));
}

export function getMetadataNumber(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
): number | undefined {
  const value = metadata?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

export function getMetadataString(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

export function isNodeErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

export async function getMissionOrThrow(missionId: number) {
  const mission = await db.query.missions.findFirst({
    where: eq(missions.id, missionId),
  });

  if (!mission) {
    throw new OrianBuilderError(
      `Mission not found: ${missionId}`,
      OrianBuilderErrorKind.NotFound,
    );
  }

  return mission;
}

export async function getMissionWorkerOrThrow(workerId: number) {
  const worker = await db.query.missionWorkers.findFirst({
    where: eq(missionWorkers.id, workerId),
  });

  if (!worker) {
    throw new OrianBuilderError(
      `Mission worker not found: ${workerId}`,
      OrianBuilderErrorKind.NotFound,
    );
  }

  return worker;
}
