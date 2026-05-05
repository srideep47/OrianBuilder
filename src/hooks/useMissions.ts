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
  });

  const eventsQuery = useQuery({
    queryKey: queryKeys.missions.events({ missionId: missionId ?? null }),
    queryFn: () => ipc.mission.listMissionEvents({ missionId: missionId! }),
    enabled: missionId !== undefined && missionId !== null,
  });

  const tasksQuery = useQuery({
    queryKey: queryKeys.missions.tasks({ missionId: missionId ?? null }),
    queryFn: () => ipc.mission.listMissionTasks({ missionId: missionId! }),
    enabled: missionId !== undefined && missionId !== null,
  });

  const runsQuery = useQuery({
    queryKey: queryKeys.missions.runs({ missionId: missionId ?? null }),
    queryFn: () => ipc.mission.listMissionRuns({ missionId: missionId! }),
    enabled: missionId !== undefined && missionId !== null,
  });

  const workersQuery = useQuery({
    queryKey: queryKeys.missions.workers({ missionId: missionId ?? null }),
    queryFn: () => ipc.mission.listMissionWorkers({ missionId: missionId! }),
    enabled: missionId !== undefined && missionId !== null,
  });

  const checkpointsQuery = useQuery({
    queryKey: queryKeys.missions.checkpoints({ missionId: missionId ?? null }),
    queryFn: () =>
      ipc.mission.listMissionCheckpoints({ missionId: missionId! }),
    enabled: missionId !== undefined && missionId !== null,
  });

  const artifactsQuery = useQuery({
    queryKey: queryKeys.missions.artifacts({ missionId: missionId ?? null }),
    queryFn: () => ipc.mission.listMissionArtifacts({ missionId: missionId! }),
    enabled: missionId !== undefined && missionId !== null,
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

  return {
    missions: missionsQuery.data ?? [],
    mission: missionQuery.data ?? null,
    events: eventsQuery.data ?? [],
    tasks: tasksQuery.data ?? [],
    runs: runsQuery.data ?? [],
    workers: workersQuery.data ?? [],
    checkpoints: checkpointsQuery.data ?? [],
    artifacts: artifactsQuery.data ?? [],
    isLoading:
      missionsQuery.isLoading ||
      missionQuery.isLoading ||
      eventsQuery.isLoading ||
      tasksQuery.isLoading ||
      runsQuery.isLoading ||
      workersQuery.isLoading ||
      checkpointsQuery.isLoading ||
      artifactsQuery.isLoading,
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
    refreshMissions: () => invalidateMissionQueries(missionId),
  };
}
