import { useState, useEffect } from "react";
import { useAtom } from "jotai";
import { isNetworkPeerListOpenAtom } from "@/atoms/uiAtoms";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Wifi,
  WifiOff,
  UserPlus,
  Search,
  Monitor,
  Laptop,
  Server,
  Signal,
  Clock,
  Shield,
  ShieldOff,
  X,
  Copy,
  Check,
  Loader2,
  Cpu,
  CheckCircle2,
  RefreshCw,
  Sparkles,
  Activity,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { ipc } from "@/ipc/types";
import { queryKeys } from "@/lib/queryKeys";
import type { Peer, FriendRequest } from "@/ipc/types/network";

// ─── Peer avatar (colored by public key hash) ────────────────────────────────
function PeerAvatar({
  peer,
  size = "md",
}: {
  peer: Peer;
  size?: "sm" | "md" | "lg";
}) {
  const hue = parseInt(peer.publicKey.slice(0, 4), 16) % 360;
  const initials = peer.displayName.slice(0, 2).toUpperCase();
  const sz =
    size === "lg"
      ? "w-12 h-12 text-base"
      : size === "sm"
        ? "w-7 h-7 text-xs"
        : "w-9 h-9 text-sm";
  return (
    <div
      className={`${sz} rounded-full flex items-center justify-center font-semibold text-white shrink-0`}
      style={{ background: `hsl(${hue},60%,45%)` }}
    >
      {initials}
    </div>
  );
}

function DeviceIcon({ type }: { type: Peer["deviceType"] }) {
  const Icon =
    type === "laptop" ? Laptop : type === "server" ? Server : Monitor;
  return <Icon className="w-3.5 h-3.5" />;
}

function LatencyBadge({ ms }: { ms: number | null }) {
  if (ms === null) return null;
  const color =
    ms < 20 ? "text-green-500" : ms < 100 ? "text-yellow-500" : "text-red-500";
  return <span className={`text-xs font-mono ${color}`}>{ms}ms</span>;
}

