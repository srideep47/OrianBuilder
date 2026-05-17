import type { ModelMessage } from "ai";
import type { missionInterrupts } from "@/db/schema";

export type MissionInterruptRecord = typeof missionInterrupts.$inferSelect;

export function formatMissionInterruptsForInjection(
  interrupts: MissionInterruptRecord[],
) {
  if (interrupts.length === 0) {
    return "";
  }

  const lines = [
    "Mission interrupt queue:",
    "These updates arrived while you were working. Account for them at this safe step boundary before continuing.",
    "",
  ];

  for (const interrupt of interrupts) {
    lines.push(`- [${interrupt.source}] ${interrupt.title}: ${interrupt.body}`);
  }

  return lines.join("\n");
}

export function buildMissionInterruptMessage(
  interrupts: MissionInterruptRecord[],
): ModelMessage | null {
  const text = formatMissionInterruptsForInjection(interrupts);
  if (!text) {
    return null;
  }

  return {
    role: "user",
    content: text,
  };
}
