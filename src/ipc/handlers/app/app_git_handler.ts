import { db } from "../../../db";
import { apps } from "../../../db/schema";
import { eq } from "drizzle-orm";
import { createTypedHandler } from "../base";
import { appContracts } from "../../types/app";
import { getOrianBuilderAppPath } from "../../../paths/paths";
import { withLock } from "../../utils/lock_utils";
import {
  gitListBranches,
  gitRenameBranch,
  getCurrentCommitHash,
} from "../../utils/git_utils";
import {
  OrianBuilderError,
  OrianBuilderErrorKind,
} from "@/errors/orianbuilder_error";
import { logger } from "./app_shared";
/**
 * App git IPC handlers.
 */

export function registerAppGitHandlers() {
  createTypedHandler(appContracts.renameBranch, async (_, params) => {
    const { appId, oldBranchName, newBranchName } = params;
    const app = await db.query.apps.findFirst({
      where: eq(apps.id, appId),
    });

    if (!app) {
      throw new OrianBuilderError(
        "App not found",
        OrianBuilderErrorKind.NotFound,
      );
    }

    const appPath = getOrianBuilderAppPath(app.path);

    return withLock(appId, async () => {
      try {
        // Check if the old branch exists
        const branches = await gitListBranches({ path: appPath });
        if (!branches.includes(oldBranchName)) {
          throw new OrianBuilderError(
            `Branch '${oldBranchName}' not found.`,
            OrianBuilderErrorKind.NotFound,
          );
        }

        // Check if the new branch name already exists
        if (branches.includes(newBranchName)) {
          // If newBranchName is 'main' and oldBranchName is 'master',
          // and 'main' already exists, we might want to allow this if 'main' is the current branch
          // and just switch to it, or delete 'master'.
          // For now, let's keep it simple and throw an error.
          throw new Error(
            `Branch '${newBranchName}' already exists. Cannot rename.`,
          );
        }

        await gitRenameBranch({
          path: appPath,
          oldBranch: oldBranchName,
          newBranch: newBranchName,
        });
        logger.info(
          `Branch renamed from '${oldBranchName}' to '${newBranchName}' for app ${appId}`,
        );
      } catch (error: any) {
        logger.error(
          `Failed to rename branch for app ${appId}: ${error.message}`,
        );
        throw new Error(
          `Failed to rename branch '${oldBranchName}' to '${newBranchName}': ${error.message}`,
        );
      }
    });
  });

  createTypedHandler(appContracts.getCurrentCommitHash, async (_, params) => {
    const { appId } = params;

    const appRecord = await db.query.apps.findFirst({
      where: eq(apps.id, appId),
    });
    if (!appRecord) {
      throw new OrianBuilderError(
        "App not found",
        OrianBuilderErrorKind.NotFound,
      );
    }

    const appPath = getOrianBuilderAppPath(appRecord.path);
    try {
      const commitHash = await getCurrentCommitHash({ path: appPath });
      return { commitHash };
    } catch {
      return { commitHash: null };
    }
  });
}
