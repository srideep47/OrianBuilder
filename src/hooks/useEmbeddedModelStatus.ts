import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { ipc } from "@/ipc/types";
import { queryKeys } from "@/lib/queryKeys";

export function useEmbeddedModelStatus() {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: queryKeys.embeddedModel.status(),
    queryFn: () => ipc.embeddedModel.getStatus(undefined),
  });

  useEffect(() => {
    return ipc.events.embeddedModel.onStatusChanged(() => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.embeddedModel.status(),
      });
    });
  }, [queryClient]);

  return query;
}
