import { useEffect, useMemo, useState } from "react";
import { useAtom, useAtomValue } from "jotai";
import {
  Bot,
  BellRing,
  Camera,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CirclePause,
  Clock3,
  Eye,
  FileText,
  Image as ImageIcon,
  Music,
  PackageCheck,
  Play,
  Rocket,
  RotateCcw,
  Send,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  GitBranch,
  Target,
  Terminal,
  Trash2,
  UsersRound,
  Video,
  XCircle,
} from "lucide-react";

import {
  activeMissionByChatIdAtom,
  chatInputValueAtom,
  queuePausedByIdAtom,
  streamCompletedSuccessfullyByIdAtom,
} from "@/atoms/chatAtoms";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { MissionWorkerDashboard } from "@/components/chat/MissionWorkerDashboard";
import { ToolCapabilitiesPanel } from "@/components/chat/ToolCapabilitiesPanel";
import { useMissions } from "@/hooks/useMissions";
import { useSettings } from "@/hooks/useSettings";
import { cn } from "@/lib/utils";
import {
  buildWorkerIntegrationPlan,
  buildWorkerSeedFromTasks,
  detectWorkerScopeConflicts,
  getWorkerIntegrationStatus,
  getWorkerReport,
  selectDispatchableWorkers,
  workerHasStaleMetadata,
} from "@/ipc/utils/mission_workers";

