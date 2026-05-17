import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ipc } from "@/ipc/types";
import type {
  McpServer,
  McpServerUpdate,
  McpTool,
  McpToolConsent,
  CreateMcpServer,
} from "@/ipc/types";
import { queryKeys } from "@/lib/queryKeys";

export type Transport = "stdio" | "http";
export type McpToolRiskOverride = "low" | "medium" | "high" | "critical";
export type McpToolStateScopeOverride =
  | "read_only"
  | "workspace"
  | "runtime"
  | "external"
  | "host";

export function useMcp() {
  const queryClient = useQueryClient();

  const serversQuery = useQuery<McpServer[], Error>({
    queryKey: queryKeys.mcp.servers,
    queryFn: async () => {
      const list = await ipc.mcp.listServers();
      return (list || []) as McpServer[];
    },
    meta: { showErrorToast: true },
  });

  const serverIds = useMemo(
    () => (serversQuery.data || []).map((s) => s.id).sort((a, b) => a - b),
    [serversQuery.data],
  );

  const toolsByServerQuery = useQuery<Record<number, McpTool[]>, Error>({
    queryKey: queryKeys.mcp.toolsByServer.list({ serverIds }),
    enabled: serverIds.length > 0,
    queryFn: async () => {
      const entries = await Promise.all(
        serverIds.map(async (id) => [id, await ipc.mcp.listTools(id)] as const),
      );
      return Object.fromEntries(entries) as Record<number, McpTool[]>;
    },
    meta: { showErrorToast: true },
  });

  const consentsQuery = useQuery<McpToolConsent[], Error>({
    queryKey: queryKeys.mcp.consents,
    queryFn: async () => {
      const list = await ipc.mcp.getToolConsents();
      return (list || []) as McpToolConsent[];
    },
    meta: { showErrorToast: true },
  });

  const consentsMap = useMemo(() => {
    const map: Record<string, McpToolConsent["consent"]> = {};
    for (const c of consentsQuery.data || []) {
      map[`${c.serverId}:${c.toolName}`] = c.consent;
    }
    return map;
  }, [consentsQuery.data]);

  const createServerMutation = useMutation({
    mutationFn: async (params: CreateMcpServer) => {
      return ipc.mcp.createServer(params);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.mcp.servers });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.mcp.toolsByServer.all,
      });
    },
    meta: { showErrorToast: true },
  });

  const updateServerMutation = useMutation({
    mutationFn: async (params: McpServerUpdate) => {
      return ipc.mcp.updateServer(params);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.mcp.servers });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.mcp.toolsByServer.all,
      });
    },
    meta: { showErrorToast: true },
  });

  const deleteServerMutation = useMutation({
    mutationFn: async (id: number) => {
      return ipc.mcp.deleteServer(id);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.mcp.servers });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.mcp.toolsByServer.all,
      });
    },
    meta: { showErrorToast: true },
  });

  const setConsentMutation = useMutation({
    mutationFn: async (params: {
      serverId: number;
      toolName: string;
      consent: McpToolConsent["consent"];
    }) => {
      return ipc.mcp.setToolConsent(params);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.mcp.consents });
    },
    meta: { showErrorToast: true },
  });

  const setTrustOverrideMutation = useMutation({
    mutationFn: async (params: {
      serverId: number;
      toolName: string;
      riskOverride?: McpToolRiskOverride | null;
      stateScopeOverride?: McpToolStateScopeOverride | null;
      requiresExplicitConsentOverride?: boolean | null;
    }) => {
      return ipc.mcp.setToolTrustOverride(params);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.mcp.consents });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.mcp.toolsByServer.all,
      });
    },
    meta: { showErrorToast: true },
  });

  const createServer = async (params: CreateMcpServer) =>
    createServerMutation.mutateAsync(params);

  const toggleEnabled = async (id: number, currentEnabled: boolean) =>
    updateServerMutation.mutateAsync({ id, enabled: !currentEnabled });

  const updateServer = async (params: McpServerUpdate) =>
    updateServerMutation.mutateAsync(params);

  const deleteServer = async (id: number) =>
    deleteServerMutation.mutateAsync(id);

  const setToolConsent = async (
    serverId: number,
    toolName: string,
    consent: McpToolConsent["consent"],
  ) => setConsentMutation.mutateAsync({ serverId, toolName, consent });

  const setToolTrustOverride = async (params: {
    serverId: number;
    toolName: string;
    riskOverride?: McpToolRiskOverride | null;
    stateScopeOverride?: McpToolStateScopeOverride | null;
    requiresExplicitConsentOverride?: boolean | null;
  }) => setTrustOverrideMutation.mutateAsync(params);

  const refetchAll = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.mcp.servers }),
      queryClient.invalidateQueries({
        queryKey: queryKeys.mcp.toolsByServer.all,
      }),
      queryClient.invalidateQueries({ queryKey: queryKeys.mcp.consents }),
    ]);
  };

  return {
    servers: serversQuery.data || [],
    toolsByServer: toolsByServerQuery.data || {},
    consentsList: consentsQuery.data || [],
    consentsMap,
    isLoading:
      serversQuery.isLoading ||
      toolsByServerQuery.isLoading ||
      consentsQuery.isLoading,
    error:
      serversQuery.error || toolsByServerQuery.error || consentsQuery.error,
    refetchAll,

    // Mutations
    createServer,
    toggleEnabled,
    updateServer,
    deleteServer,
    setToolConsent,
    setToolTrustOverride,

    // Status flags
    isCreating: createServerMutation.isPending,
    isToggling: updateServerMutation.isPending,
    isUpdatingServer: updateServerMutation.isPending,
    isDeleting: deleteServerMutation.isPending,
    isSettingConsent: setConsentMutation.isPending,
    isSettingTrustOverride: setTrustOverrideMutation.isPending,
  } as const;
}
