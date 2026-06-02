import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc } from "@/ipc/types";
import { showError, showSuccess } from "@/lib/toast";

const GENERATED_MEDIA_KEY = ["generated-media"] as const;

/**
 * Global generated-media pool (Library → Media). Every image/video generated
 * in OrianBuilder lands here. Refetches live when the main process reports a
 * change.
 */
export function useGeneratedMedia() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: GENERATED_MEDIA_KEY,
    queryFn: () => ipc.generatedMedia.list(),
    staleTime: 5_000,
  });

  useEffect(() => {
    const unsub = ipc.events.generatedMedia.onChanged(() => {
      queryClient.invalidateQueries({ queryKey: GENERATED_MEDIA_KEY });
    });
    return () => unsub();
  }, [queryClient]);

  const deleteMutation = useMutation({
    mutationFn: (fileName: string) => ipc.generatedMedia.remove({ fileName }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: GENERATED_MEDIA_KEY });
      showSuccess("Removed from library");
    },
    onError: (error) => showError(error),
  });

  return {
    items: query.data ?? [],
    isLoading: query.isLoading,
    removeItem: deleteMutation.mutateAsync,
    isMutating: deleteMutation.isPending,
  };
}
