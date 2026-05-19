import { Lock, X } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useChatLocks } from "@/hooks/useChatLocks";

interface LockedFilesPanelProps {
  chatId: number | null;
}

/**
 * Compact pill row showing every path the user has locked for this chat. The
 * agent refuses to write/edit/delete/rename anything in this list. Click the X
 * to unlock. Hidden when no locks exist.
 */
export function LockedFilesPanel({ chatId }: LockedFilesPanelProps) {
  const { lockedPaths, removeLock } = useChatLocks(chatId);
  if (lockedPaths.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-border bg-amber-500/5 px-2 py-1.5">
      <Tooltip>
        <TooltipTrigger
          render={
            <span className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400 mr-1">
              <Lock size={12} />
              Locked
            </span>
          }
        />
        <TooltipContent>
          The agent will not modify these paths for this chat.
        </TooltipContent>
      </Tooltip>
      {lockedPaths.map((path) => (
        <span
          key={path}
          className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-300 max-w-[240px]"
          title={path}
        >
          <span className="truncate">{path}</span>
          <button
            type="button"
            onClick={() => removeLock(path)}
            aria-label={`Unlock ${path}`}
            className="opacity-60 hover:opacity-100 flex-shrink-0"
          >
            <X size={11} />
          </button>
        </span>
      ))}
    </div>
  );
}
