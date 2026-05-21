import { useState, useEffect } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { DeviceIdentity } from "@/ipc/types/identity";
import {
  Monitor,
  Laptop,
  Server,
  Copy,
  Check,
  Network,
  Loader2,
} from "lucide-react";
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
];

function StepDots({ total, current }: { total: number; current: number }) {
  return (
    <div className="flex items-center gap-2 justify-center mb-8">
      {Array.from({ length: total }).map((_, i) => (
        <div
          key={i}
          className={`rounded-full transition-all ${
            i + 1 === current
              ? "w-8 h-2 bg-primary"
              : i + 1 < current
                ? "w-2 h-2 bg-primary/50"
                : "w-2 h-2 bg-muted"
          }`}
        />
      ))}
    </div>
  );
}

export default function OnboardingPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [step, setStep] = useState(1);
  const [deviceName, setDeviceName] = useState("");
  const [deviceType, setDeviceType] = useState<"desktop" | "laptop" | "server">(
    "desktop",
  );
  const [joinNetwork, setJoinNetwork] = useState(true);
  const [copied, setCopied] = useState(false);

  const { data: identity } = useQuery<DeviceIdentity>({
    queryKey: queryKeys.identity.device,
    queryFn: () => ipc.identity.get(),
  });

  useEffect(() => {
    if (identity && !deviceName) {
      setDeviceName(identity.deviceName);
      setDeviceType(identity.deviceType);
    }
  }, [identity]);

  const updateDevice = useMutation({
    mutationFn: (p: {
      deviceName: string;
      deviceType: "desktop" | "laptop" | "server";
    }) => ipc.identity.updateDevice(p),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.identity.all }),
  });

  const handleNext = async () => {
    if (!deviceName.trim()) {
      toast.error("Please enter a device name");
      return;
    }
    await updateDevice.mutateAsync({
      deviceName: deviceName.trim(),
      deviceType,
    });
    setStep(2);
  };

  const handleFinish = async () => {
    await ipc.settings.setUserSettings({
      onboardingCompleted: true,
      orionNetworkEnabled: joinNetwork,
    } as Parameters<typeof ipc.settings.setUserSettings>[0]);
    navigate({ to: "/" });
  };

  const copyFingerprint = () => {
    if (identity?.fingerprint) {
      navigator.clipboard.writeText(identity.fingerprint);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="flex items-center justify-center w-full h-full bg-background px-4">
      <div className="w-full max-w-md">
        {/* ── Step 1: Device Setup ── */}
        {step === 1 && (
          <div className="flex flex-col gap-6">
            <StepDots total={2} current={1} />

            <div className="text-center">
              <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-primary/10 mb-4">
                <Network className="w-7 h-7 text-primary" />
              </div>
              <h1 className="text-2xl font-bold">Welcome to OrionBuilder</h1>
              <p className="text-sm text-muted-foreground mt-1">
                Set up your device identity — this is how your peers will see
                you on the network.
              </p>
            </div>

            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">Device Name</label>
                <Input
                  value={deviceName}
                  onChange={(e) => setDeviceName(e.target.value)}
                  placeholder="e.g. Srideep's PC"
                  onKeyDown={(e) => e.key === "Enter" && handleNext()}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium">Device Type</label>
                <div className="flex gap-2">
                  {DEVICE_TYPES.map(({ value, label, icon: Icon }) => (
                    <button
                      key={value}
                      onClick={() => setDeviceType(value)}
                      className={`flex-1 flex flex-col items-center gap-2 py-3 rounded-lg border text-sm font-medium transition-colors ${
                        deviceType === value
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

              {identity?.hardware && (
                <Card className="p-3 bg-muted/30 flex flex-wrap gap-1.5">
                  <span className="text-xs text-muted-foreground w-full mb-0.5">
                    Auto-detected hardware
                  </span>
                  <span className="text-xs px-2 py-0.5 rounded bg-background border">
                    {identity.hardware.cpu}
                  </span>
                  <span className="text-xs px-2 py-0.5 rounded bg-background border">
                    {identity.hardware.ramGB} GB RAM
                  </span>
                  {identity.hardware.gpu !== "Unknown" && (
                    <span className="text-xs px-2 py-0.5 rounded bg-background border">
                      {identity.hardware.gpu}
                    </span>
                  )}
                </Card>
              )}
            </div>

            <Button
              className="w-full"
              onClick={handleNext}
              disabled={updateDevice.isPending || !deviceName.trim()}
            >
              {updateDevice.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  Saving...
                </>
              ) : (
                "Next →"
              )}
            </Button>
          </div>
        )}

        {/* ── Step 2: Network Setup ── */}
        {step === 2 && (
          <div className="flex flex-col gap-6">
            <StepDots total={2} current={2} />

            <div className="text-center">
              <h2 className="text-2xl font-bold">Join the Network</h2>
              <p className="text-sm text-muted-foreground mt-1">
                Share compute with friends over a secure P2P connection.
              </p>
            </div>

            <Card className="p-4 flex items-center justify-between gap-4">
              <div>
                <p className="font-medium text-sm">Enable Orion Network</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Discover peers on LAN and internet via Hyperswarm
                </p>
              </div>
              <button
                onClick={() => setJoinNetwork((v) => !v)}
                className={`relative shrink-0 w-11 h-6 rounded-full transition-colors ${
                  joinNetwork ? "bg-primary" : "bg-muted-foreground/30"
                }`}
              >
                <span
                  className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full shadow-sm transition-transform ${
                    joinNetwork ? "translate-x-5" : "translate-x-0"
                  }`}
                />
              </button>
            </Card>

            {identity && (
              <Card className="p-4 flex flex-col gap-2">
                <p className="text-xs font-medium text-muted-foreground">
                  Your Public Key Fingerprint
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 text-sm font-mono bg-muted px-3 py-1.5 rounded select-all tracking-widest">
                    {identity.fingerprint}
                  </code>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="shrink-0"
                    onClick={copyFingerprint}
                  >
                    {copied ? (
                      <Check className="w-4 h-4 text-green-500" />
                    ) : (
                      <Copy className="w-4 h-4" />
                    )}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Share this with friends so they can add you. It uniquely
                  identifies this device.
                </p>
              </Card>
            )}

            <div className="flex gap-2">
              <Button
                variant="ghost"
                onClick={() => setStep(1)}
                className="flex-1"
              >
                ← Back
              </Button>
              <Button className="flex-1" onClick={handleFinish}>
                Launch OrionBuilder
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
