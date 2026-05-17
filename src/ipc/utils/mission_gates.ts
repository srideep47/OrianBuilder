export type MissionGateEventLike = {
  eventType: string;
  summary?: string | null;
  metadata: Record<string, unknown> | null;
};

export type PostCreateGateStatus = {
  requiredChecks: string[];
  completedChecks: string[];
  missingChecks: string[];
  failedChecks: string[];
  isRequired: boolean;
  isSatisfied: boolean;
};

function getStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function addPassedCheck(event: MissionGateEventLike, passed: Set<string>) {
  if (event.metadata?.status !== "passed") {
    return;
  }
  const check = event.metadata.check;
  const gate = event.metadata.gate;
  if (typeof check === "string") {
    passed.add(check);
  }
  if (typeof gate === "string") {
    passed.add(gate);
  }
}

function addFailedCheck(event: MissionGateEventLike, failed: Set<string>) {
  if (event.metadata?.status !== "failed") {
    return;
  }
  const check = event.metadata.check;
  const gate = event.metadata.gate;
  if (typeof check === "string") {
    failed.add(check);
  }
  if (typeof gate === "string") {
    failed.add(gate);
  }
}

export function getPostCreateGateStatus(
  events: MissionGateEventLike[],
): PostCreateGateStatus {
  const requiredEvent = events.find(
    (event) => event.eventType === "post_create_verification_required",
  );
  const requiredChecks = getStringArray(
    requiredEvent?.metadata?.requiredChecks,
  );
  const passed = new Set<string>();
  const failed = new Set<string>();

  for (const event of events) {
    addPassedCheck(event, passed);
    addFailedCheck(event, failed);
  }

  const completedChecks = requiredChecks.filter((check) => passed.has(check));
  const missingChecks = requiredChecks.filter((check) => !passed.has(check));
  const failedChecks = requiredChecks.filter((check) => failed.has(check));

  return {
    requiredChecks,
    completedChecks,
    missingChecks,
    failedChecks,
    isRequired: requiredChecks.length > 0,
    isSatisfied: requiredChecks.length === 0 || missingChecks.length === 0,
  };
}
