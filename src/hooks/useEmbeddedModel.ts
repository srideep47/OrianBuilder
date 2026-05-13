import { useEmbeddedModelStatus } from "@/hooks/useEmbeddedModelStatus";

export function useEmbeddedModel() {
  const query = useEmbeddedModelStatus();

  return {
    status: query.data ?? null,
    loading: query.isLoading || query.isFetching,
    refresh: query.refetch,
  };
}
