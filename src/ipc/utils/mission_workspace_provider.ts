import path from "node:path";
import { promises as fsPromises } from "node:fs";

import {
  OrianBuilderError,
  OrianBuilderErrorKind,
} from "@/errors/orianbuilder_error";
import type { MissionWorker } from "@/ipc/types/mission";
import { execGit } from "@/ipc/utils/git_utils";

export type MissionWorkspaceProviderKind =
  | "local"
  | "worktree"
  | "docker"
  | "cloud";

export type MissionWorkerWorkspacePlan = {
  provider: MissionWorkspaceProviderKind;
  workspaceRef: string;
  branchName: string | null;
  promptPackage: string;
};

export interface MissionWorkspaceProvider {
  kind: MissionWorkspaceProviderKind;
  prepare(input: {
    appPath: string;
    missionId: number;
    worker: MissionWorker;
  }): Promise<MissionWorkerWorkspacePlan>;
}

export function sanitizeWorkerIdentifier(value: string) {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return sanitized || "worker";
}

export function buildMissionWorkerBranchName(input: {
  missionId: number;
  workerKey: string;
}) {
  return `orian/mission-${input.missionId}/${sanitizeWorkerIdentifier(
    input.workerKey,
  )}`;
}

export function buildMissionWorkerWorktreePath(input: {
  appPath: string;
  missionId: number;
  workerKey: string;
}) {
  const appName = sanitizeWorkerIdentifier(path.basename(input.appPath));
  return path.join(
    path.dirname(input.appPath),
    ".orian-worker-worktrees",
    appName,
    `mission-${input.missionId}`,
    sanitizeWorkerIdentifier(input.workerKey),
  );
}

export function buildMissionWorkerPromptPackage(input: {
  missionId: number;
  worker: Pick<
    MissionWorker,
    | "workerKey"
    | "role"
    | "title"
    | "goal"
    | "fileScopes"
    | "dependsOn"
    | "workspaceProvider"
    | "workspaceRef"
    | "branchName"
  >;
}) {
  const worker = input.worker;
  return [
    `Mission worker: ${worker.workerKey}`,
    `Mission id: ${input.missionId}`,
    `Role: ${worker.role}`,
    `Title: ${worker.title}`,
    `Goal: ${worker.goal}`,
    `Workspace provider: ${worker.workspaceProvider}`,
    `Workspace path: ${worker.workspaceRef ?? "(not prepared)"}`,
    `Branch: ${worker.branchName ?? "(none)"}`,
    `File scopes: ${(worker.fileScopes ?? []).join(", ") || "(none)"}`,
    `Depends on: ${(worker.dependsOn ?? []).join(", ") || "(none)"}`,
    "",
    "Completion report required:",
    "- summary",
    "- changed files",
    "- validation performed",
    "- blockers or follow-ups",
    "- artifacts produced",
  ].join("\n");
}

export const localMissionWorkspaceProvider: MissionWorkspaceProvider = {
  kind: "local",
  async prepare({ appPath, missionId, worker }) {
    const planWorker = {
      ...worker,
      workspaceRef: appPath,
      branchName: null,
    };
    return {
      provider: "local",
      workspaceRef: appPath,
      branchName: null,
      promptPackage: buildMissionWorkerPromptPackage({
        missionId,
        worker: planWorker,
      }),
    };
  },
};

export const gitWorktreeMissionWorkspaceProvider: MissionWorkspaceProvider = {
  kind: "worktree",
  async prepare({ appPath, missionId, worker }) {
    const branchName =
      worker.branchName ??
      buildMissionWorkerBranchName({
        missionId,
        workerKey: worker.workerKey,
      });
    const workspaceRef =
      worker.workspaceRef ??
      buildMissionWorkerWorktreePath({
        appPath,
        missionId,
        workerKey: worker.workerKey,
      });

    await ensureGitWorktree({
      repositoryPath: appPath,
      worktreePath: workspaceRef,
      branchName,
    });

    const planWorker = {
      ...worker,
      workspaceRef,
      branchName,
    };
    return {
      provider: "worktree",
      workspaceRef,
      branchName,
      promptPackage: buildMissionWorkerPromptPackage({
        missionId,
        worker: planWorker,
      }),
    };
  },
};

export function getMissionWorkspaceProvider(
  kind: MissionWorkspaceProviderKind,
): MissionWorkspaceProvider {
  switch (kind) {
    case "local":
      return localMissionWorkspaceProvider;
    case "worktree":
      return gitWorktreeMissionWorkspaceProvider;
    case "docker":
    case "cloud":
      throw new OrianBuilderError(
        `${kind} mission worker workspaces are not implemented yet.`,
        OrianBuilderErrorKind.Precondition,
      );
    default:
      throw new OrianBuilderError(
        `Unsupported mission worker workspace provider: ${kind}`,
        OrianBuilderErrorKind.Validation,
      );
  }
}

async function ensureGitWorktree(input: {
  repositoryPath: string;
  worktreePath: string;
  branchName: string;
}) {
  const existingGitFile = path.join(input.worktreePath, ".git");
  if (await pathExists(existingGitFile)) {
    return;
  }

  await fsPromises.mkdir(path.dirname(input.worktreePath), {
    recursive: true,
  });

  const branchExists = await gitBranchExists({
    repositoryPath: input.repositoryPath,
    branchName: input.branchName,
  });
  const args = branchExists
    ? ["worktree", "add", input.worktreePath, input.branchName]
    : ["worktree", "add", "-b", input.branchName, input.worktreePath, "HEAD"];
  const result = await execGit(args, input.repositoryPath);
  if (result.exitCode !== 0) {
    throw new OrianBuilderError(
      `Failed to create worker worktree '${input.worktreePath}' for branch '${input.branchName}': ${
        result.stderr.trim() || result.stdout.trim()
      }`,
      OrianBuilderErrorKind.External,
    );
  }
}

async function gitBranchExists(input: {
  repositoryPath: string;
  branchName: string;
}) {
  const result = await execGit(
    ["show-ref", "--verify", `refs/heads/${input.branchName}`],
    input.repositoryPath,
  );
  return result.exitCode === 0;
}

async function pathExists(targetPath: string) {
  try {
    await fsPromises.access(targetPath);
    return true;
  } catch {
    return false;
  }
}
