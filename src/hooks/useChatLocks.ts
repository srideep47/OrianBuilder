import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { chatClient } from "@/ipc/types/chat";

const lockQueryKey = (chatId: number | null) =>
  ["chat-locked-paths", chatId] as const;

/**
 * Fetches and mutates the locked-paths list for a chat. Locks are user-set
 * project-relative paths that the agent refuses to write/edit/delete/rename.
 * Pattern borrowed from bolt.diy.
 */
export function useChatLocks(chatId: number | null) {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: lockQueryKey(chatId),
    queryFn: async () => {
      if (chatId === null) return [] as string[];
      return chatClient.getLockedPaths(chatId);
    },
    enabled: chatId !== null,
    staleTime: 30_000,
  });

  const addLock = useMutation({
    mutationFn: async (path: string) => {
      if (chatId === null) throw new Error("No chat selected");
      return chatClient.addLockedPath({ chatId, path });
    },
    onSuccess: (next) => {
      queryClient.setQueryData(lockQueryKey(chatId), next);
    },
  });

  const removeLock = useMutation({
    mutationFn: async (path: string) => {
      if (chatId === null) throw new Error("No chat selected");
      return chatClient.removeLockedPath({ chatId, path });
    },
    onSuccess: (next) => {
      queryClient.setQueryData(lockQueryKey(chatId), next);
    },
  });

  const lockedPaths = query.data ?? [];
  const isLocked = (target: string) => {
    if (lockedPaths.length === 0) return false;
    const normalized = target.replace(/\\/g, "/").replace(/^\.\/+/, "");
    for (const raw of lockedPaths) {
      const lock = raw
        .replace(/\\/g, "/")
        .replace(/^\.\/+/, "")
        .replace(/\/+$/, "");
      if (lock === normalized) return true;
      if (normalized.startsWith(`${lock}/`)) return true;
    }
    return false;
  };

  return {
    lockedPaths,
    isLocked,
    isLoading: query.isLoading,
    addLock: addLock.mutate,
    removeLock: removeLock.mutate,
  };
}
