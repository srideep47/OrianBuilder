import type { FlowActivity } from "@/ipc/types/intent";
import type { FlowArtifact } from "@/ipc/types/manifest";

/**
 * Main-process projection of live Harmony work.
 *
 * Renderer events are intentionally ephemeral, but Marta's world-state digest
 * is collected in main. Keeping this tiny projection beside the runner means
 * Marta can answer "what is still running?" and "what did that flow make?"
 * even when no Stage listener happened to be mounted for an earlier event.
 */
export interface ActiveFlowActivity {
  flowId: string;
  goal: string;
  updatedAt: number;
  progress?: number;
}

interface TrackedFlow extends ActiveFlowActivity {
  active: boolean;
}

interface TrackedArtifact {
  artifact: FlowArtifact;
  timestamp: number;
}

const flows = new Map<string, TrackedFlow>();
let recentArtifacts: TrackedArtifact[] = [];
const MAX_RECENT_ARTIFACTS = 50;

export function recordFlowActivity(activity: FlowActivity): void {
  const previous = flows.get(activity.flowId);
  flows.set(activity.flowId, {
    flowId: activity.flowId,
    goal: activity.goal,
    updatedAt: activity.timestamp,
    progress: activity.progress ?? previous?.progress,
    active: activity.status !== "completed",
  });

  if (activity.artifact) {
    recentArtifacts = [
      ...recentArtifacts.filter(
        (item) => item.artifact.id !== activity.artifact?.id,
      ),
      { artifact: activity.artifact, timestamp: activity.timestamp },
    ].slice(-MAX_RECENT_ARTIFACTS);
  }
}

export function listActiveFlowActivities(): ActiveFlowActivity[] {
  return [...flows.values()]
    .filter((flow) => flow.active)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(({ active: _active, ...flow }) => flow);
}

export function listRecentFlowArtifacts(limit = 5): FlowArtifact[] {
  return [...recentArtifacts]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, Math.max(0, limit))
    .map((item) => item.artifact);
}

export function _resetFlowActivityForTests(): void {
  flows.clear();
  recentArtifacts = [];
}
