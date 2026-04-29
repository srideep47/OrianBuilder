import { useState, useCallback } from "react";
import { ipc } from "@/ipc/types";
import type { EmbeddedServerStatus } from "@/ipc/types";

export function useEmbeddedModel() {
  const [status, setStatus] = useState<EmbeddedServerStatus | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const s = await ipc.embeddedModel.getStatus();
      setStatus(s);
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, []);

  return { status, loading, refresh };
}
