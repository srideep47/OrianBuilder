export function getMidTurnCompactionSummaryIds(
  chatMessages: Array<{
    id: number;
    role: string;
    createdAt: Date;
    isCompactionSummary: boolean | null;
  }>,
): Set<number> {
  const hiddenIds = new Set<number>();

  for (const summary of chatMessages.filter((m) => m.isCompactionSummary)) {
    const triggeringUserMessage = [...chatMessages]
      .filter((m) => m.role === "user" && m.id < summary.id)
      .sort((a, b) => b.id - a.id)[0];

    if (!triggeringUserMessage) {
      continue;
    }

    if (
      summary.createdAt.getTime() >= triggeringUserMessage.createdAt.getTime()
    ) {
      hiddenIds.add(summary.id);
    }
  }

  return hiddenIds;
}
