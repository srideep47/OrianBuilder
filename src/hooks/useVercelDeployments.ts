import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ipc, type VercelDeployment } from "@/ipc/types";
import { queryKeys } from "@/lib/queryKeys";

export function useVercelDeployments(appId: number) {
  const queryClient = useQueryClient();

  const TERMINAL_STATES = new Set(["READY", "ERROR", "CANCELED"]);

  const {
    data: deployments = [],
    isLoading,
    error,
    refetch,
  } = useQuery<VercelDeployment[], Error>({
    queryKey: queryKeys.vercel.deployments({ appId }),
    queryFn: async () => {
      return ipc.vercel.getDeployments({ appId });
    },
    // Poll every 5 s while any deployment is in a non-terminal state;
    // stop polling once all are done.
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data || data.length === 0) return false;
      const hasActive = data.some((d) => !TERMINAL_STATES.has(d.readyState));
      return hasActive ? 5000 : false;
    },
  });

  const disconnectProjectMutation = useMutation<void, Error, void>({
    mutationFn: async () => {
      return ipc.vercel.disconnect({ appId });
    },
    onSuccess: () => {
      // Clear deployments cache when project is disconnected
      queryClient.removeQueries({
        queryKey: queryKeys.vercel.deployments({ appId }),
      });
    },
  });

  const getDeployments = async () => {
    return refetch();
  };

  const disconnectProject = async () => {
    return disconnectProjectMutation.mutateAsync();
  };

  return {
    deployments,
    isLoading,
    error: error?.message || null,
    getDeployments,
    disconnectProject,
    isDisconnecting: disconnectProjectMutation.isPending,
    disconnectError: disconnectProjectMutation.error?.message || null,
  };
}
