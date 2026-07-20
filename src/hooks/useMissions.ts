import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc } from "@/ipc/types";
import { queryKeys } from "@/lib/queryKeys";
import type {
  CreateMissionParams,
  AddMissionEventParams,
  UpdateMissionStatusParams,
  CreateMissionWorkerParams,
  UpdateMissionWorkerStatusParams,
  DispatchMissionWorkersParams,
  RetryMissionWorkerParams,
  MarkStaleMissionWorkersParams,
  SubmitMissionWorkerReportParams,
  PrepareMissionWorkerWorkspaceParams,
  SetMissionWorkerIntegrationStatusParams,
  RunReadyMissionWorkersParams,
  ApplyAcceptedMissionWorkerOutputsParams,
  CleanupAppliedMissionWorkerWorkspacesParams,
  CreateMissionInterruptParams,
  MarkMissionInterruptsInjectedParams,
  CreateMissionMemoryParams,
  ListMissionMemoriesParams,
  CreateMissionPermissionRequestParams,
  ResolveMissionPermissionRequestParams,
  ExpireMissionPermissionRequestsParams,
} from "@/ipc/types";

export function useMissions(appId: number | null, missionId?: number | null) {
  const queryClient = useQueryClient();

  const missionsQuery = useQuery({
    queryKey: queryKeys.missions.list({ appId }),
    queryFn: () => ipc.mission.listMissionsForApp({ appId: appId! }),
    enabled: appId !== null,
  });

  const missionQuery = useQuery({
    queryKey: queryKeys.missions.detail({ missionId: missionId ?? null }),
    queryFn: () => ipc.mission.getMission({ missionId: missionId! }),
    enabled: missionId !== undefined && missionId !== null,
    refetchInterval: (query) =>
      query.state.data?.status === "running" ? 1500 : false,
  });

  const liveMissionRefreshInterval =
    missionQuery.data?.status === "running" ? 1500 : false;

  const eventsQuery = useQuery({
    queryKey: queryKeys.missions.events({ missionId: missionId ?? null }),
    queryFn: () => ipc.mission.listMissionEvents({ missionId: missionId! }),
    enabled: missionId !== undefined && missionId !== null,
    refetchInterval: liveMissionRefreshInterval,
  });

  const tasksQuery = useQuery({
    queryKey: queryKeys.missions.tasks({ missionId: missionId ?? null }),
    queryFn: () => ipc.mission.listMissionTasks({ missionId: missionId! }),
    enabled: missionId !== undefined && missionId !== null,
    refetchInterval: liveMissionRefreshInterval,
  });

  const runsQuery = useQuery({
    queryKey: queryKeys.missions.runs({ missionId: missionId ?? null }),
    queryFn: () => ipc.mission.listMissionRuns({ missionId: missionId! }),
    enabled: missionId !== undefined && missionId !== null,
    refetchInterval: liveMissionRefreshInterval,
  });

  const workersQuery = useQuery({
    queryKey: queryKeys.missions.workers({ missionId: missionId ?? null }),
    queryFn: () => ipc.mission.listMissionWorkers({ missionId: missionId! }),
    enabled: missionId !== undefined && missionId !== null,
    refetchInterval: liveMissionRefreshInterval,
  });

  const checkpointsQuery = useQuery({
    queryKey: queryKeys.missions.checkpoints({ missionId: missionId ?? null }),
    queryFn: () =>
      ipc.mission.listMissionCheckpoints({ missionId: missionId! }),
    enabled: missionId !== undefined && missionId !== null,
    refetchInterval: liveMissionRefreshInterval,
  });

  const artifactsQuery = useQuery({
    queryKey: queryKeys.missions.artifacts({ missionId: missionId ?? null }),
    queryFn: () => ipc.mission.listMissionArtifacts({ missionId: missionId! }),
    enabled: missionId !== undefined && missionId !== null,
    refetchInterval: liveMissionRefreshInterval,
  });

  const interruptsQuery = useQuery({
    queryKey: queryKeys.missions.interrupts({ missionId: missionId ?? null }),
    queryFn: () => ipc.mission.listMissionInterrupts({ missionId: missionId! }),
    enabled: missionId !== undefined && missionId !== null,
    refetchInterval: liveMissionRefreshInterval,
  });

  const memoriesQuery = useQuery({
    queryKey: queryKeys.missions.memories({
      appId,
      missionId: missionId ?? null,
    }),
    queryFn: () =>
      ipc.mission.listMissionMemories({
        appId: appId!,
        missionId: missionId ?? null,
      }),
    enabled: appId !== null,
  });

  const permissionRequestsQuery = useQuery({
    queryKey: queryKeys.missions.permissionRequests({
      missionId: missionId ?? null,
    }),
    queryFn: () =>
      ipc.mission.listMissionPermissionRequests({ missionId: missionId! }),
    enabled: missionId !== undefined && missionId !== null,
    refetchInterval: liveMissionRefreshInterval,
  });

  const invalidateMissionQueries = async (targetMissionId?: number | null) => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.missions.all });
    if (targetMissionId !== undefined && targetMissionId !== null) {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.missions.detail({ missionId: targetMissionId }),
      });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.missions.events({ missionId: targetMissionId }),
      });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.missions.tasks({ missionId: targetMissionId }),
      });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.missions.runs({ missionId: targetMissionId }),
      });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.missions.workers({ missionId: targetMissionId }),
      });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.missions.checkpoints({
          missionId: targetMissionId,
        }),
      });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.missions.artifacts({
          missionId: targetMissionId,
        }),
      });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.missions.interrupts({
          missionId: targetMissionId,
        }),
      });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.missions.memories({
          appId,
          missionId: targetMissionId,
        }),
      });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.missions.permissionRequests({
          missionId: targetMissionId,
        }),
      });
    }
  };

  const createMissionMutation = useMutation({
    mutationFn: (params: CreateMissionParams) =>
      ipc.mission.createMission(params),
    onSuccess: async (mission) => {
      await invalidateMissionQueries(mission.id);
    },
    meta: { showErrorToast: true },
  });

  const updateMissionStatusMutation = useMutation({
    mutationFn: (params: UpdateMissionStatusParams) =>
      ipc.mission.updateMissionStatus(params),
    onSuccess: async (mission) => {
      await invalidateMissionQueries(mission.id);
    },
    meta: { showErrorToast: true },
  });

  const addMissionEventMutation = useMutation({
    mutationFn: (params: AddMissionEventParams) =>
      ipc.mission.addMissionEvent(params),
    onSuccess: async (event) => {
      await invalidateMissionQueries(event.missionId);
    },
    meta: { showErrorToast: true },
  });

  const createMissionWorkerMutation = useMutation({
    mutationFn: (params: CreateMissionWorkerParams) =>
      ipc.mission.createMissionWorker(params),
    onSuccess: async (worker) => {
      await invalidateMissionQueries(worker.missionId);
    },
    meta: { showErrorToast: true },
  });

  const updateMissionWorkerStatusMutation = useMutation({
    mutationFn: (params: UpdateMissionWorkerStatusParams) =>
      ipc.mission.updateMissionWorkerStatus(params),
    onSuccess: async (worker) => {
      await invalidateMissionQueries(worker.missionId);
    },
    meta: { showErrorToast: true },
  });

  const dispatchMissionWorkersMutation = useMutation({
    mutationFn: (params: DispatchMissionWorkersParams) =>
      ipc.mission.dispatchMissionWorkers(params),
    onSuccess: async (workers) => {
      await invalidateMissionQueries(workers[0]?.missionId ?? missionId);
    },
    meta: { showErrorToast: true },
  });

  const retryMissionWorkerMutation = useMutation({
    mutationFn: (params: RetryMissionWorkerParams) =>
      ipc.mission.retryMissionWorker(params),
    onSuccess: async (worker) => {
      await invalidateMissionQueries(worker.missionId);
    },
    meta: { showErrorToast: true },
  });

  const markStaleMissionWorkersMutation = useMutation({
    mutationFn: (params: MarkStaleMissionWorkersParams) =>
      ipc.mission.markStaleMissionWorkers(params),
    onSuccess: async (workers) => {
      await invalidateMissionQueries(workers[0]?.missionId ?? missionId);
    },
    meta: { showErrorToast: true },
  });

  const submitMissionWorkerReportMutation = useMutation({
    mutationFn: (params: SubmitMissionWorkerReportParams) =>
      ipc.mission.submitMissionWorkerReport(params),
    onSuccess: async (worker) => {
      await invalidateMissionQueries(worker.missionId);
    },
    meta: { showErrorToast: true },
  });

  const prepareMissionWorkerWorkspaceMutation = useMutation({
    mutationFn: (params: PrepareMissionWorkerWorkspaceParams) =>
      ipc.mission.prepareMissionWorkerWorkspace(params),
    onSuccess: async (worker) => {
      await invalidateMissionQueries(worker.missionId);
    },
    meta: { showErrorToast: true },
  });

  const setMissionWorkerIntegrationStatusMutation = useMutation({
    mutationFn: (params: SetMissionWorkerIntegrationStatusParams) =>
      ipc.mission.setMissionWorkerIntegrationStatus(params),
    onSuccess: async (worker) => {
      await invalidateMissionQueries(worker.missionId);
    },
    meta: { showErrorToast: true },
  });

  const runReadyMissionWorkersMutation = useMutation({
    mutationFn: (params: RunReadyMissionWorkersParams) =>
      ipc.mission.runReadyMissionWorkers(params),
    onSuccess: async (workers) => {
      await invalidateMissionQueries(workers[0]?.missionId ?? missionId);
    },
    meta: { showErrorToast: true },
  });

  const applyAcceptedMissionWorkerOutputsMutation = useMutation({
    mutationFn: (params: ApplyAcceptedMissionWorkerOutputsParams) =>
      ipc.mission.applyAcceptedMissionWorkerOutputs(params),
    onSuccess: async (workers) => {
      await invalidateMissionQueries(workers[0]?.missionId ?? missionId);
    },
    meta: { showErrorToast: true },
  });

  const cleanupAppliedMissionWorkerWorkspacesMutation = useMutation({
    mutationFn: (params: CleanupAppliedMissionWorkerWorkspacesParams) =>
      ipc.mission.cleanupAppliedMissionWorkerWorkspaces(params),
    onSuccess: async (workers) => {
      await invalidateMissionQueries(workers[0]?.missionId ?? missionId);
    },
    meta: { showErrorToast: true },
  });

  const createMissionInterruptMutation = useMutation({
    mutationFn: (params: CreateMissionInterruptParams) =>
      ipc.mission.createMissionInterrupt(params),
    onSuccess: async (interrupt) => {
      await invalidateMissionQueries(interrupt.missionId);
    },
    meta: { showErrorToast: true },
  });

  const markMissionInterruptsInjectedMutation = useMutation({
    mutationFn: (params: MarkMissionInterruptsInjectedParams) =>
      ipc.mission.markMissionInterruptsInjected(params),
    onSuccess: async (interrupts) => {
      await invalidateMissionQueries(interrupts[0]?.missionId ?? missionId);
    },
    meta: { showErrorToast: true },
  });

  const createMissionMemoryMutation = useMutation({
    mutationFn: (params: CreateMissionMemoryParams) =>
      ipc.mission.createMissionMemory(params),
    onSuccess: async (memory) => {
      await invalidateMissionQueries(memory.missionId ?? missionId);
    },
    meta: { showErrorToast: true },
  });

  const listMissionMemories = (params: ListMissionMemoriesParams) =>
    ipc.mission.listMissionMemories(params);

  const createMissionPermissionRequestMutation = useMutation({
    mutationFn: (params: CreateMissionPermissionRequestParams) =>
      ipc.mission.createMissionPermissionRequest(params),
    onSuccess: async (request) => {
      await invalidateMissionQueries(request.missionId);
    },
    meta: { showErrorToast: true },
  });

  const resolveMissionPermissionRequestMutation = useMutation({
    mutationFn: (params: ResolveMissionPermissionRequestParams) =>
      ipc.mission.resolveMissionPermissionRequest(params),
    onSuccess: async (request) => {
      await invalidateMissionQueries(request.missionId);
    },
    meta: { showErrorToast: true },
  });

  const expireMissionPermissionRequestsMutation = useMutation({
    mutationFn: (params: ExpireMissionPermissionRequestsParams) =>
      ipc.mission.expireMissionPermissionRequests(params),
    onSuccess: async (requests) => {
      await invalidateMissionQueries(requests[0]?.missionId ?? missionId);
    },
    meta: { showErrorToast: true },
  });

  return {
    missions: missionsQuery.data ?? [],
    mission: missionQuery.data ?? null,
    events: eventsQuery.data ?? [],
    tasks: tasksQuery.data ?? [],
    runs: runsQuery.data ?? [],
    workers: workersQuery.data ?? [],
    checkpoints: checkpointsQuery.data ?? [],
    artifacts: artifactsQuery.data ?? [],
    interrupts: interruptsQuery.data ?? [],
    memories: memoriesQuery.data ?? [],
    permissionRequests: permissionRequestsQuery.data ?? [],
    isLoading:
      missionsQuery.isLoading ||
      missionQuery.isLoading ||
      eventsQuery.isLoading ||
      tasksQuery.isLoading ||
      runsQuery.isLoading ||
      workersQuery.isLoading ||
      checkpointsQuery.isLoading ||
      artifactsQuery.isLoading ||
      interruptsQuery.isLoading ||
      memoriesQuery.isLoading ||
      permissionRequestsQuery.isLoading,
    createMission: createMissionMutation.mutateAsync,
    updateMissionStatus: updateMissionStatusMutation.mutateAsync,
    addMissionEvent: addMissionEventMutation.mutateAsync,
    createMissionWorker: createMissionWorkerMutation.mutateAsync,
    updateMissionWorkerStatus: updateMissionWorkerStatusMutation.mutateAsync,
    dispatchMissionWorkers: dispatchMissionWorkersMutation.mutateAsync,
    retryMissionWorker: retryMissionWorkerMutation.mutateAsync,
    markStaleMissionWorkers: markStaleMissionWorkersMutation.mutateAsync,
    submitMissionWorkerReport: submitMissionWorkerReportMutation.mutateAsync,
    prepareMissionWorkerWorkspace:
      prepareMissionWorkerWorkspaceMutation.mutateAsync,
    setMissionWorkerIntegrationStatus:
      setMissionWorkerIntegrationStatusMutation.mutateAsync,
    runReadyMissionWorkers: runReadyMissionWorkersMutation.mutateAsync,
    applyAcceptedMissionWorkerOutputs:
      applyAcceptedMissionWorkerOutputsMutation.mutateAsync,
    cleanupAppliedMissionWorkerWorkspaces:
      cleanupAppliedMissionWorkerWorkspacesMutation.mutateAsync,
    createMissionInterrupt: createMissionInterruptMutation.mutateAsync,
    markMissionInterruptsInjected:
      markMissionInterruptsInjectedMutation.mutateAsync,
    createMissionMemory: createMissionMemoryMutation.mutateAsync,
    listMissionMemories,
    createMissionPermissionRequest:
      createMissionPermissionRequestMutation.mutateAsync,
    resolveMissionPermissionRequest:
      resolveMissionPermissionRequestMutation.mutateAsync,
    expireMissionPermissionRequests:
      expireMissionPermissionRequestsMutation.mutateAsync,
    refreshMissions: () => invalidateMissionQueries(missionId),
  };
}
