import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { DeviceIdentity } from "@/ipc/types/identity";
import { Monitor, Laptop, Server, Copy, Check, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { ipc } from "@/ipc/types";
import { queryKeys } from "@/lib/queryKeys";

const DEVICE_TYPES = [
  { value: "desktop" as const, label: "Desktop", icon: Monitor },
  { value: "laptop" as const, label: "Laptop", icon: Laptop },
  { value: "server" as const, label: "Server", icon: Server },
] as const;

export function AccountSettings() {
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState<"desktop" | "laptop" | "server">("desktop");
  const [showResetConfirm, setShowResetConfirm] = useState(false);

  const { data: identity, isLoading } = useQuery<DeviceIdentity>({
    queryKey: queryKeys.identity.device,
    queryFn: () => ipc.identity.get(),
  });

  useEffect(() => {
    if (identity) {
      setName(identity.deviceName);
      setType(identity.deviceType);
    }
  }, [identity]);

  const updateMutation = useMutation({
    mutationFn: () =>
      ipc.identity.updateDevice({ deviceName: name.trim(), deviceType: type }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.identity.all });
      setEditing(false);
      toast.success("Device updated");
    },
    onError: () => toast.error("Failed to update device"),
  });

  const resetMutation = useMutation({
    mutationFn: () => ipc.identity.reset(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.identity.all });
      setShowResetConfirm(false);
      toast.success("Identity reset — re-add friends to reconnect");
    },
  });

  const copyFingerprint = () => {
    if (!identity?.fingerprint) return;
    navigator.clipboard.writeText(identity.fingerprint);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading device info...
      </div>
    );
  }

  if (!identity) return null;

  const TypeIcon =
    DEVICE_TYPES.find((d) => d.value === identity.deviceType)?.icon ?? Monitor;

  return (
    <div className="flex flex-col gap-6 max-w-lg">
      {/* ── Device Identity ── */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            This Device
          </h3>
          {!editing && (
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
              Edit
            </Button>
          )}
        </div>

        <Card className="p-4 flex flex-col gap-4">
          {editing ? (
            <>
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">Device Name</label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">Device Type</label>
                <div className="flex gap-2">
                  {DEVICE_TYPES.map(({ value, label, icon: Icon }) => (
                    <button
                      key={value}
                      onClick={() => setType(value)}
                      className={`flex-1 flex flex-col items-center gap-1.5 py-2.5 rounded-lg border text-xs font-medium transition-colors ${
                        type === value
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border hover:border-primary/40 text-muted-foreground"
                      }`}
                    >
                      <Icon className="w-4 h-4" />
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={() => updateMutation.mutate()}
                  disabled={updateMutation.isPending || !name.trim()}
                >
                  {updateMutation.isPending ? "Saving..." : "Save"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setEditing(false);
                    setName(identity.deviceName);
                    setType(identity.deviceType);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </>
          ) : (
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center shrink-0">
                <TypeIcon className="w-5 h-5 text-muted-foreground" />
              </div>
              <div>
                <p className="font-medium">{identity.deviceName}</p>
                <p className="text-xs text-muted-foreground capitalize">
                  {identity.deviceType}
                </p>
              </div>
            </div>
          )}

          {identity.hardware && !editing && (
            <div className="flex flex-wrap gap-1.5 pt-1 border-t">
              <span className="text-xs px-2 py-0.5 rounded bg-muted">
                {identity.hardware.cpu}
              </span>
              <span className="text-xs px-2 py-0.5 rounded bg-muted">
                {identity.hardware.ramGB} GB RAM
              </span>
              {identity.hardware.gpu !== "Unknown" && (
                <span className="text-xs px-2 py-0.5 rounded bg-muted">
                  {identity.hardware.gpu}
                </span>
              )}
            </div>
          )}
        </Card>
      </section>

      {/* ── Public Key ── */}
      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
          Network Identity
        </h3>
        <Card className="p-4 flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">Public Key Fingerprint</p>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2"
              onClick={copyFingerprint}
            >
              {copied ? (
                <Check className="w-3.5 h-3.5 text-green-500" />
              ) : (
                <Copy className="w-3.5 h-3.5" />
              )}
            </Button>
          </div>
          <code className="text-sm font-mono bg-muted px-3 py-2 rounded select-all tracking-widest">
            {identity.fingerprint}
          </code>
          <p className="text-xs text-muted-foreground">
            This uniquely identifies your device on the Orion Network. Share it
            with friends to add you as a peer.
          </p>
        </Card>
      </section>

      {/* ── Danger Zone ── */}
      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold text-destructive uppercase tracking-wide">
          Danger Zone
        </h3>
        <Card className="p-4 border-destructive/20">
          {showResetConfirm ? (
            <div className="flex flex-col gap-3">
              <p className="text-sm font-medium text-destructive">
                This generates a new keypair. All peer connections break and
                must be re-established.
              </p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => resetMutation.mutate()}
                  disabled={resetMutation.isPending}
                >
                  {resetMutation.isPending
                    ? "Resetting..."
                    : "Yes, Reset Identity"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setShowResetConfirm(false)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium">Reset Identity</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Regenerate keypair — breaks existing peer connections
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="shrink-0 text-destructive border-destructive/30 hover:bg-destructive/10"
                onClick={() => setShowResetConfirm(true)}
              >
                Reset
              </Button>
            </div>
          )}
        </Card>
      </section>
    </div>
  );
}
