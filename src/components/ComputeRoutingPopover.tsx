import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Cpu,
  Monitor,
  X,
  CheckCircle2,
  Wifi,
  Zap,
  AlertTriangle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ipc } from "@/ipc/types";
import { queryKeys } from "@/lib/queryKeys";
import type { ComputeNode, ComputeMode } from "@/ipc/types/compute";
import { useEmbeddedModelStatus } from "@/hooks/useEmbeddedModelStatus";

function LoadBar({ pct }: { pct: number }) {
  const color =
    pct < 50 ? "bg-green-500" : pct < 80 ? "bg-yellow-500" : "bg-red-500";
  return (
    <div className="h-1 bg-muted rounded-full overflow-hidden w-16">
      <div
        className={`h-full rounded-full transition-all ${color}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function NodeRow({
  node,
  selected,
  onSelect,
}: {
  node: ComputeNode;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors ${
        selected
          ? "bg-primary/10 border border-primary/20"
          : node.computeAvailable
            ? "hover:bg-muted/50"
            : "opacity-40 cursor-not-allowed"
      }`}
      disabled={!node.computeAvailable && !node.isLocal}
    >
      <div className="shrink-0">
        {node.isLocal ? (
          <Monitor className="w-4 h-4 text-muted-foreground" />
        ) : (
          <Wifi className="w-4 h-4 text-muted-foreground" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{node.label}</p>
        <div className="flex items-center gap-2 mt-0.5">
          {node.hardware?.gpu && node.hardware.gpu !== "Unknown" && (
            <span className="text-xs text-muted-foreground truncate">
              {node.hardware.gpu
                .replace("NVIDIA GeForce ", "")
                .replace("AMD Radeon ", "")}
            </span>
          )}
          {!node.isLocal && node.latencyMs !== null && (
            <span className="text-xs text-muted-foreground">
              {node.latencyMs}ms
            </span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <LoadBar pct={node.gpuUtilization} />
        {selected && <CheckCircle2 className="w-4 h-4 text-primary" />}
      </div>
    </button>
  );
}

export function ComputeRoutingPopover() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [autoMode, setAutoMode] = useState(false);

  const { data: nodes = [] } = useQuery<ComputeNode[]>({
    queryKey: queryKeys.compute.nodes,
    queryFn: () => ipc.compute.getAvailableNodes(),
    refetchInterval: open ? 2000 : 30000,
  });

  const { data: target } = useQuery({
    queryKey: queryKeys.compute.target,
    queryFn: () => ipc.compute.getTarget(),
  });

  const { data: shareStatus } = useQuery({
    queryKey: queryKeys.compute.shareStatus,
    queryFn: () => ipc.compute.getShareStatus(),
    refetchInterval: open ? 3000 : 60000,
  });

  const { data: embeddedStatus } = useEmbeddedModelStatus();
  const sharingButNoModel =
    shareStatus?.enabled && !embeddedStatus?.modelLoaded;

  useEffect(() => {
    if (target) setAutoMode(target.mode === "auto");
  }, [target]);

  const setTarget = useMutation({
    mutationFn: (params: { mode: ComputeMode; peerId?: string }) =>
      ipc.compute.setTarget(params),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.compute.target });
    },
  });

  const toggleSharing = useMutation({
    mutationFn: (enabled: boolean) =>
      ipc.compute.setSharing({ enabled, maxConcurrent: 2 }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.compute.shareStatus,
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.compute.nodes });
    },
  });

  const activeNodeId =
    target?.mode === "auto"
      ? "auto"
      : target?.mode === "peer"
        ? (target.peerId ?? "local")
        : "local";

  const activeNode = nodes.find((n) => n.id === activeNodeId) ?? nodes[0];

  const handleSelectNode = (node: ComputeNode) => {
    if (autoMode) return;
    if (node.isLocal) {
      setTarget.mutate({ mode: "local" });
    } else {
      setTarget.mutate({ mode: "peer", peerId: node.id });
    }
  };

  const handleAutoToggle = () => {
    const next = !autoMode;
    setAutoMode(next);
    setTarget.mutate({ mode: next ? "auto" : "local" });
  };

  return (
    <div className="relative no-app-region-drag">
      <Button
        variant="ghost"
        size="sm"
        className="h-7 gap-1.5 px-2 text-xs font-medium"
        onClick={() => setOpen((v) => !v)}
      >
        <Cpu className="w-3.5 h-3.5" />
        <span className="max-w-[100px] truncate">
          {activeNode
            ? activeNode.isLocal
              ? "Local"
              : activeNode.label.split(" · ")[0]
            : "Local"}
        </span>
        {activeNode && !activeNode.isLocal && (
          <LoadBar pct={activeNode.gpuUtilization} />
        )}
      </Button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-8 w-72 bg-background border border-border rounded-xl shadow-xl z-50 flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <div className="flex items-center gap-2">
                <Zap className="w-4 h-4 text-primary" />
                <h3 className="text-sm font-semibold">Compute</h3>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0"
                onClick={() => setOpen(false)}
              >
                <X className="w-3.5 h-3.5" />
              </Button>
            </div>

            {/* Auto-select toggle */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <div>
                <p className="text-sm font-medium">Auto-select</p>
                <p className="text-xs text-muted-foreground">
                  Use the least-loaded device
                </p>
              </div>
              <button
                onClick={handleAutoToggle}
                className={`relative w-10 h-5 rounded-full transition-colors ${
                  autoMode ? "bg-primary" : "bg-muted-foreground/30"
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow-sm transition-transform ${
                    autoMode ? "translate-x-5" : "translate-x-0"
                  }`}
                />
              </button>
            </div>

            {/* Node list */}
            <div className="p-2 flex flex-col gap-0.5">
              {nodes.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-4">
                  No compute nodes available
                </p>
              ) : (
                nodes.map((node) => (
                  <NodeRow
                    key={node.id}
                    node={node}
                    selected={
                      !autoMode &&
                      (node.id === activeNodeId ||
                        (node.isLocal && activeNodeId === "local"))
                    }
                    onSelect={() => handleSelectNode(node)}
                  />
                ))
              )}
            </div>

            {/* Share my compute toggle */}
            <div className="flex items-center justify-between px-4 py-3 border-t border-border">
              <div>
                <p className="text-sm font-medium">Share my compute</p>
                <p className="text-xs text-muted-foreground">
                  Let trusted peers use your GPU
                </p>
              </div>
              <button
                onClick={() => toggleSharing.mutate(!shareStatus?.enabled)}
                disabled={toggleSharing.isPending}
                className={`relative w-10 h-5 rounded-full transition-colors ${
                  shareStatus?.enabled ? "bg-primary" : "bg-muted-foreground/30"
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow-sm transition-transform ${
                    shareStatus?.enabled ? "translate-x-5" : "translate-x-0"
                  }`}
                />
              </button>
            </div>

            {/* Warning when sharing is on but no model is loaded */}
            {sharingButNoModel && (
              <div className="flex items-start gap-2 px-4 py-3 border-t border-border bg-amber-500/5">
                <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                <div className="flex flex-col gap-0.5">
                  <p className="text-xs font-medium text-amber-600 dark:text-amber-400">
                    No model loaded
                  </p>
                  <p className="text-[11px] text-muted-foreground leading-snug">
                    Peers won't see anything to use. Open the{" "}
                    <span className="font-medium text-foreground">Engine</span>{" "}
                    screen and load a model.
                  </p>
                </div>
              </div>
            )}

            {/* Footer */}
            <div className="px-4 py-2.5 border-t border-border">
              <p className="text-xs text-muted-foreground">
                Remote inference routes through encrypted P2P
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
