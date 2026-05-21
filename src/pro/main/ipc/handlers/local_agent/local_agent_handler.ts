/**
 * Local Agent v2 Handler
 * Public IPC-facing entry point for tool-based agent mode.
 */

import os from "node:os";
import type { IpcMainInvokeEvent } from "electron";

import type { ChatStreamParams } from "@/ipc/types";
import {
  OrianBuilderError,
  OrianBuilderErrorKind,
} from "@/errors/orianbuilder_error";

import {
  AgentStreamRunner,
  type AgentStreamRunnerOptions,
} from "./agent/AgentStreamRunner";

const SYSTEM_MEMORY_BLOCK_THRESHOLD_PCT = 90;

export async function handleLocalAgentStream(
  event: IpcMainInvokeEvent,
  req: ChatStreamParams,
  abortController: AbortController,
  options: AgentStreamRunnerOptions,
): Promise<boolean> {
  const totalMem = os.totalmem();
  const usedPct = ((totalMem - os.freemem()) / totalMem) * 100;
  if (usedPct >= SYSTEM_MEMORY_BLOCK_THRESHOLD_PCT) {
    throw new OrianBuilderError(
      `System memory is critically low (${usedPct.toFixed(0)}% used). ` +
        `Close other applications to free RAM before starting a long agent run — ` +
        `the renderer process will crash if memory stays this high.`,
      OrianBuilderErrorKind.Precondition,
    );
  }
  const runner = new AgentStreamRunner(event, req, abortController, options);
  return runner.run();
}

export { AgentStreamRunner };
export type { AgentStreamRunnerOptions };
