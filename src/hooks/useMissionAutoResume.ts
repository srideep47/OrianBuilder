import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { ipc } from "@/ipc/types";
import { queryKeys } from "@/lib/queryKeys";

/**
 * Triggers mission auto-resume once per app session.
 *
 * The main process flags interrupted missions whose autonomy profile is
 * `trusted-workspace` or `full-autopilot-sandbox` (or any mission when the
 * `autoResumeMissionsOnStartup` setting is on) for auto-resume during the
 * `recoverInterruptedMissionsOnStartup` startup task. This hook is what
 * actually wakes them back up: it asks the main process to transition any
 * eligible queued mission back to `running`, mark queued workers `ready`, and
 * fire the parallel worker dispatch loop.
 */
export function useMissionAutoResume() {
  const queryClient = useQueryClient();
  const ranRef = useRef(false);

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;

    const run = async () => {
      try {
        const result = await ipc.mission.triggerMissionAutoResume({});
        if (result.resumedMissionIds.length > 0) {
          await queryClient.invalidateQueries({
            queryKey: queryKeys.missions.all,
          });
        }
      } catch {
        // Auto-resume is best-effort; the main process will log details.
      }
    };

    void run();
  }, [queryClient]);
}
