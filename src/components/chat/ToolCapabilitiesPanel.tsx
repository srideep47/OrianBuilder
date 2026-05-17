import { ShieldAlert, ShieldCheck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  getGroupedToolCapabilities,
  type ToolCapabilityListItem,
} from "@/ipc/utils/tool_capability_groups";
import { cn } from "@/lib/utils";

const TOOL_GROUPS = getGroupedToolCapabilities();

export function ToolCapabilitiesPanel() {
  return (
    <div className="mt-2 border-t pt-2">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium">
        <ShieldCheck className="size-3.5" />
        <span>Tool Capabilities</span>
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        {TOOL_GROUPS.map((group) => (
          <div key={group.key} className="min-w-0 rounded border p-2">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="text-xs font-medium">{group.label}</span>
              <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
                {group.items.length}
              </Badge>
            </div>
            <div className="max-h-32 space-y-1 overflow-y-auto pr-1">
              {group.items.map((item) => (
                <ToolCapabilityRow key={item.toolName} item={item} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ToolCapabilityRow({ item }: { item: ToolCapabilityListItem }) {
  return (
    <div
      className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
      title={`${item.toolName}: ${item.risk} risk, ${item.stateScope}, ${item.isolation} isolation`}
    >
      {item.alwaysAsk ? (
        <ShieldAlert className="size-3 shrink-0 text-amber-600 dark:text-amber-300" />
      ) : (
        <ShieldCheck className="size-3 shrink-0" />
      )}
      <span className="min-w-0 flex-1 truncate text-foreground">
        {item.toolName}
      </span>
      <span
        className={cn(
          "shrink-0 rounded border px-1 py-0 text-[10px] capitalize",
          item.risk === "low" &&
            "border-emerald-500/30 text-emerald-700 dark:text-emerald-300",
          item.risk === "medium" &&
            "border-amber-500/30 text-amber-700 dark:text-amber-300",
          item.risk === "high" &&
            "border-red-500/30 text-red-700 dark:text-red-300",
          item.risk === "critical" &&
            "border-red-600 bg-red-500/10 text-red-700 dark:text-red-300",
        )}
      >
        {item.risk}
      </span>
      {item.alwaysAsk && (
        <span className="shrink-0 rounded border border-amber-500/30 px-1 py-0 text-[10px] text-amber-700 dark:text-amber-300">
          ask
        </span>
      )}
    </div>
  );
}
