import type { MartaTaskStatus } from "@/ipc/types/marta";

export interface MissionTaskTransition {
  status: MartaTaskStatus;
  failedSignal: boolean;
  completedSignal: boolean;
}

/** Reduce one mission event without allowing late telemetry to reopen a task. */
export function deriveMissionTaskTransition(input: {
  currentStatus: MartaTaskStatus;
  eventType: string;
  metadata?: Record<string, unknown> | null;
}): MissionTaskTransition {
  const reportedStatus = input.metadata?.status;
  const failedSignal =
    /failed/.test(input.eventType) || reportedStatus === "failed";
  const completedSignal =
    /mission_completed/.test(input.eventType) || reportedStatus === "completed";
  const alreadyTerminal = ["succeeded", "failed", "cancelled"].includes(
    input.currentStatus,
  );

  return {
    status:
      alreadyTerminal && !failedSignal && !completedSignal
        ? input.currentStatus
        : failedSignal
          ? "failed"
          : completedSignal
            ? "succeeded"
            : /permission|blocked|interrupt/.test(input.eventType)
              ? "waiting"
              : "running",
    failedSignal,
    completedSignal,
  };
}
