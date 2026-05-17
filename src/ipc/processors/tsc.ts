import * as path from "node:path";
import { Worker } from "node:worker_threads";

import { ProblemReport } from "@/ipc/types";
import log from "electron-log";
import { WorkerInput, WorkerOutput } from "../../../shared/tsc_types";

import {
  getOrianBuilderDeleteTags,
  getOrianBuilderRenameTags,
  getOrianBuilderWriteTags,
} from "../utils/orianbuilder_tag_parser";
import { getTypeScriptCachePath } from "@/paths/paths";

const logger = log.scope("tsc");

export async function generateProblemReport({
  fullResponse,
  appPath,
}: {
  fullResponse: string;
  appPath: string;
}): Promise<ProblemReport> {
  return new Promise((resolve, reject) => {
    // Determine the worker script path
    const workerPath = path.join(__dirname, "tsc_worker.js");

    logger.info(`Starting TSC worker for app ${appPath}`);

    // Create the worker
    const worker = new Worker(workerPath);

    // Track whether the promise has already been resolved/rejected so the
    // `exit` handler doesn't double-fire. worker.terminate() emits an exit
    // with code 1 by design — without this flag we'd log a misleading
    // "TSC worker exited with code 1" error after a successful run.
    let settled = false;
    const settleResolve = (data: ProblemReport) => {
      if (settled) return;
      settled = true;
      resolve(data);
    };
    const settleReject = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    // Handle worker messages
    worker.on("message", (output: WorkerOutput) => {
      if (output.success && output.data) {
        logger.info(`TSC worker completed successfully for app ${appPath}`);
        settleResolve(output.data);
      } else {
        logger.error(`TSC worker failed for app ${appPath}: ${output.error}`);
        settleReject(new Error(output.error || "Unknown worker error"));
      }
      worker.terminate();
    });

    // Handle worker errors
    worker.on("error", (error) => {
      logger.error(`TSC worker error for app ${appPath}:`, error);
      settleReject(error);
      worker.terminate();
    });

    // Handle worker exit. After we've already settled (which is the normal
    // path — we terminate the worker once we have its message), a non-zero
    // exit is just the SIGTERM signature, not a failure. Only log when we
    // didn't get a message at all.
    worker.on("exit", (code) => {
      if (settled) return;
      if (code === 0) return;
      logger.error(
        `TSC worker exited with code ${code} before sending a result for app ${appPath}`,
      );
      settleReject(new Error(`Worker exited with code ${code}`));
    });

    const writeTags = getOrianBuilderWriteTags(fullResponse);
    const renameTags = getOrianBuilderRenameTags(fullResponse);
    const deletePaths = getOrianBuilderDeleteTags(fullResponse);
    const virtualChanges = {
      deletePaths,
      renameTags,
      writeTags,
    };

    // Send input to worker
    const input: WorkerInput = {
      virtualChanges,
      appPath,
      tsBuildInfoCacheDir: getTypeScriptCachePath(),
    };

    logger.info(`Sending input to TSC worker for app ${appPath}`);

    worker.postMessage(input);
  });
}
