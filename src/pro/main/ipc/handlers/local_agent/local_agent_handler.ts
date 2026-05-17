/**
 * Local Agent v2 Handler
 * Public IPC-facing entry point for tool-based agent mode.
 */

import type { IpcMainInvokeEvent } from "electron";

import type { ChatStreamParams } from "@/ipc/types";

import {
  AgentStreamRunner,
  type AgentStreamRunnerOptions,
} from "./agent/AgentStreamRunner";

export async function handleLocalAgentStream(
  event: IpcMainInvokeEvent,
  req: ChatStreamParams,
  abortController: AbortController,
  options: AgentStreamRunnerOptions,
): Promise<boolean> {
  const runner = new AgentStreamRunner(event, req, abortController, options);
  return runner.run();
}

export { AgentStreamRunner };
export type { AgentStreamRunnerOptions };
