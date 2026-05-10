import path from "node:path";

import {
  OrianBuilderError,
  OrianBuilderErrorKind,
} from "@/errors/orianbuilder_error";

export type WorkerBranchChange = {
  status: string;
  path: string;
  previousPath?: string | null;
};

export type WorkerApplyConflict = {
  firstWorkerKey: string;
  secondWorkerKey: string;
  overlappingFiles: string[];
};

export function parseWorkerNameStatusOutput(output: string) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseWorkerNameStatusLine)
    .filter((change): change is WorkerBranchChange => change !== null);
}

export function parseWorkerNameStatusLine(
  line: string,
): WorkerBranchChange | null {
  const parts = line.split(/\t+/).filter(Boolean);
  if (parts.length < 2) {
    return null;
  }
  const status = parts[0];
  if (status.startsWith("R") && parts.length >= 3) {
    return {
      status,
      previousPath: parts[1],
      path: parts[2],
    };
  }
  return {
    status,
    path: parts[1],
  };
}

export function assertRelativeWorkerOutputPath(filePath: string) {
  const normalized = filePath.replace(/\\/g, "/");
  if (
    path.isAbsolute(filePath) ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized === ".." ||
    normalized.length === 0
  ) {
    throw new OrianBuilderError(
      `Unsafe worker output path: ${filePath}`,
      OrianBuilderErrorKind.Validation,
    );
  }
}

export function detectWorkerApplyConflicts(
  workerChanges: Array<{
    workerKey: string;
    changes: Pick<WorkerBranchChange, "path" | "previousPath">[];
  }>,
): WorkerApplyConflict[] {
  const conflicts: WorkerApplyConflict[] = [];

  for (let i = 0; i < workerChanges.length; i += 1) {
    for (let j = i + 1; j < workerChanges.length; j += 1) {
      const first = workerChanges[i];
      const second = workerChanges[j];
      const firstPaths = getTouchedPaths(first.changes);
      const secondPaths = getTouchedPaths(second.changes);
      const overlappingFiles = firstPaths.filter((firstPath) =>
        secondPaths.some((secondPath) =>
          workerOutputPathsOverlap(firstPath, secondPath),
        ),
      );

      if (overlappingFiles.length > 0) {
        conflicts.push({
          firstWorkerKey: first.workerKey,
          secondWorkerKey: second.workerKey,
          overlappingFiles,
        });
      }
    }
  }

  return conflicts;
}

function getTouchedPaths(
  changes: Pick<WorkerBranchChange, "path" | "previousPath">[],
) {
  return [
    ...new Set(
      changes.flatMap((change) =>
        change.previousPath
          ? [change.previousPath, change.path]
          : [change.path],
      ),
    ),
  ];
}

function workerOutputPathsOverlap(first: string, second: string) {
  const left = normalizeWorkerOutputPath(first);
  const right = normalizeWorkerOutputPath(second);
  return (
    left === right ||
    left.startsWith(`${right}/`) ||
    right.startsWith(`${left}/`)
  );
}

function normalizeWorkerOutputPath(filePath: string) {
  return filePath
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
}
