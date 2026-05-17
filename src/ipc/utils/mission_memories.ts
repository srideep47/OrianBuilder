import type { ModelMessage } from "ai";
import type { missionMemories } from "@/db/schema";

export type MissionMemoryRecord = typeof missionMemories.$inferSelect;

export function formatMissionMemoriesForInjection(
  memories: MissionMemoryRecord[],
) {
  if (memories.length === 0) {
    return "";
  }

  const lines = [
    "Mission memory records:",
    "These are inspectable app or mission memories saved from prior work. Use them as context, but prefer current repo evidence when they conflict.",
    "",
  ];

  for (const memory of memories) {
    const scope = memory.missionId ? `mission:${memory.missionId}` : "app";
    lines.push(
      `- [${scope} ${memory.category}] ${memory.title}: ${memory.body}`,
    );
  }

  return lines.join("\n");
}

export function buildMissionMemoryMessage(
  memories: MissionMemoryRecord[],
): ModelMessage | null {
  const text = formatMissionMemoriesForInjection(memories);
  if (!text) {
    return null;
  }

  return {
    role: "user",
    content: text,
  };
}
