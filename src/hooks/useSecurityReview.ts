import { useQuery } from "@tanstack/react-query";
import { ipc } from "@/ipc/types";
import { queryKeys } from "@/lib/queryKeys";
import {
  OrianBuilderError,
  OrianBuilderErrorKind,
} from "@/errors/orianbuilder_error";

export function useSecurityReview(appId: number | null) {
  return useQuery({
    queryKey: queryKeys.securityReview.byApp({ appId }),
    queryFn: async () => {
      if (!appId) {
        throw new OrianBuilderError(
          "App ID is required",
          OrianBuilderErrorKind.Validation,
        );
      }
      return ipc.security.getLatestSecurityReview(appId);
    },
    enabled: appId !== null,
    retry: false,
    meta: {
      showErrorToast: false, // Don't show error toast if no security review found
    },
  });
}
