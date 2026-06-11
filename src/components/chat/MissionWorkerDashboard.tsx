import {
  CheckCircle2,
  FileText,
  Image as ImageIcon,
  PackageCheck,
  Terminal,
  XCircle,
} from "lucide-react";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { MissionEvent, MissionWorker } from "@/ipc/types";
import {
  type NormalizedMissionWorkerReport,
  type WorkerIntegrationStatus,
} from "@/ipc/utils/mission_workers";
import { parseWorkerUnifiedDiff } from "@/ipc/utils/mission_worker_diff";

export type MissionWorkerDashboardItem = {
  worker: MissionWorker;
  report: NormalizedMissionWorkerReport | null;
  diffEvent?: MissionEvent;
  integrationStatus: WorkerIntegrationStatus;
  outputAppliedAt?: string;
  changedFiles: string[];
  workerEvents: MissionEvent[];
};

export function MissionWorkerDashboard({
  items,
  acceptedUnappliedCount,
  onApplyAccepted,
  onSetIntegrationStatus,
}: {
  items: MissionWorkerDashboardItem[];
  acceptedUnappliedCount: number;
  onApplyAccepted: () => void;
  onSetIntegrationStatus: (
    workerId: number,
    status: "applied" | "rejected",
  ) => void;
}) {
  const completedCount = items.filter(
    (item) => item.worker.status === "completed",
  ).length;
  const runningCount = items.filter(
    (item) => item.worker.status === "running",
  ).length;
  const blockedCount = items.filter((item) =>
    ["blocked", "failed", "cancelled"].includes(item.worker.status),
  ).length;

  return (
    <div className="mt-2 max-h-[28rem] overflow-y-auto border-t pt-2">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 text-xs font-medium">
          <FileText className="size-3.5 shrink-0" />
          <span className="truncate">Worker dashboard</span>
          <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
            {completedCount}/{items.length} complete
          </Badge>
          {runningCount > 0 && (
            <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
              {runningCount} running
            </Badge>
          )}
          {blockedCount > 0 && (
            <Badge variant="destructive" className="h-5 px-1.5 text-[10px]">
              {blockedCount} blocked
            </Badge>
          )}
        </div>
        {acceptedUnappliedCount > 0 && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 px-2 text-xs"
            onClick={onApplyAccepted}
          >
            <PackageCheck className="size-3.5" />
            Apply accepted
          </Button>
        )}
      </div>

      <div className="mb-2 overflow-x-auto rounded border">
        <div className="grid min-w-[44rem] grid-cols-[1.2fr_0.8fr_0.8fr_1.2fr_1.4fr] gap-2 border-b bg-muted/50 px-2 py-1.5 text-[10px] font-medium uppercase text-muted-foreground">
          <span>Worker</span>
          <span>Status</span>
          <span>Review</span>
          <span>Dependencies</span>
          <span>Workspace</span>
        </div>
        {items.map((item) => (
          <div
            key={item.worker.id}
            className="grid min-w-[44rem] grid-cols-[1.2fr_0.8fr_0.8fr_1.2fr_1.4fr] gap-2 border-b px-2 py-1.5 text-xs last:border-b-0"
          >
            <div className="min-w-0">
              <div className="truncate font-medium">
                {item.worker.workerKey}
              </div>
              <div className="truncate text-muted-foreground">
                {item.worker.role}
              </div>
            </div>
            <WorkerStatusBadge status={item.worker.status} />
            <IntegrationBadge status={item.integrationStatus} />
            <span className="truncate text-muted-foreground">
              {item.worker.dependsOn?.join(", ") || "none"}
            </span>
            <span
              className="truncate text-muted-foreground"
              title={item.worker.workspaceRef ?? item.worker.branchName ?? ""}
            >
              {item.worker.branchName ??
                item.worker.workspaceRef ??
                item.worker.workspaceProvider}
            </span>
          </div>
        ))}
      </div>

      <Accordion multiple className="space-y-2">
        {items.map((item) => (
          <AccordionItem
            key={item.worker.id}
            value={`worker-${item.worker.id}`}
            className="rounded border bg-transparent/60 px-2 border-b"
          >
            <AccordionTrigger className="py-2 hover:no-underline">
              <div className="flex min-w-0 flex-1 items-center gap-2 pr-2 text-xs">
                <span className="truncate font-medium">
                  {item.worker.workerKey}
                </span>
                <WorkerStatusBadge status={item.worker.status} />
                <IntegrationBadge status={item.integrationStatus} />
                {item.outputAppliedAt && (
                  <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
                    applied
                  </Badge>
                )}
                {item.changedFiles.length > 0 && (
                  <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                    {item.changedFiles.length} file
                    {item.changedFiles.length === 1 ? "" : "s"}
                  </Badge>
                )}
              </div>
            </AccordionTrigger>
            <AccordionContent className="pb-2">
              <WorkerDetails
                item={item}
                onSetIntegrationStatus={onSetIntegrationStatus}
              />
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </div>
  );
}

function WorkerDetails({
  item,
  onSetIntegrationStatus,
}: {
  item: MissionWorkerDashboardItem;
  onSetIntegrationStatus: (
    workerId: number,
    status: "applied" | "rejected",
  ) => void;
}) {
  const parsedDiff = parseWorkerUnifiedDiff(item.diffEvent?.body);

  return (
    <div className="space-y-3 text-xs">
      <div className="grid gap-2 sm:grid-cols-2">
        <InfoRow label="Title" value={item.worker.title} />
        <InfoRow label="Provider" value={item.worker.workspaceProvider} />
        <InfoRow label="Branch" value={item.worker.branchName ?? "none"} />
        <InfoRow
          label="Workspace"
          value={item.worker.workspaceRef ?? "local"}
        />
        <InfoRow
          label="File scopes"
          value={item.worker.fileScopes?.join(", ") || "none"}
        />
        <InfoRow
          label="Dependencies"
          value={item.worker.dependsOn?.join(", ") || "none"}
        />
      </div>

      <div>
        <div className="mb-1 font-medium">Goal</div>
        <div className="rounded bg-muted px-2 py-1 text-muted-foreground">
          {item.worker.goal}
        </div>
      </div>

      {item.report ? (
        <div className="space-y-2">
          <div>
            <div className="mb-1 font-medium">Report</div>
            <div className="rounded bg-muted px-2 py-1 text-muted-foreground">
              {item.report.summary}
            </div>
          </div>
          {item.report.blockers && (
            <div className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-amber-800 dark:text-amber-200">
              {item.report.blockers}
            </div>
          )}
          {item.report.validation && (
            <div className="rounded bg-muted px-2 py-1 text-muted-foreground">
              Validation: {item.report.validation}
            </div>
          )}
        </div>
      ) : (
        <div className="rounded bg-muted px-2 py-1 text-muted-foreground">
          No completion report yet.
        </div>
      )}

      {item.integrationStatus === "pending" && item.report && (
        <div className="flex flex-wrap gap-1">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 px-2 text-xs"
            onClick={() => onSetIntegrationStatus(item.worker.id, "applied")}
          >
            <CheckCircle2 className="size-3.5" />
            Accept output
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 px-2 text-xs"
            onClick={() => onSetIntegrationStatus(item.worker.id, "rejected")}
          >
            <XCircle className="size-3.5" />
            Reject output
          </Button>
        </div>
      )}

      {item.changedFiles.length > 0 && (
        <div>
          <div className="mb-1 font-medium">Changed files</div>
          <div className="flex flex-wrap gap-1">
            {item.changedFiles.map((file) => (
              <Badge
                key={file}
                variant="outline"
                className="max-w-[18rem] truncate px-1.5 py-0 text-[10px]"
                title={file}
              >
                {file}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {parsedDiff.length > 0 ? (
        <div>
          <div className="mb-1 font-medium">File diffs</div>
          <Accordion multiple className="space-y-1">
            {parsedDiff.map((file) => (
              <AccordionItem
                key={file.displayPath}
                value={file.displayPath}
                className="rounded border px-2 border-b"
              >
                <AccordionTrigger className="py-1.5 text-xs hover:no-underline">
                  <div className="flex min-w-0 flex-1 items-center gap-2 pr-2">
                    <FileText className="size-3.5 shrink-0" />
                    <span className="truncate">{file.displayPath}</span>
                    <Badge
                      className="h-5 px-1.5 text-[10px]"
                      variant="secondary"
                    >
                      +{file.additions} -{file.deletions}
                    </Badge>
                  </div>
                </AccordionTrigger>
                <AccordionContent className="pb-2">
                  <pre className="max-h-56 overflow-auto rounded bg-muted px-2 py-1 text-[10px] leading-relaxed">
                    {file.lines.map((line, index) => (
                      <div
                        key={`${file.displayPath}-${index}`}
                        className={cn(
                          "whitespace-pre-wrap",
                          line.type === "added" &&
                            "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                          line.type === "removed" &&
                            "bg-red-500/10 text-red-700 dark:text-red-300",
                          line.type === "meta" && "text-muted-foreground",
                        )}
                      >
                        {line.text || " "}
                      </div>
                    ))}
                  </pre>
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      ) : item.diffEvent?.body ? (
        <pre className="max-h-40 overflow-auto rounded bg-muted px-2 py-1 text-[10px] leading-relaxed text-muted-foreground">
          {item.diffEvent.body}
        </pre>
      ) : null}

      {item.report?.artifacts && item.report.artifacts.length > 0 && (
        <div className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
          <ImageIcon className="size-3.5 shrink-0" />
          <span className="truncate">{item.report.artifacts.join(", ")}</span>
        </div>
      )}

      {item.workerEvents.length > 0 && (
        <div>
          <div className="mb-1 flex items-center gap-1.5 font-medium">
            <Terminal className="size-3.5" />
            Session events
          </div>
          <div className="space-y-1">
            {item.workerEvents.slice(0, 8).map((event) => (
              <div
                key={event.id}
                className="flex min-w-0 items-start justify-between gap-2 rounded bg-muted px-2 py-1 text-muted-foreground"
              >
                <span className="min-w-0 truncate">{event.summary}</span>
                <span className="shrink-0">
                  {new Date(event.createdAt).toLocaleTimeString()}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase text-muted-foreground">{label}</div>
      <div className="truncate" title={value}>
        {value}
      </div>
    </div>
  );
}

function WorkerStatusBadge({ status }: { status: MissionWorker["status"] }) {
  return (
    <Badge
      variant={
        ["blocked", "failed", "cancelled"].includes(status)
          ? "destructive"
          : status === "completed"
            ? "secondary"
            : "outline"
      }
      className="h-5 w-fit px-1.5 text-[10px] capitalize"
    >
      {status.replace(/_/g, " ")}
    </Badge>
  );
}

function IntegrationBadge({ status }: { status: WorkerIntegrationStatus }) {
  return (
    <Badge
      variant={status === "rejected" ? "destructive" : "secondary"}
      className="h-5 w-fit px-1.5 text-[10px] capitalize"
    >
      {status}
    </Badge>
  );
}