function StatusDot({ status }: { status: Peer["status"] }) {
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full shrink-0 ${
        status === "online"
          ? "bg-green-500"
          : status === "connecting"
            ? "bg-yellow-500 animate-pulse"
            : "bg-muted-foreground/40"
      }`}
    />
  );
}

// ─── Peer Row ─────────────────────────────────────────────────────────────────
function PeerRow({
  peer,
  selected,
  onSelect,
  onAddFriend,
}: {
  peer: Peer;
  selected: boolean;
  onSelect: () => void;
  onAddFriend?: () => void;
}) {
  return (
    <div
      className={`flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors cursor-pointer group ${
        selected
          ? "bg-primary/10 border border-primary/20"
          : "hover:bg-muted/50"
      }`}
      onClick={onSelect}
    >
      <PeerAvatar peer={peer} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <StatusDot status={peer.status} />
          <span className="text-sm font-medium truncate">
            {peer.displayName}
          </span>
          {peer.isTrusted && (
            <Shield className="w-3 h-3 text-primary shrink-0" />
          )}
        </div>
        <div className="flex items-center gap-1 text-xs text-muted-foreground mt-0.5">
          <DeviceIcon type={peer.deviceType} />
          <span className="truncate">{peer.deviceName}</span>
          {peer.hardware?.gpu && peer.hardware.gpu !== "Unknown" && (
            <span className="truncate">
              ·{" "}
              {peer.hardware.gpu
                .replace("NVIDIA GeForce ", "")
                .replace("AMD Radeon ", "")}
            </span>
          )}
        </div>
      </div>
      {/* Show Add Friend button on hover for unknown peers */}
      {!peer.isTrusted && onAddFriend && peer.status === "online" ? (
        <Button
          size="sm"
          variant="outline"
          className="h-6 px-2 text-xs opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
          onClick={(e) => {
            e.stopPropagation();
            onAddFriend();
          }}
        >
          <UserPlus className="w-3 h-3 mr-1" />
          Add
        </Button>
      ) : (
        <LatencyBadge ms={peer.latencyMs} />
      )}
    </div>
  );
}

// ─── Friend Request Row ───────────────────────────────────────────────────────
function FriendRequestRow({
  req,
  onAccept,
  onDecline,
}: {
  req: FriendRequest;
  onAccept: () => void;
  onDecline: () => void;
}) {
  return (
    <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-primary/5 border border-primary/10">
      <div className="w-9 h-9 rounded-full bg-primary/20 flex items-center justify-center shrink-0">
        <UserPlus className="w-4 h-4 text-primary" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{req.fromDisplayName}</p>
        <p className="text-xs text-muted-foreground">Wants to connect</p>
      </div>
      <div className="flex gap-1 shrink-0">
        <Button size="sm" className="h-7 px-2 text-xs" onClick={onAccept}>
          Accept
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs"
          onClick={onDecline}
        >
          <X className="w-3 h-3" />
        </Button>
      </div>
    </div>
  );
}

function formatRelativeTime(ms: number | null): string {
  if (ms === null || ms === 0) return "never";
  const diff = Date.now() - ms;
  if (diff < 0) return "just now";
  if (diff < 1500) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

// ─── Peer Detail Panel ────────────────────────────────────────────────────────
function PeerDetailPanel({
  peer,
  onRemove,
  onAddFriend,
  onRefresh,
  isRefreshing,
}: {
  peer: Peer;
  onRemove: () => void;
  onAddFriend: () => void;
  onRefresh: () => void;
  isRefreshing: boolean;
}) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [requestSent, setRequestSent] = useState(false);

  return (
    <div className="flex flex-col gap-5 p-6 h-full overflow-y-auto">
      {/* Header */}
      <div className="flex items-start gap-4">
        <PeerAvatar peer={peer} size="lg" />
        <div className="flex-1 min-w-0">
          <h2 className="text-lg font-bold truncate">{peer.displayName}</h2>
          <div className="flex items-center gap-2 mt-0.5">
            <StatusDot status={peer.status} />
            <span className="text-sm text-muted-foreground capitalize">
              {peer.status}
            </span>
            {peer.isTrusted && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-primary/10 text-primary font-medium">
                Friend
              </span>
            )}
          </div>
        </div>
        <LatencyBadge ms={peer.latencyMs} />
      </div>

      {/* Device info */}
      <Card className="p-4 flex flex-col gap-3">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          Device
        </p>
        <div className="flex items-center gap-2">
          <DeviceIcon type={peer.deviceType} />
          <span className="text-sm font-medium">{peer.deviceName}</span>
          <span className="text-xs text-muted-foreground capitalize">
            ({peer.deviceType})
          </span>
        </div>
        {peer.hardware && (
          <div className="flex flex-wrap gap-1.5">
            <span className="text-xs px-2 py-0.5 rounded bg-muted">
              {peer.hardware.cpu}
            </span>
            <span className="text-xs px-2 py-0.5 rounded bg-muted">
              {peer.hardware.ramGB} GB RAM
            </span>
            {peer.hardware.gpu !== "Unknown" && (
              <span className="text-xs px-2 py-0.5 rounded bg-muted">
                {peer.hardware.gpu}
              </span>
            )}
            {peer.hardware.vramGB > 0 && (
              <span className="text-xs px-2 py-0.5 rounded bg-muted">
                {peer.hardware.vramGB} GB VRAM
              </span>
            )}
          </div>
        )}
      </Card>

      {/* Compute */}
      {peer.status === "online" && (
        <Card className="p-4 flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Compute
            </p>
            <button
              onClick={onRefresh}
              disabled={isRefreshing}
              className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-60"
              title="Ask this peer to re-send their loaded model + GPU status"
            >
              <RefreshCw
                className={`w-3 h-3 ${isRefreshing ? "animate-spin" : ""}`}
              />
              Refresh
            </button>
          </div>
          <div className="flex items-center gap-2">
            <Cpu className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm">
              {peer.computeAvailable ? "Sharing compute" : "Not sharing"}
            </span>
            <span className="text-xs text-muted-foreground ml-auto">
              updated {formatRelativeTime(peer.lastLoadUpdateAt)}
            </span>
          </div>
          {peer.gpuUtilization > 0 && (
            <div>
              <div className="flex justify-between text-xs text-muted-foreground mb-1">
                <span>GPU load</span>
                <span>{peer.gpuUtilization}%</span>
              </div>
              <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary rounded-full transition-all"
                  style={{ width: `${peer.gpuUtilization}%` }}
                />
              </div>
            </div>
          )}
          <div className="mt-1">
            <p className="text-[11px] text-muted-foreground mb-1.5 flex items-center gap-1">
              <Sparkles className="w-3 h-3" />
              Loaded models
            </p>
            {peer.loadedModels.length > 0 ? (
              <div className="flex flex-wrap gap-1">
                {peer.loadedModels.map((m) => (
                  <span
                    key={m}
                    className="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary"
                  >
                    {m}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground italic">
                No model loaded in their OrianBuilder Engine yet.
              </p>
            )}
          </div>
        </Card>
      )}

      {/* Security */}
      <Card className="p-4 flex flex-col gap-2">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          Identity
        </p>
        <div className="flex items-center gap-2">
          {peer.isTrusted ? (
            <Shield className="w-4 h-4 text-green-500" />
          ) : (
            <ShieldOff className="w-4 h-4 text-muted-foreground" />
          )}
          <span className="text-sm">
            {peer.isTrusted ? "Trusted friend" : "Unknown peer"}
          </span>
        </div>
        <code className="text-xs font-mono bg-muted px-2 py-1 rounded break-all">
          {peer.fingerprint}
        </code>
      </Card>

      {/* Add Friend (for unknown / discovered peers) */}
      {!peer.isTrusted && peer.status === "online" && (
        <div className="mt-auto pt-2">
          {requestSent ? (
            <div className="flex items-center justify-center gap-2 py-3 rounded-lg bg-primary/10 text-primary text-sm font-medium">
              <CheckCircle2 className="w-4 h-4" />
              Request sent — waiting for them to accept
            </div>
          ) : (
            <>
              <Button
                className="w-full gap-2"
                onClick={() => {
                  onAddFriend();
                  setRequestSent(true);
                }}
              >
                <UserPlus className="w-4 h-4" />
                Send Friend Request
              </Button>
              <p className="text-xs text-muted-foreground text-center mt-2">
                They'll get a notification to accept or decline.
              </p>
            </>
          )}
        </div>
      )}

      {/* Remove */}
      {peer.isTrusted && (
        <div className="mt-auto pt-2">
          {confirmRemove ? (
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="destructive"
                onClick={onRemove}
                className="flex-1"
              >
                Confirm Remove
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setConfirmRemove(false)}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="text-destructive border-destructive/30 hover:bg-destructive/10 w-full"
              onClick={() => setConfirmRemove(true)}
            >
              Remove Friend
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Add Friend Modal ─────────────────────────────────────────────────────────
function AddFriendModal({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<"share" | "enter">("share");
  const [inputCode, setInputCode] = useState("");
  const [codeCopied, setCodeCopied] = useState(false);

  const inviteQuery = useQuery({
    queryKey: ["network-invite"],
    queryFn: () => ipc.network.generateInvite(),
  });

  const redeemMutation = useMutation({
    mutationFn: (code: string) => ipc.network.redeemInvite({ code }),
    onSuccess: (result) => {
      toast.success(result.message);
      queryClient.invalidateQueries({ queryKey: queryKeys.network.status });
      onClose();
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : "Invalid code"),
  });

  const copyCode = () => {
    if (inviteQuery.data?.code) {
      navigator.clipboard.writeText(inviteQuery.data.code);
      setCodeCopied(true);
      setTimeout(() => setCodeCopied(false), 2000);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <Card className="w-full max-w-md p-6 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold">Add Friend</h2>
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X className="w-4 h-4" />
          </Button>
        </div>

        {/* Tabs */}
        <div className="flex rounded-lg bg-muted p-1 gap-1">
          {(["share", "enter"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 text-sm py-1.5 rounded-md font-medium transition-colors ${
                tab === t ? "bg-background shadow-sm" : "text-muted-foreground"
              }`}
            >
              {t === "share" ? "Share Your Code" : "Enter Their Code"}
            </button>
          ))}
        </div>

        {tab === "share" && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              Share this code with your friend. They enter it on their device to
              connect.
            </p>
            {inviteQuery.isLoading ? (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <code className="flex-1 text-sm font-mono bg-muted px-3 py-2.5 rounded-lg select-all tracking-wider">
                    {inviteQuery.data?.code}
                  </code>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={copyCode}
                    className="shrink-0"
                  >
                    {codeCopied ? (
                      <Check className="w-4 h-4 text-green-500" />
                    ) : (
                      <Copy className="w-4 h-4" />
                    )}
                  </Button>
                </div>
                {inviteQuery.data?.expiresAt && (
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock className="w-3 h-3" />
                    Expires in 24 hours
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {tab === "enter" && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              Enter the code your friend shared with you.
            </p>
            <Input
              value={inputCode}
              onChange={(e) => setInputCode(e.target.value.toUpperCase())}
              placeholder="ORION-NAME-XXXXXXXXXX"
              className="font-mono tracking-wider"
              onKeyDown={(e) =>
                e.key === "Enter" && redeemMutation.mutate(inputCode)
              }
            />
            <Button
              onClick={() => redeemMutation.mutate(inputCode)}
              disabled={!inputCode.trim() || redeemMutation.isPending}
            >
              {redeemMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  Connecting…
                </>
              ) : (
                "Connect"
              )}
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}

// ─── Diagnostic View (shown when no peer is selected) ───────────────────────
function DiagnosticView() {
  const { data, isLoading, refetch, isRefetching } = useQuery({
    queryKey: ["network", "diagnostic"],
    queryFn: () => ipc.network.getDiagnostic(),
    refetchInterval: 2000,
  });

  const [testResults, setTestResults] = useState<
    Record<
      string,
      {
        ok: boolean;
        step: string;
        detail: string;
        output?: string;
        bytes?: number;
        durationMs?: number;
      }
    >
  >({});
  const [testingPeer, setTestingPeer] = useState<string | null>(null);

  const runTest = async (publicKey: string) => {
    setTestingPeer(publicKey);
    try {
      const result = await ipc.network.testPeer({ publicKey });
      setTestResults((prev) => ({ ...prev, [publicKey]: result }));
    } catch (err) {
      setTestResults((prev) => ({
        ...prev,
        [publicKey]: {
          ok: false,
          step: "ipc-error",
          detail: err instanceof Error ? err.message : String(err),
        },
      }));
    } finally {
      setTestingPeer(null);
    }
  };

  if (isLoading || !data) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center gap-4 text-muted-foreground">
        <Loader2 className="w-6 h-6 animate-spin" />
      </div>
    );
  }

  const selfOk = data.self.embeddedModelLoaded;
  return (
    <div className="flex flex-col gap-5 p-6 h-full overflow-y-auto">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold flex items-center gap-2">
          <Activity className="w-5 h-5 text-primary" /> Network Diagnostics
        </h2>
        <Button
          size="sm"
          variant="outline"
          onClick={() => refetch()}
          disabled={isRefetching}
        >
          <RefreshCw
            className={`w-3.5 h-3.5 mr-1.5 ${
              isRefetching ? "animate-spin" : ""
            }`}
          />
          Refresh
        </Button>
      </div>

      {/* This device */}
      <Card className="p-4 flex flex-col gap-3">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          This Device — what other peers see from me
        </p>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div className="text-muted-foreground">Display name</div>
          <div className="font-medium truncate">{data.self.displayName}</div>

          <div className="text-muted-foreground">Embedded engine</div>
          <div className="font-medium flex items-center gap-1.5">
            <span
              className={`w-2 h-2 rounded-full ${
                selfOk ? "bg-green-500" : "bg-red-500"
              }`}
            />
            {selfOk
              ? `Loaded: ${data.self.embeddedModelName ?? "—"}`
              : "No model loaded"}
          </div>

          <div className="text-muted-foreground">Share enabled</div>
          <div className="font-medium">
            {data.self.shareEnabled ? "Yes" : "No"}
          </div>

          <div className="text-muted-foreground">Last broadcast</div>
          <div className="font-medium">
            {formatRelativeTime(data.self.lastBroadcast.timestamp)}
          </div>

          <div className="text-muted-foreground">Broadcasting models</div>
          <div className="font-medium">
            {data.self.lastBroadcast.loadedModels.length > 0
              ? data.self.lastBroadcast.loadedModels.join(", ")
              : "(none)"}
          </div>

          <div className="text-muted-foreground">computeAvailable</div>
          <div className="font-medium">
            {data.self.lastBroadcast.computeAvailable ? "Yes" : "No"}
          </div>
        </div>
        {!selfOk && (
          <p className="text-xs text-amber-600 dark:text-amber-400 bg-amber-500/5 rounded p-2 leading-snug">
            Peers see this device as "No model loaded". Open the{" "}
            <span className="font-semibold">Engine</span> screen and load a
            model — only then can peers route inference here.
          </p>
        )}
      </Card>

      {/* Peers */}
      <Card className="p-4 flex flex-col gap-3">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          Connected peers — what I see from them
        </p>
        {data.peers.length === 0 ? (
          <p className="text-xs text-muted-foreground italic py-2">
            No peers connected.
          </p>
        ) : (
          data.peers.map((p) => {
            const result = testResults[p.publicKey];
            const isTesting = testingPeer === p.publicKey;
            return (
              <div
                key={p.publicKey}
                className="rounded-lg border border-border p-3 flex flex-col gap-2"
              >
                <div className="flex items-center gap-2">
                  <span
                    className={`w-2 h-2 rounded-full ${
                      p.isConnected ? "bg-green-500" : "bg-muted-foreground/40"
                    }`}
                  />
                  <span className="font-medium text-sm">{p.displayName}</span>
                  {p.latencyMs !== null && (
                    <span className="ml-auto text-xs text-muted-foreground font-mono">
                      {p.latencyMs}ms
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-1.5 text-xs">
                  <div className="text-muted-foreground">Last LOAD_UPDATE</div>
                  <div className="font-medium">
                    {formatRelativeTime(p.lastLoadUpdateAt)}
                  </div>
                  <div className="text-muted-foreground">Their models</div>
                  <div className="font-medium">
                    {p.loadedModels.length > 0
                      ? p.loadedModels.join(", ")
                      : "(none reported)"}
                  </div>
                  <div className="text-muted-foreground">computeAvailable</div>
                  <div className="font-medium">
                    {p.computeAvailable ? "Yes" : "No"}
                  </div>
                </div>
                {p.isConnected && p.lastLoadUpdateAt === null && (
                  <p className="text-[11px] text-amber-600 dark:text-amber-400 leading-snug">
                    Connected but no LOAD_UPDATE received yet. Their device
                    might be on an older build, or their load monitor isn't
                    running.
                  </p>
                )}
                {p.isConnected && p.loadedModels.length === 0 && (
                  <p className="text-[11px] text-muted-foreground leading-snug">
                    This peer has no model loaded in their Engine. They need to
                    load one before you can route inference to them.
                  </p>
                )}
                {p.isConnected && p.computeAvailable && (
                  <div className="flex flex-col gap-1.5 pt-1 border-t border-border/50">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => runTest(p.publicKey)}
                      disabled={isTesting}
                      className="w-full h-7 text-xs"
                    >
                      {isTesting ? (
                        <>
                          <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />
                          Testing round-trip…
                        </>
                      ) : (
                        <>
                          <Activity className="w-3 h-3 mr-1.5" />
                          Test inference round-trip
                        </>
                      )}
                    </Button>
                    {result && (
                      <div
                        className={`rounded p-2 text-[11px] leading-snug ${
                          result.ok
                            ? "bg-green-500/5 text-green-700 dark:text-green-400 border border-green-500/20"
                            : "bg-red-500/5 text-red-700 dark:text-red-400 border border-red-500/20"
                        }`}
                      >
                        <p className="font-medium">
                          {result.ok ? "✓" : "✗"} Step: {result.step}
                          {result.durationMs !== undefined && (
                            <span className="ml-2 font-mono">
                              ({result.durationMs}ms, {result.bytes ?? 0} bytes)
                            </span>
                          )}
                        </p>
                        <p className="mt-0.5">{result.detail}</p>
                        {result.output && (
                          <pre className="mt-1 p-1.5 rounded bg-background/50 font-mono text-[10px] whitespace-pre-wrap break-all max-h-32 overflow-auto">
                            {result.output}
                          </pre>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </Card>

      <p className="text-[11px] text-muted-foreground">
        Auto-refreshes every 2 seconds. Click any peer in the list to see
        details and remove them.
      </p>
    </div>
  );
}

// ─── Main Network Hub Page ────────────────────────────────────────────────────
export default function NetworkPage() {
  const queryClient = useQueryClient();
  const [selectedPeerKey, setSelectedPeerKey] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [showAddFriend, setShowAddFriend] = useState(false);
  const [isPeerListOpen, setIsPeerListOpen] = useAtom(
    isNetworkPeerListOpenAtom,
  );

  // Always open the peer-list panel when this page mounts so it appears by
  // default on every visit. The AppSidebar's Network button can still toggle
  // it from this open state.
  useEffect(() => {
    setIsPeerListOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { data: networkStatus, isLoading } = useQuery({
    queryKey: queryKeys.network.status,
    queryFn: () => ipc.network.getStatus(),
    refetchInterval: 5000,
  });

  const { data: friendRequests = [] } = useQuery({
    queryKey: queryKeys.network.friendRequests,
    queryFn: () => ipc.network.getFriendRequests(),
    refetchInterval: 3000,
  });

  // Subscribe to peer update events — refresh both the network status and the
  // compute node list so the CPU icon / model picker also pick up new state.
  useEffect(() => {
    const unsub = ipc.events.network.onPeerUpdate(() => {
      queryClient.invalidateQueries({ queryKey: queryKeys.network.status });
      queryClient.invalidateQueries({ queryKey: queryKeys.compute.nodes });
      queryClient.invalidateQueries({ queryKey: ["network", "diagnostic"] });
    });
    return unsub;
  }, [queryClient]);

  const toggleOnline = useMutation({
    mutationFn: (online: boolean) => ipc.network.setOnline({ online }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.network.status }),
  });

  const acceptRequest = useMutation({
    mutationFn: (id: number) =>
      ipc.network.acceptFriendRequest({ requestId: id }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.network.friendRequests,
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.network.status });
      toast.success("Friend added!");
    },
  });

  const declineRequest = useMutation({
    mutationFn: (id: number) =>
      ipc.network.declineFriendRequest({ requestId: id }),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: queryKeys.network.friendRequests,
      }),
  });

  const removeFriend = useMutation({
    mutationFn: (publicKey: string) => ipc.network.removeFriend({ publicKey }),
    onSuccess: () => {
      setSelectedPeerKey(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.network.status });
      toast.success("Friend removed");
    },
  });

  const sendFriendRequest = useMutation({
    mutationFn: (publicKey: string) =>
      ipc.network.sendFriendRequest({ publicKey }),
    onSuccess: () => {
      toast.success(
        "Friend request sent! They'll get a notification to accept.",
      );
    },
    onError: (err) =>
      toast.error(
        err instanceof Error ? err.message : "Failed to send request",
      ),
  });

  const refreshPeer = useMutation({
    mutationFn: (publicKey: string) => ipc.network.refreshPeer({ publicKey }),
    onSuccess: (result) => {
      if (result.success) {
        toast.success("Refresh requested — waiting for peer to respond…");
        // The LOAD_UPDATE arrives over the wire; query gets invalidated by
        // the peer-update event listener already wired up below.
      } else {
        toast.error("Peer isn't connected right now.");
      }
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : "Refresh failed"),
  });

  const peers = networkStatus?.peers ?? [];
  const isOnline = networkStatus?.isOnline ?? false;

  const filtered = peers.filter(
    (p) =>
      !search ||
      p.displayName.toLowerCase().includes(search.toLowerCase()) ||
      p.deviceName.toLowerCase().includes(search.toLowerCase()),
  );

  const lanPeers = filtered.filter((p) => p.isLan && p.status === "online");
  const friendPeers = filtered.filter((p) => p.isTrusted);
  const unknownOnline = filtered.filter(
    (p) => !p.isTrusted && !p.isLan && p.status === "online",
  );
  const selectedPeer =
    peers.find((p) => p.publicKey === selectedPeerKey) ?? null;

  return (
    <div className="flex h-full w-full">
      {/* ── Left: Peer List ── */}
      {isPeerListOpen && (
        <div className="w-[300px] shrink-0 flex flex-col border-r border-border h-full">
          {/* Top bar */}
          <div className="flex items-center gap-2 px-3 py-3 border-b border-border">
            <h1 className="font-bold text-sm flex-1">Network</h1>
            <button
              onClick={() => toggleOnline.mutate(!isOnline)}
              disabled={toggleOnline.isPending}
              className={`flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full font-medium transition-colors ${
                isOnline
                  ? "bg-green-500/10 text-green-600 hover:bg-green-500/20"
                  : "bg-muted text-muted-foreground hover:bg-muted/80"
              }`}
            >
              {isOnline ? (
                <Wifi className="w-3.5 h-3.5" />
              ) : (
                <WifiOff className="w-3.5 h-3.5" />
              )}
              {isOnline ? "Online" : "Offline"}
            </button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2"
              onClick={() => setShowAddFriend(true)}
            >
              <UserPlus className="w-3.5 h-3.5" />
            </Button>
          </div>

          {/* Search */}
          <div className="px-3 py-2 border-b border-border">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search peers…"
                className="pl-8 h-8 text-sm"
              />
            </div>
          </div>

          {/* List */}
          <div className="flex-1 overflow-y-auto px-2 py-2 flex flex-col gap-3">
            {isLoading && (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
              </div>
            )}

            {/* Pending friend requests */}
            {friendRequests.length > 0 && (
              <div className="flex flex-col gap-1">
                <p className="text-xs font-semibold text-muted-foreground px-1 mb-1">
                  Requests
                </p>
                {friendRequests.map((req) => (
                  <FriendRequestRow
                    key={req.id}
                    req={req}
                    onAccept={() => acceptRequest.mutate(req.id)}
                    onDecline={() => declineRequest.mutate(req.id)}
                  />
                ))}
              </div>
            )}

            {/* LAN peers */}
            {lanPeers.length > 0 && (
              <div className="flex flex-col gap-0.5">
                <p className="text-xs font-semibold text-muted-foreground px-1 mb-1">
                  On This Network
                </p>
                {lanPeers.map((p) => (
                  <PeerRow
                    key={p.publicKey}
                    peer={p}
                    selected={selectedPeerKey === p.publicKey}
                    onSelect={() => setSelectedPeerKey(p.publicKey)}
                  />
                ))}
              </div>
            )}

            {/* Friends */}
            {friendPeers.length > 0 && (
              <div className="flex flex-col gap-0.5">
                <p className="text-xs font-semibold text-muted-foreground px-1 mb-1">
                  Friends
                </p>
                {friendPeers.map((p) => (
                  <PeerRow
                    key={p.publicKey}
                    peer={p}
                    selected={selectedPeerKey === p.publicKey}
                    onSelect={() => setSelectedPeerKey(p.publicKey)}
                  />
                ))}
              </div>
            )}

            {/* Unknown online */}
            {unknownOnline.length > 0 && (
              <div className="flex flex-col gap-0.5">
                <p className="text-xs font-semibold text-muted-foreground px-1 mb-1">
                  Discovered
                </p>
                {unknownOnline.map((p) => (
                  <PeerRow
                    key={p.publicKey}
                    peer={p}
                    selected={selectedPeerKey === p.publicKey}
                    onSelect={() => setSelectedPeerKey(p.publicKey)}
                    onAddFriend={() => sendFriendRequest.mutate(p.publicKey)}
                  />
                ))}
              </div>
            )}

            {/* Empty state */}
            {!isLoading &&
              peers.length === 0 &&
              friendRequests.length === 0 && (
                <div className="flex flex-col items-center justify-center py-12 text-center gap-3">
                  <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center">
                    <Signal className="w-6 h-6 text-muted-foreground" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">No peers yet</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {isOnline ? "Searching…" : "Go online to discover peers"}
                    </p>
                  </div>
                  <Button size="sm" onClick={() => setShowAddFriend(true)}>
                    <UserPlus className="w-3.5 h-3.5 mr-1.5" />
                    Add a Friend
                  </Button>
                </div>
              )}
          </div>
        </div>
      )}

      {/* ── Right: Detail Panel ── */}
      <div className="flex-1 h-full overflow-hidden">
        {selectedPeer ? (
          <PeerDetailPanel
            peer={selectedPeer}
            onRemove={() => removeFriend.mutate(selectedPeer.publicKey)}
            onAddFriend={() => sendFriendRequest.mutate(selectedPeer.publicKey)}
            onRefresh={() => refreshPeer.mutate(selectedPeer.publicKey)}
            isRefreshing={refreshPeer.isPending}
          />
        ) : (
          <DiagnosticView />
        )}
      </div>

      {/* ── Add Friend Modal ── */}
      {showAddFriend && (
        <AddFriendModal onClose={() => setShowAddFriend(false)} />
      )}
    </div>
  );
}