export function MissionControl({ chatId }: { chatId?: number }) {
  const [showTimeline, setShowTimeline] = useState(false);
  const [showWorkerReview, setShowWorkerReview] = useState(false);
  const [showToolCapabilities, setShowToolCapabilities] = useState(false);
  const appId = useAtomValue(selectedAppIdAtom);
  const inputValue = useAtomValue(chatInputValueAtom);
  const [activeMissionByChatId, setActiveMissionByChatId] = useAtom(
    activeMissionByChatIdAtom,
  );
  const [, setQueuePausedById] = useAtom(queuePausedByIdAtom);
  const [, setStreamCompletedSuccessfullyById] = useAtom(
    streamCompletedSuccessfullyByIdAtom,
  );
  const { settings } = useSettings();
  const activeMissionId = chatId
    ? (activeMissionByChatId.get(chatId) ?? null)
    : null;
  const {
    missions,
    mission,
    events,
    tasks,
    runs,
    workers,
    checkpoints,
    artifacts,
    interrupts,
    memories,
    permissionRequests,
    createMission,
    updateMissionStatus,
    createMissionWorker,
    dispatchMissionWorkers,
    retryMissionWorker,
    markStaleMissionWorkers,
    prepareMissionWorkerWorkspace,
    setMissionWorkerIntegrationStatus,
    runReadyMissionWorkers,
    applyAcceptedMissionWorkerOutputs,
    cleanupAppliedMissionWorkerWorkspaces,
    resolveMissionPermissionRequest,
  } = useMissions(appId, activeMissionId);

  const latestMissionForChat = useMemo(() => {
    if (!chatId) {
      return null;
    }
    return missions.find((candidate) => candidate.chatId === chatId) ?? null;
  }, [chatId, missions]);

  const visibleMission = mission ?? latestMissionForChat;
  const latestEvent = events[0];
  const latestRun = runs[0];
  const latestCheckpoint = checkpoints[0];
  const pendingInterrupts = useMemo(
    () => interrupts.filter((interrupt) => interrupt.status === "pending"),
    [interrupts],
  );
  const latestInterrupt = interrupts[0];
  const pendingPermissionRequests = useMemo(
    () => permissionRequests.filter((request) => request.status === "pending"),
    [permissionRequests],
  );
  const goal = inputValue.trim() || "Autonomous development mission";
  const completedTaskCount = tasks.filter(
    (task) => task.status === "completed",
  ).length;
  const verificationChecks = useMemo(
    () =>
      [
        { key: "install", label: "Install" },
        { key: "typecheck", label: "Types" },
        { key: "build", label: "Build" },
        { key: "test", label: "Tests" },
        { key: "start_app", label: "Run" },
      ].map((check) => {
        const event = events.find(
          (candidate) =>
            candidate.eventType === `verification_${check.key}` ||
            getMissionEventMetadataString(candidate.metadata, "check") ===
              check.key,
        );
        return {
          ...check,
          event,
          status: getMissionEventMetadataString(event?.metadata, "status"),
        };
      }),
    [events],
  );

  const visualChecks = useMemo(
    () =>
      [
        { key: "screenshot", label: "Visual", icon: Camera },
        { key: "accessibility", label: "A11y", icon: Eye },
        { key: "console", label: "Console", icon: Terminal },
        { key: "runtime", label: "Runtime", icon: Play },
      ].map((check) => {
        const event = events.find(
          (candidate) =>
            getMissionEventMetadataString(candidate.metadata, "gate") ===
            check.key,
        );
        const status = getMissionEventMetadataString(event?.metadata, "status");
        return {
          ...check,
          event,
          status: status === "passed" || status === "failed" ? status : "",
        };
      }),
    [events],
  );

  const screenshotArtifacts = useMemo(
    () =>
      artifacts.filter((artifact) => artifact.artifactType === "screenshot"),
    [artifacts],
  );
  const deploymentArtifacts = useMemo(
    () =>
      artifacts.filter((artifact) => artifact.artifactType === "deployment"),
    [artifacts],
  );
  const mediaArtifacts = useMemo(
    () =>
      artifacts.filter((artifact) =>
        ["image", "audio", "video"].includes(artifact.artifactType),
      ),
    [artifacts],
  );
  const latestArtifacts = useMemo(() => artifacts.slice(0, 3), [artifacts]);
  const workerConflicts = useMemo(
    () => detectWorkerScopeConflicts(workers),
    [workers],
  );
  const dispatchableWorkers = useMemo(
    () => selectDispatchableWorkers(workers),
    [workers],
  );
  const queuedDispatchableWorkers = useMemo(
    () => dispatchableWorkers.filter((worker) => worker.status === "queued"),
    [dispatchableWorkers],
  );
  const readyDispatchableWorkers = useMemo(
    () => dispatchableWorkers.filter((worker) => worker.status === "ready"),
    [dispatchableWorkers],
  );
  const runningWorkers = useMemo(
    () => workers.filter((worker) => worker.status === "running"),
    [workers],
  );
  const unpreparedWorkers = useMemo(
    () =>
      workers.filter(
        (worker) =>
          worker.workspaceProvider !== "local" && !worker.workspaceRef,
      ),
    [workers],
  );
  const retryableWorkers = useMemo(
    () =>
      workers.filter(
        (worker) =>
          ["blocked", "failed", "cancelled"].includes(worker.status) ||
          workerHasStaleMetadata(worker),
      ),
    [workers],
  );
  const workerReports = useMemo(
    () =>
      workers
        .map((worker) => ({
          worker,
          report: getWorkerReport(worker.metadata),
        }))
        .filter((entry) => entry.report !== null),
    [workers],
  );
  const workerIntegrationPlan = useMemo(
    () => buildWorkerIntegrationPlan(workers),
    [workers],
  );
  const workerReviewItems = useMemo(
    () =>
      workers.map((worker) => {
        const report = getWorkerReport(worker.metadata);
        const diffEvent = events.find(
          (event) =>
            event.eventType === "mission_worker_diff_captured" &&
            getMissionEventMetadataNumber(event.metadata, "workerId") ===
              worker.id,
        );
        return {
          worker,
          report,
          diffEvent,
          integrationStatus: getWorkerIntegrationStatus(worker.metadata),
          outputAppliedAt: getMissionEventMetadataString(
            worker.metadata,
            "outputAppliedAt",
          ),
          changedFiles:
            report?.changedFiles.length && report.changedFiles.length > 0
              ? report.changedFiles
              : getMissionEventMetadataStringArray(
                  diffEvent?.metadata,
                  "changedFiles",
                ),
          workerEvents: events.filter(
            (event) =>
              getMissionEventMetadataNumber(event.metadata, "workerId") ===
              worker.id,
          ),
        };
      }),
    [events, workers],
  );
  const acceptedUnappliedWorkers = useMemo(
    () =>
      workers.filter(
        (worker) =>
          getWorkerIntegrationStatus(worker.metadata) === "applied" &&
          !getMissionEventMetadataString(worker.metadata, "outputAppliedAt"),
      ),
    [workers],
  );
  const cleanupReadyWorkers = useMemo(
    () =>
      workers.filter(
        (worker) =>
          worker.workspaceProvider === "worktree" &&
          worker.workspaceRef &&
          getMissionEventMetadataString(worker.metadata, "outputAppliedAt") &&
          !getMissionEventMetadataString(worker.metadata, "workspaceCleanedAt"),
      ),
    [workers],
  );
  const latestRuntimeEvent = events.find(
    (event) =>
      getMissionEventMetadataString(event.metadata, "gate") === "runtime",
  );
  const previewUrl = getMissionEventMetadataString(
    latestRuntimeEvent?.metadata,
    "url",
  );
  const postCreateGateEvent = events.find(
    (event) => event.eventType === "post_create_verification_required",
  );
  const postCreateRequiredChecks = getMissionEventMetadataStringArray(
    postCreateGateEvent?.metadata,
    "requiredChecks",
  );
  const postCreateCompletedChecks = useMemo(() => {
    if (postCreateRequiredChecks.length === 0) {
      return 0;
    }
    const passed = new Set<string>();
    for (const event of events) {
      if (
        getMissionEventMetadataString(event.metadata, "status") !== "passed"
      ) {
        continue;
      }
      const check = getMissionEventMetadataString(event.metadata, "check");
      const gate = getMissionEventMetadataString(event.metadata, "gate");
      if (check) passed.add(check);
      if (gate) passed.add(gate);
    }
    return postCreateRequiredChecks.filter((check) => passed.has(check)).length;
  }, [events, postCreateRequiredChecks]);

  useEffect(() => {
    if (
      !chatId ||
      activeMissionId !== null ||
      latestMissionForChat?.status !== "running"
    ) {
      return;
    }
    setActiveMissionByChatId((prev) => {
      const next = new Map(prev);
      next.set(chatId, latestMissionForChat.id);
      return next;
    });
  }, [activeMissionId, chatId, latestMissionForChat, setActiveMissionByChatId]);

  const setActiveMission = (missionId: number) => {
    if (!chatId) return;
    setActiveMissionByChatId((prev) => {
      const next = new Map(prev);
      next.set(chatId, missionId);
      return next;
    });
  };

  const handleStartMission = async () => {
    if (!appId || !chatId) return;
    const created = await createMission({
      appId,
      chatId,
      title: goal.length > 64 ? `${goal.slice(0, 61)}...` : goal,
      goal,
      autonomyProfile:
        settings?.defaultMissionAutonomyProfile ?? "full-autopilot-sandbox",
    });
    setActiveMission(created.id);
    await updateMissionStatus({ missionId: created.id, status: "running" });
  };

  const handleResumeMission = async () => {
    if (!visibleMission) return;
    setActiveMission(visibleMission.id);
    await updateMissionStatus({
      missionId: visibleMission.id,
      status: "running",
    });
    if (!chatId) return;
    setQueuePausedById((prev) => {
      const next = new Map(prev);
      next.set(chatId, false);
      return next;
    });
    setStreamCompletedSuccessfullyById((prev) => {
      const next = new Map(prev);
      next.set(chatId, true);
      return next;
    });
  };

  const handlePauseMission = async () => {
    if (!visibleMission) return;
    await updateMissionStatus({
      missionId: visibleMission.id,
      status: "paused",
    });
    if (!chatId) return;
    setActiveMissionByChatId((prev) => {
      const next = new Map(prev);
      next.delete(chatId);
      return next;
    });
    setQueuePausedById((prev) => {
      const next = new Map(prev);
      next.set(chatId, true);
      return next;
    });
  };

  const handleSeedWorkers = async () => {
    if (!visibleMission || workers.length > 0) return;

    for (const seed of buildWorkerSeedFromTasks(tasks)) {
      await createMissionWorker({
        missionId: visibleMission.id,
        workerKey: seed.workerKey,
        role: seed.role,
        title: seed.title,
        goal: seed.goal,
        workspaceProvider:
          seed.role === "builder" || seed.role === "qa" ? "worktree" : "local",
        fileScopes: seed.fileScopes,
        dependsOn: seed.dependsOn,
        metadata: {
          source: "mission_control_seed",
        },
      });
    }
  };

  const handleDispatchWorkers = async () => {
    if (!visibleMission) return;
    if (readyDispatchableWorkers.length > 0) {
      await runReadyMissionWorkers({
        missionId: visibleMission.id,
        limit: Math.min(readyDispatchableWorkers.length, 5),
        parallel: true,
      });
      return;
    }
    await dispatchMissionWorkers({
      missionId: visibleMission.id,
      status: "ready",
    });
  };

  const handlePrepareWorkerWorkspaces = async () => {
    for (const worker of unpreparedWorkers) {
      await prepareMissionWorkerWorkspace({ workerId: worker.id });
    }
  };

  const handleMarkStaleWorkers = async () => {
    if (!visibleMission) return;
    await markStaleMissionWorkers({ missionId: visibleMission.id });
  };

  const handleRetryWorkers = async () => {
    if (!visibleMission) return;
    await markStaleMissionWorkers({ missionId: visibleMission.id });
    const targets = retryableWorkers;
    for (const worker of targets) {
      await retryMissionWorker({
        workerId: worker.id,
        reason: workerHasStaleMetadata(worker)
          ? "Retry requested from Mission Control for stale worker."
          : "Retry requested from Mission Control.",
      });
    }
  };

  const handleSetWorkerIntegrationStatus = async (
    workerId: number,
    status: "applied" | "rejected",
  ) => {
    await setMissionWorkerIntegrationStatus({
      workerId,
      status,
      reason:
        status === "applied"
          ? "Accepted from Mission Control."
          : "Rejected from Mission Control.",
    });
  };

  const handleApplyAcceptedWorkerOutputs = async () => {
    if (!visibleMission) return;
    await applyAcceptedMissionWorkerOutputs({ missionId: visibleMission.id });
  };

  const handleCleanupAppliedWorkerWorkspaces = async () => {
    if (!visibleMission) return;
    await cleanupAppliedMissionWorkerWorkspaces({
      missionId: visibleMission.id,
    });
  };

  const handleResolvePermissionRequest = async (
    requestId: number,
    status: "approved" | "denied",
  ) => {
    await resolveMissionPermissionRequest({ requestId, status });
  };

  const handleCompleteMission = async () => {
    if (!visibleMission) return;
    const shouldWaivePostCreateGate =
      postCreateRequiredChecks.length > 0 &&
      postCreateCompletedChecks < postCreateRequiredChecks.length &&
      window.confirm(
        `Post-create verification is incomplete (${postCreateCompletedChecks}/${postCreateRequiredChecks.length}). Complete this mission anyway?`,
      );
    if (
      postCreateRequiredChecks.length > 0 &&
      postCreateCompletedChecks < postCreateRequiredChecks.length &&
      !shouldWaivePostCreateGate
    ) {
      return;
    }
    await updateMissionStatus({
      missionId: visibleMission.id,
      status: "completed",
      waiveIncompleteGates: shouldWaivePostCreateGate,
      waiverReason: shouldWaivePostCreateGate
        ? "User completed mission from MissionControl before all post-create gates passed."
        : undefined,
    });
    if (!chatId) return;
    setActiveMissionByChatId((prev) => {
      const next = new Map(prev);
      next.delete(chatId);
      return next;
    });
    setQueuePausedById((prev) => {
      const next = new Map(prev);
      next.set(chatId, false);
      return next;
    });
  };

  if (!chatId || !appId) {
    return null;
  }

  if (!visibleMission) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-muted/30 px-3 py-2 shadow-[0_4px_16px_-8px_rgba(0,0,0,0.4)]">
        <div className="flex min-w-0 items-center gap-2 text-sm">
          <Target className="size-4 text-muted-foreground" />
          <span className="truncate text-muted-foreground">
            Mission mode is idle
          </span>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={handleStartMission}
          className="h-8 gap-1.5"
        >
          <Play className="size-3.5" />
          Start mission
        </Button>
      </div>
    );
  }

  const isActive =
    activeMissionId === visibleMission.id &&
    visibleMission.status === "running";
  const isAutoAdvanceMission =
    visibleMission.autonomyProfile === "trusted-workspace" ||
    visibleMission.autonomyProfile === "full-autopilot-sandbox";

  return (
    <div
      className={cn(
        "rounded-xl border border-border/60 px-3 py-2 shadow-[0_4px_16px_-8px_rgba(0,0,0,0.4)]",
        isActive ? "bg-primary/10" : "bg-muted/30",
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Bot className="size-4 text-primary" />
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-medium">
                {visibleMission.title}
              </span>
              <Badge variant="outline" className="shrink-0 capitalize">
                {visibleMission.status.replace(/-/g, " ")}
              </Badge>
              <Badge
                variant="secondary"
                className="hidden max-w-[10rem] shrink-0 truncate sm:inline-flex"
                title={visibleMission.autonomyProfile.replace(/-/g, " ")}
              >
                {getAutonomyProfileLabel(visibleMission.autonomyProfile)}
              </Badge>
              {isAutoAdvanceMission && (
                <Badge variant="secondary" className="shrink-0">
                  Auto
                </Badge>
              )}
              {latestRun && (
                <Badge variant="secondary" className="shrink-0 capitalize">
                  run {latestRun.status}
                </Badge>
              )}
            </div>
            {(latestCheckpoint || latestEvent) && (
              <div className="truncate text-xs text-muted-foreground">
                {tasks.length > 0
                  ? `${completedTaskCount}/${tasks.length} tasks complete`
                  : (latestCheckpoint?.summary ?? latestEvent?.summary)}
              </div>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-8"
            onClick={() => setShowTimeline((value) => !value)}
            title="Toggle mission timeline"
          >
            {showTimeline ? (
              <ChevronUp className="size-4" />
            ) : (
              <ChevronDown className="size-4" />
            )}
          </Button>
          {workers.length === 0 && tasks.length > 0 && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-8"
              onClick={handleSeedWorkers}
              title="Seed parallel workers"
            >
              <UsersRound className="size-4" />
            </Button>
          )}
          {workerReviewItems.length > 0 && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-8"
              onClick={() => setShowWorkerReview((value) => !value)}
              title="Toggle worker review"
            >
              <FileText className="size-4" />
            </Button>
          )}
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className={cn(
              "size-8",
              showToolCapabilities && "bg-muted text-foreground",
            )}
            onClick={() => setShowToolCapabilities((value) => !value)}
            title="Show tool capabilities"
          >
            <ShieldQuestion className="size-4" />
          </Button>
          {!isAutoAdvanceMission && dispatchableWorkers.length > 0 && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-8"
              onClick={handleDispatchWorkers}
              title={
                queuedDispatchableWorkers.length > 0
                  ? `Prepare ${queuedDispatchableWorkers.length} worker${
                      queuedDispatchableWorkers.length === 1 ? "" : "s"
                    }`
                  : `Start ${readyDispatchableWorkers.length} worker${
                      readyDispatchableWorkers.length === 1 ? "" : "s"
                    }`
              }
            >
              <Send className="size-4" />
            </Button>
          )}
          {!isAutoAdvanceMission && unpreparedWorkers.length > 0 && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-8"
              onClick={handlePrepareWorkerWorkspaces}
              title={`Prepare ${unpreparedWorkers.length} isolated workspace${
                unpreparedWorkers.length === 1 ? "" : "s"
              }`}
            >
              <GitBranch className="size-4" />
            </Button>
          )}
          {runningWorkers.length > 0 && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-8"
              onClick={handleMarkStaleWorkers}
              title="Check running workers for stale status"
            >
              <Clock3 className="size-4" />
            </Button>
          )}
          {retryableWorkers.length > 0 && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-8"
              onClick={handleRetryWorkers}
              title={`Retry ${retryableWorkers.length} failed or stale worker${
                retryableWorkers.length === 1 ? "" : "s"
              }`}
            >
              <RotateCcw className="size-4" />
            </Button>
          )}
          {acceptedUnappliedWorkers.length > 0 && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-8"
              onClick={handleApplyAcceptedWorkerOutputs}
              title={`Apply ${acceptedUnappliedWorkers.length} accepted worker output${
                acceptedUnappliedWorkers.length === 1 ? "" : "s"
              }`}
            >
              <PackageCheck className="size-4" />
            </Button>
          )}
          {cleanupReadyWorkers.length > 0 && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-8"
              onClick={handleCleanupAppliedWorkerWorkspaces}
              title={`Clean up ${cleanupReadyWorkers.length} applied worker workspace${
                cleanupReadyWorkers.length === 1 ? "" : "s"
              }`}
            >
              <Trash2 className="size-4" />
            </Button>
          )}
          {visibleMission.status === "running" ? (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-8"
              onClick={handlePauseMission}
              title="Pause mission"
            >
              <CirclePause className="size-4" />
            </Button>
          ) : (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-8"
              onClick={handleResumeMission}
              title="Resume mission"
            >
              <Play className="size-4" />
            </Button>
          )}
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-8"
            onClick={handleCompleteMission}
            title="Complete mission"
          >
            {visibleMission.status === "failed" ? (
              <XCircle className="size-4" />
            ) : (
              <CheckCircle2 className="size-4" />
            )}
          </Button>
        </div>
      </div>
      <div className="mt-2 grid grid-cols-5 gap-1.5">
        {verificationChecks.map((check) => (
          <div
            key={check.key}
            className={cn(
              "flex min-w-0 items-center justify-center gap-1 rounded-md border px-1.5 py-1 text-xs",
              check.status === "passed" &&
                "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
              check.status === "failed" &&
                "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
              !check.status && "text-muted-foreground",
            )}
            title={check.event?.summary ?? `${check.label} not verified yet`}
          >
            {check.status === "passed" ? (
              <CheckCircle2 className="size-3.5 shrink-0" />
            ) : check.status === "failed" ? (
              <XCircle className="size-3.5 shrink-0" />
            ) : check.key === "install" ? (
              <PackageCheck className="size-3.5 shrink-0" />
            ) : (
              <Clock3 className="size-3.5 shrink-0" />
            )}
            <span className="truncate">{check.label}</span>
          </div>
        ))}
      </div>
      <div className="mt-1.5 grid grid-cols-4 gap-1.5">
        {visualChecks.map((check) => {
          const Icon = check.icon;
          return (
            <div
              key={check.key}
              className={cn(
                "flex min-w-0 items-center justify-center gap-1 rounded-md border px-1.5 py-1 text-xs",
                check.status === "passed" &&
                  "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                check.status === "failed" &&
                  "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
                !check.status && "text-muted-foreground",
              )}
              title={check.event?.summary ?? `${check.label} not checked yet`}
            >
              <Icon className="size-3.5 shrink-0" />
              <span className="truncate">{check.label}</span>
            </div>
          );
        })}
      </div>
      {(artifacts.length > 0 || screenshotArtifacts.length > 0) && (
        <div className="mt-1.5 space-y-1 text-xs text-muted-foreground">
          <div className="flex min-w-0 items-center gap-2">
            <ImageIcon className="size-3.5 shrink-0" />
            <span className="truncate">
              {artifacts.length} artifact{artifacts.length === 1 ? "" : "s"}
              {screenshotArtifacts.length > 0
                ? ` - ${screenshotArtifacts.length} screenshot${
                    screenshotArtifacts.length === 1 ? "" : "s"
                  }`
                : ""}
              {mediaArtifacts.length > 0
                ? ` - ${mediaArtifacts.length} media`
                : ""}
              {deploymentArtifacts.length > 0
                ? ` - ${deploymentArtifacts.length} deployment${
                    deploymentArtifacts.length === 1 ? "" : "s"
                  }`
                : ""}
            </span>
          </div>
          {latestArtifacts.length > 0 && (
            <div className="grid gap-1 sm:grid-cols-3">
              {latestArtifacts.map((artifact) => {
                const Icon = getArtifactIcon(artifact.artifactType);
                const provider = getMissionEventMetadataString(
                  artifact.metadata,
                  "provider",
                );
                const status = getMissionEventMetadataString(
                  artifact.metadata,
                  "status",
                );
                const state = getMissionEventMetadataString(
                  artifact.metadata,
                  "state",
                );
                return (
                  <div
                    key={artifact.id}
                    className="flex min-w-0 items-start gap-1.5 rounded border bg-background/60 px-2 py-1"
                    title={artifact.body ?? artifact.uri ?? artifact.title}
                  >
                    <Icon className="mt-0.5 size-3.5 shrink-0" />
                    <div className="min-w-0">
                      <div className="truncate text-foreground">
                        {artifact.title}
                      </div>
                      <div className="truncate">
                        {[provider, status, state, artifact.uri]
                          .filter(Boolean)
                          .join(" - ")}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
      {previewUrl && (
        <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <Play className="size-3.5 shrink-0" />
          <span className="truncate">{previewUrl}</span>
        </div>
      )}
      {deploymentArtifacts[0] && (
        <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <Rocket className="size-3.5 shrink-0" />
          <span className="truncate">
            Latest deployment:{" "}
            {[
              getMissionEventMetadataString(
                deploymentArtifacts[0].metadata,
                "provider",
              ),
              getMissionEventMetadataString(
                deploymentArtifacts[0].metadata,
                "status",
              ),
              getMissionEventMetadataString(
                deploymentArtifacts[0].metadata,
                "state",
              ),
              deploymentArtifacts[0].uri,
            ]
              .filter(Boolean)
              .join(" - ")}
          </span>
        </div>
      )}
      {interrupts.length > 0 && (
        <div
          className={cn(
            "mt-1 flex min-w-0 items-center gap-2 text-xs",
            pendingInterrupts.length > 0
              ? "text-amber-700 dark:text-amber-300"
              : "text-muted-foreground",
          )}
        >
          <BellRing className="size-3.5 shrink-0" />
          <span className="truncate">
            {pendingInterrupts.length > 0
              ? `${pendingInterrupts.length} pending interrupt${
                  pendingInterrupts.length === 1 ? "" : "s"
                }`
              : `${interrupts.length} interrupt${
                  interrupts.length === 1 ? "" : "s"
                } handled`}
            {latestInterrupt ? `: ${latestInterrupt.title}` : ""}
          </span>
        </div>
      )}
      {pendingPermissionRequests.length > 0 && (
        <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-amber-700 dark:text-amber-300">
          <ShieldAlert className="size-3.5 shrink-0" />
          <span className="truncate">
            {pendingPermissionRequests.length} permission request
            {pendingPermissionRequests.length === 1 ? "" : "s"} awaiting
            approval: {pendingPermissionRequests[0].action}
          </span>
        </div>
      )}
      {memories.length > 0 && (
        <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <ShieldCheck className="size-3.5 shrink-0" />
          <span className="truncate">
            {memories.length} memory record{memories.length === 1 ? "" : "s"}:
            {` ${memories[0].title}`}
          </span>
        </div>
      )}
      {workers.length > 0 && (
        <div className="mt-1.5 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <UsersRound className="size-3.5 shrink-0" />
          <span className="truncate">
            {workers.length} worker{workers.length === 1 ? "" : "s"}:{" "}
            {workers
              .slice(0, 4)
              .map((worker) => `${worker.workerKey} ${worker.status}`)
              .join(", ")}
            {workers.length > 4 ? ", ..." : ""}
          </span>
        </div>
      )}
      {unpreparedWorkers.length > 0 && (
        <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <GitBranch className="size-3.5 shrink-0" />
          <span className="truncate">
            {unpreparedWorkers.length} isolated workspace
            {unpreparedWorkers.length === 1 ? "" : "s"} need preparation
          </span>
        </div>
      )}
      {dispatchableWorkers.length > 0 && (
        <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <Send className="size-3.5 shrink-0" />
          <span className="truncate">
            {dispatchableWorkers.length} worker
            {dispatchableWorkers.length === 1 ? "" : "s"} ready to dispatch:{" "}
            {dispatchableWorkers.map((worker) => worker.workerKey).join(", ")}
          </span>
        </div>
      )}
      {retryableWorkers.length > 0 && (
        <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-amber-700 dark:text-amber-300">
          <RotateCcw className="size-3.5 shrink-0" />
          <span className="truncate">
            {retryableWorkers.length} failed/stale worker
            {retryableWorkers.length === 1 ? "" : "s"} can be retried
          </span>
        </div>
      )}
      {workerReports.length > 0 && (
        <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <CheckCircle2 className="size-3.5 shrink-0" />
          <span className="truncate">
            Latest worker report: {workerReports[0].worker.workerKey} -{" "}
            {workerReports[0].report?.summary}
          </span>
        </div>
      )}
      {workerIntegrationPlan.pendingWorkerKeys.length > 0 && (
        <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <PackageCheck className="size-3.5 shrink-0" />
          <span className="truncate">
            {workerIntegrationPlan.pendingWorkerKeys.length} worker report
            {workerIntegrationPlan.pendingWorkerKeys.length === 1
              ? ""
              : "s"}{" "}
            pending integration review
          </span>
        </div>
      )}
      {acceptedUnappliedWorkers.length > 0 && (
        <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <PackageCheck className="size-3.5 shrink-0" />
          <span className="truncate">
            {acceptedUnappliedWorkers.length} accepted worker output
            {acceptedUnappliedWorkers.length === 1 ? "" : "s"} ready to apply
          </span>
        </div>
      )}
      {cleanupReadyWorkers.length > 0 && (
        <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <Trash2 className="size-3.5 shrink-0" />
          <span className="truncate">
            {cleanupReadyWorkers.length} applied worker workspace
            {cleanupReadyWorkers.length === 1 ? "" : "s"} ready for cleanup
          </span>
        </div>
      )}
      {workerIntegrationPlan.conflicts.length > 0 && (
        <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-amber-700 dark:text-amber-300">
          <XCircle className="size-3.5 shrink-0" />
          <span className="truncate">
            Worker output conflict:{" "}
            {workerIntegrationPlan.conflicts[0].firstWorkerKey} /{" "}
            {workerIntegrationPlan.conflicts[0].secondWorkerKey}
          </span>
        </div>
      )}
      {workerConflicts.length > 0 && (
        <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-amber-700 dark:text-amber-300">
          <XCircle className="size-3.5 shrink-0" />
          <span className="truncate">
            Worker scope conflict: {workerConflicts[0].firstWorkerKey} /{" "}
            {workerConflicts[0].secondWorkerKey}
          </span>
        </div>
      )}
      {latestCheckpoint && (
        <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <PackageCheck className="size-3.5 shrink-0" />
          <span className="truncate">
            Rollback checkpoint available: {latestCheckpoint.summary}
          </span>
        </div>
      )}
      {postCreateRequiredChecks.length > 0 && (
        <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <Target className="size-3.5 shrink-0" />
          <span className="truncate">
            Post-create gate {postCreateCompletedChecks}/
            {postCreateRequiredChecks.length}:{" "}
            {postCreateRequiredChecks.join(", ")}
          </span>
        </div>
      )}
      {showWorkerReview && workerReviewItems.length > 0 && (
        <MissionWorkerDashboard
          items={workerReviewItems}
          acceptedUnappliedCount={acceptedUnappliedWorkers.length}
          onApplyAccepted={handleApplyAcceptedWorkerOutputs}
          onSetIntegrationStatus={handleSetWorkerIntegrationStatus}
        />
      )}
      {showToolCapabilities && <ToolCapabilitiesPanel />}
      {showTimeline && (
        <div className="mt-2 max-h-48 overflow-y-auto border-t pt-2">
          {tasks.length > 0 && (
            <div className="mb-2 space-y-1.5">
              {tasks.map((task) => (
                <div
                  key={task.id}
                  className="flex items-start gap-2 text-xs text-muted-foreground"
                >
                  {task.status === "completed" ? (
                    <CheckCircle2 className="mt-0.5 size-3 shrink-0 text-emerald-600 dark:text-emerald-300" />
                  ) : task.status === "in_progress" ? (
                    <Clock3 className="mt-0.5 size-3 shrink-0 text-primary" />
                  ) : (
                    <Clock3 className="mt-0.5 size-3 shrink-0" />
                  )}
                  <span
                    className={cn(
                      "min-w-0 truncate",
                      task.status === "completed" && "line-through",
                    )}
                  >
                    {task.title}
                  </span>
                </div>
              ))}
            </div>
          )}
          {workers.length > 0 && (
            <div className="mb-2 space-y-1.5">
              {workers.map((worker) => (
                <div
                  key={worker.id}
                  className="flex items-start gap-2 text-xs text-muted-foreground"
                >
                  <UsersRound className="mt-0.5 size-3 shrink-0 text-primary" />
                  <div className="min-w-0">
                    <div className="truncate">
                      {worker.workerKey} - {worker.role} - {worker.status}
                      {workerHasStaleMetadata(worker) ? " - stale" : ""}
                    </div>
                    {(worker.workspaceRef || worker.branchName) && (
                      <div className="truncate">
                        {worker.branchName ?? worker.workspaceProvider}
                        {worker.workspaceRef ? ` - ${worker.workspaceRef}` : ""}
                      </div>
                    )}
                    {getWorkerReport(worker.metadata) && (
                      <div className="space-y-1">
                        <div className="truncate">
                          {getWorkerReport(worker.metadata)?.summary}
                        </div>
                        <div className="flex min-w-0 items-center gap-1">
                          <Badge
                            variant={
                              getWorkerIntegrationStatus(worker.metadata) ===
                              "rejected"
                                ? "destructive"
                                : "secondary"
                            }
                            className="h-5 px-1.5 text-[10px] capitalize"
                          >
                            {getWorkerIntegrationStatus(worker.metadata)}
                          </Badge>
                          {getMissionEventMetadataString(
                            worker.metadata,
                            "outputAppliedAt",
                          ) && (
                            <Badge
                              variant="outline"
                              className="h-5 px-1.5 text-[10px]"
                            >
                              output applied
                            </Badge>
                          )}
                          {getMissionEventMetadataString(
                            worker.metadata,
                            "workspaceCleanedAt",
                          ) && (
                            <Badge
                              variant="outline"
                              className="h-5 px-1.5 text-[10px]"
                            >
                              workspace cleaned
                            </Badge>
                          )}
                          {getWorkerIntegrationStatus(worker.metadata) ===
                            "pending" && (
                            <>
                              <Button
                                type="button"
                                size="icon"
                                variant="ghost"
                                className="size-5"
                                title="Accept worker output"
                                onClick={() =>
                                  handleSetWorkerIntegrationStatus(
                                    worker.id,
                                    "applied",
                                  )
                                }
                              >
                                <CheckCircle2 className="size-3" />
                              </Button>
                              <Button
                                type="button"
                                size="icon"
                                variant="ghost"
                                className="size-5"
                                title="Reject worker output"
                                onClick={() =>
                                  handleSetWorkerIntegrationStatus(
                                    worker.id,
                                    "rejected",
                                  )
                                }
                              >
                                <XCircle className="size-3" />
                              </Button>
                            </>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          {interrupts.length > 0 && (
            <div className="mb-2 space-y-1.5">
              {interrupts.slice(0, 4).map((interrupt) => (
                <div
                  key={interrupt.id}
                  className="flex items-start gap-2 text-xs text-muted-foreground"
                >
                  <BellRing className="mt-0.5 size-3 shrink-0 text-amber-600 dark:text-amber-300" />
                  <div className="min-w-0">
                    <div className="truncate text-foreground">
                      {interrupt.title}
                    </div>
                    <div className="truncate">
                      {interrupt.source} - {interrupt.status} - {interrupt.body}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
          {permissionRequests.length > 0 && (
            <div className="mb-2 space-y-1.5">
              {permissionRequests.slice(0, 4).map((request) => (
                <div
                  key={request.id}
                  className="flex items-start gap-2 text-xs text-muted-foreground"
                >
                  <ShieldAlert className="mt-0.5 size-3 shrink-0 text-amber-600 dark:text-amber-300" />
                  <div className="min-w-0">
                    <div className="truncate text-foreground">
                      {request.action}
                    </div>
                    <div className="flex min-w-0 items-center gap-1">
                      <Badge
                        variant={
                          request.status === "denied"
                            ? "destructive"
                            : "secondary"
                        }
                        className="h-5 px-1.5 text-[10px] capitalize"
                      >
                        {request.status}
                      </Badge>
                      <Badge
                        variant="outline"
                        className="h-5 px-1.5 text-[10px] capitalize"
                      >
                        {request.risk}
                      </Badge>
                      {request.status === "pending" && (
                        <>
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            className="size-5"
                            title="Approve permission"
                            onClick={() =>
                              handleResolvePermissionRequest(
                                request.id,
                                "approved",
                              )
                            }
                          >
                            <CheckCircle2 className="size-3" />
                          </Button>
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            className="size-5"
                            title="Deny permission"
                            onClick={() =>
                              handleResolvePermissionRequest(
                                request.id,
                                "denied",
                              )
                            }
                          >
                            <XCircle className="size-3" />
                          </Button>
                        </>
                      )}
                    </div>
                    <div className="truncate">{request.reason}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
          {memories.length > 0 && (
            <div className="mb-2 space-y-1.5">
              {memories.slice(0, 4).map((memory) => (
                <div
                  key={memory.id}
                  className="flex items-start gap-2 text-xs text-muted-foreground"
                >
                  <ShieldCheck className="mt-0.5 size-3 shrink-0" />
                  <div className="min-w-0">
                    <div className="truncate text-foreground">
                      {memory.title}
                    </div>
                    <div className="truncate">
                      {memory.category.replace(/_/g, " ")} - {memory.body}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
          {events.length > 0 ? (
            <div className="space-y-1.5">
              {events.slice(0, 6).map((event) => {
                const policyDecision = getMissionEventMetadataString(
                  event.metadata,
                  "decision",
                );
                const policyRisk = getMissionEventMetadataString(
                  event.metadata,
                  "risk",
                );
                const policyReason = getMissionEventMetadataString(
                  event.metadata,
                  "reason",
                );
                const isPolicyEvent =
                  event.eventType === "agent_tool_policy_decision";

                return (
                  <div
                    key={event.id}
                    className="flex items-start gap-2 text-xs text-muted-foreground"
                  >
                    <Clock3 className="mt-0.5 size-3 shrink-0" />
                    <div className="min-w-0">
                      <div className="truncate text-foreground">
                        {event.summary}
                      </div>
                      {isPolicyEvent && (
                        <div className="mt-1 flex flex-wrap gap-1">
                          {policyDecision && (
                            <Badge
                              variant={
                                policyDecision === "deny"
                                  ? "destructive"
                                  : "secondary"
                              }
                              className="px-1.5 py-0 text-[10px] capitalize"
                            >
                              {policyDecision.replace(/_/g, " ")}
                            </Badge>
                          )}
                          {policyRisk && (
                            <Badge
                              variant="outline"
                              className="px-1.5 py-0 text-[10px] capitalize"
                            >
                              {policyRisk} risk
                            </Badge>
                          )}
                        </div>
                      )}
                      <div className="truncate">
                        {policyReason ??
                          new Date(event.createdAt).toLocaleString()}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-xs text-muted-foreground">
              No mission events recorded yet.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function getMissionEventMetadataString(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
) {
  const value = metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function getMissionEventMetadataNumber(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
) {
  const value = metadata?.[key];
  return typeof value === "number" ? value : undefined;
}

function getMissionEventMetadataStringArray(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
) {
  const value = metadata?.[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function getAutonomyProfileLabel(profile: string) {
  switch (profile) {
    case "supervised":
      return "Supervised";
    case "trusted-workspace":
      return "Trusted workspace";
    case "full-autopilot-sandbox":
      return "Autopilot sandbox";
    default:
      return profile;
  }
}

function getArtifactIcon(artifactType: string) {
  switch (artifactType) {
    case "deployment":
      return Rocket;
    case "audio":
      return Music;
    case "video":
      return Video;
    case "runtime":
      return Play;
    case "accessibility_tree":
      return Eye;
    case "console_output":
      return Terminal;
    default:
      return ImageIcon;
  }
}
