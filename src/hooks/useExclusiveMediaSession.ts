import { useEffect, useState } from "react";
import { ipc } from "@/ipc/types";

/** Holds an exclusive model-residency lease while a direct Media AI UI is open. */
export function useExclusiveMediaSession(): {
  ready: boolean;
  error: string | null;
} {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    void ipc.mediaAi.beginExclusiveSession(undefined).then((result) => {
      if (!mounted) return;
      if (result.success) {
        setReady(true);
      } else {
        setError(result.error ?? "Could not reserve memory for Media AI");
      }
    });

    return () => {
      mounted = false;
      void ipc.mediaAi.endExclusiveSession(undefined);
    };
  }, []);

  return { ready, error };
}
