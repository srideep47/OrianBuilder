import { useAtomValue } from "jotai";
import { Loader2, CheckCircle2, XCircle } from "lucide-react";
import { agentProgressByChatIdAtom } from "@/atoms/chatAtoms";
import type { ProgressAnnotation } from "@/ipc/types/agent";

interface AgentProgressListProps {
  chatId: number | null;
}

function ProgressRow({ entry }: { entry: ProgressAnnotation }) {
  const icon =
    entry.status === "in-progress" ? (
      <Loader2 size={14} className="animate-spin text-blue-500" />
    ) : entry.status === "completed" ? (
      <CheckCircle2 size={14} className="text-emerald-500" />
    ) : (
      <XCircle size={14} className="text-red-500" />
    );
  const stepHint =
    entry.step !== undefined && entry.totalSteps !== undefined
      ? ` (${entry.step}/${entry.totalSteps})`
      : "";
  return (
    <div className="flex items-center gap-2 px-2 py-1 text-xs">
      <span className="flex-shrink-0">{icon}</span>
      <span className="truncate text-muted-foreground">
        {entry.label}
        {stepHint}
      </span>
    </div>
  );
}

/**
 * Renders live progress annotations emitted by agent tools (multi-step
 * operations like APK packaging or browser QA). Entries with the same id
 * collapse into a single row so users see step updates rather than a growing
 * list. Hidden when there is nothing in-flight or recently finished.
 */
export function AgentProgressList({ chatId }: AgentProgressListProps) {
  const byChat = useAtomValue(agentProgressByChatIdAtom);
  if (chatId === null) return null;
  const progressMap = byChat.get(chatId);
  if (!progressMap || progressMap.size === 0) return null;
  const entries = Array.from(progressMap.values());
  return (
    <div className="border-b border-border bg-muted/30 py-1">
      {entries.map((entry) => (
        <ProgressRow key={entry.id} entry={entry} />
      ))}
    </div>
  );
}
