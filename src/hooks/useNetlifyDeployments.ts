import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ipc, type NetlifyDeployment } from "@/ipc/types";
import { queryKeys } from "@/lib/queryKeys";

export function useNetlifyDeployments(appId: number) {
  const queryClient = useQueryClient();

  const TERMINAL_STATES = new Set(["READY", "ERROR", "CANCELED"]);

  const {
    data: deployments = [],
    isLoading,
    error,
    refetch,
  } = useQuery<NetlifyDeployment[], Error>({
    queryKey: queryKeys.netlify.deployments({ appId }),
    queryFn: async () => {
      return ipc.netlify.getDeployments({ appId });
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

  const disconnectSiteMutation = useMutation<void, Error, void>({
    mutationFn: async () => {
      return ipc.netlify.disconnect({ appId });
    },
    onSuccess: () => {
      queryClient.removeQueries({
        queryKey: queryKeys.netlify.deployments({ appId }),
      });
    },
  });

  const getDeployments = async () => {
    return refetch();
  };

  const disconnectProject = async () => {
    return disconnectSiteMutation.mutateAsync();
  };

  return {
    deployments,
    isLoading,
    error: error?.message || null,
    getDeployments,
    disconnectProject,
    isDisconnecting: disconnectSiteMutation.isPending,
    disconnectError: disconnectSiteMutation.error?.message || null,
  };
}
