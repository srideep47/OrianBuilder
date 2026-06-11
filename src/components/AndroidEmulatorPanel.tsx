import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ipc } from "@/ipc/types";
import type { AndroidSetupProgress } from "@/ipc/types/android_emulator";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { showError, showSuccess } from "@/lib/toast";
import {
  Smartphone,
  Download,
  Play,
  Square,
  Loader2,
  CheckCircle2,
  XCircle,
  Hammer,
} from "lucide-react";

interface AndroidEmulatorPanelProps {
  appId: number;
}

type Phase = "idle" | "downloading" | "error";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function AndroidEmulatorPanel({ appId }: AndroidEmulatorPanelProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<AndroidSetupProgress | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isLaunching, setIsLaunching] = useState(false);
  const [isBuilding, setIsBuilding] = useState(false);
  const [buildLine, setBuildLine] = useState("");

  // Locate a built APK for this app — the Launch action is enabled once found.
  const { data: apk, refetch: refetchApk } = useQuery({
    queryKey: ["androidEmulator", "findApk", appId],
    queryFn: () => ipc.androidEmulator.findApk({ appId }),
    enabled: appId !== undefined && appId !== null,
  });

  const {
    data: status,
    refetch: refetchStatus,
    isLoading: isStatusLoading,
  } = useQuery({
    queryKey: ["androidEmulator", "status"],
    queryFn: () => ipc.androidEmulator.getStatus(),
    refetchInterval: 5000,
  });

  // Subscribe to setup progress events from the main process.
  useEffect(() => {
    const unsub = ipc.events.androidEmulator.onSetupProgress((p) => {
      setProgress(p);
      if (p.stage === "done") {
        setPhase("idle");
        void refetchStatus();
      }
    });
    return unsub;
  }, [refetchStatus]);

  // Stream Gradle build log lines from the main process.
  useEffect(() => {
    const unsub = ipc.events.androidEmulator.onBuildLog((p) => {
      setBuildLine(p.line);
    });
    return unsub;
  }, []);

  const handleBuild = async () => {
    setIsBuilding(true);
    setBuildLine("Starting build…");
    try {
      const result = await ipc.androidEmulator.buildApk({ appId });
      if (!result.ok) {
        showError(result.error ?? "Build failed.");
      } else {
        showSuccess("Debug APK built");
        await refetchApk();
      }
    } catch (err) {
      showError(err);
    } finally {
      setIsBuilding(false);
      setBuildLine("");
    }
  };

  const handleCancelBuild = async () => {
    await ipc.androidEmulator.abortBuild();
    setIsBuilding(false);
    setBuildLine("");
  };

  const handleSetup = async () => {
    setPhase("downloading");
    setErrorMsg(null);
    setProgress(null);
    try {
      const result = await ipc.androidEmulator.setup();
      if (!result.ok) {
        setPhase("error");
        setErrorMsg(result.error ?? "Download failed.");
      } else {
        setPhase("idle");
        showSuccess("Android runtime ready");
        await refetchStatus();
      }
    } catch (err: any) {
      setPhase("error");
      setErrorMsg(String(err?.message ?? err));
    }
  };

  const handleCancel = async () => {
    await ipc.androidEmulator.abort();
    setPhase("idle");
    setProgress(null);
  };

  const handleLaunch = async () => {
    if (!apk?.apkPath) return;
    setIsLaunching(true);
    try {
      const result = await ipc.androidEmulator.launchAndInstall({
        apkPath: apk.apkPath,
        packageId: apk.packageId,
      });
      if (!result.ok) {
        showError(result.error ?? "Failed to launch app in emulator.");
      } else {
        showSuccess("App installed and launched in the emulator");
      }
      await refetchStatus();
    } catch (err) {
      showError(err);
    } finally {
      setIsLaunching(false);
    }
  };

  const handleStop = async () => {
    await ipc.androidEmulator.stop();
    await refetchStatus();
  };

  // The card always renders so the feature is discoverable. The Launch action
  // is enabled only once a built APK is found for this app.
  const hasApk = !!apk?.apkPath;
  const ready = !!status?.sdkReady && !!status?.imageReady;
  const running = !!status?.emulatorRunning;

  return (
    <Card className="mt-1" data-testid="android-emulator-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Smartphone className="h-4 w-4" />
          Android Test
        </CardTitle>
        <CardDescription>
          Run this app on a managed Android emulator — no Android SDK install
          required.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {ready && !hasApk && !isBuilding && (
          <p
            className="text-xs text-muted-foreground"
            data-testid="android-emulator-no-apk"
          >
            No Android build yet. Click{" "}
            <span className="font-medium">Build APK</span> to compile a debug
            build directly — no Android Studio needed — then launch it in the
            emulator.
          </p>
        )}

        {/* Live Gradle build log */}
        {isBuilding && (
          <div className="space-y-1" data-testid="android-emulator-building">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Building debug APK… (the first build downloads Gradle, ~a few
              minutes)
            </div>
            <p className="text-[11px] text-muted-foreground font-mono truncate">
              {buildLine}
            </p>
          </div>
        )}
        {/* Download / setup state */}
        {phase === "downloading" && (
          <div className="space-y-2" data-testid="android-emulator-progress">
            <div className="flex justify-between items-center text-xs">
              <span className="text-muted-foreground">
                {progress?.label ?? "Preparing…"}
              </span>
              <span className="font-medium tabular-nums">
                {progress ? `${Math.round(progress.percent)}%` : "0%"}
              </span>
            </div>
            <div className="h-2 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full bg-indigo-500 transition-all duration-300 ease-out"
                style={{ width: `${progress?.percent ?? 0}%` }}
              />
            </div>
            {progress && progress.totalBytes > 0 && (
              <p className="text-[11px] text-muted-foreground tabular-nums">
                {formatBytes(progress.bytesDownloaded)} /{" "}
                {formatBytes(progress.totalBytes)}
              </p>
            )}
          </div>
        )}

        {phase === "error" && errorMsg && (
          <div className="rounded-3xl bg-red-500/10 border border-red-500/20 p-3">
            <div className="flex items-center gap-2 text-red-500 text-sm font-medium">
              <XCircle className="h-4 w-4 shrink-0" />
              Setup failed
            </div>
            <p className="text-xs text-red-400 mt-1 pl-6 leading-snug">
              {errorMsg}
            </p>
          </div>
        )}

        {phase === "idle" && ready && (
          <div className="flex items-center gap-2 text-emerald-500 text-xs font-medium">
            <CheckCircle2 className="h-4 w-4" />
            Android runtime ready
            {running && (
              <span className="text-muted-foreground font-normal">
                · emulator running
              </span>
            )}
          </div>
        )}

        {/* Action buttons */}
        <div className="flex items-center gap-2">
          {phase === "downloading" ? (
            <Button
              onClick={handleCancel}
              variant="outline"
              size="sm"
              className="flex-1"
            >
              Cancel
            </Button>
          ) : !ready ? (
            <Button
              onClick={handleSetup}
              size="sm"
              className="flex-1 gap-2"
              disabled={isStatusLoading}
              data-testid="android-emulator-download-button"
            >
              <Download className="h-4 w-4" />
              {phase === "error"
                ? "Retry Download"
                : "Download Android Runtime"}
              <span className="text-xs opacity-70">(~1.5 GB)</span>
            </Button>
          ) : isBuilding ? (
            <Button
              onClick={handleCancelBuild}
              variant="outline"
              size="sm"
              className="flex-1"
            >
              Cancel Build
            </Button>
          ) : !hasApk ? (
            <Button
              onClick={handleBuild}
              size="sm"
              className="flex-1 gap-2"
              data-testid="android-emulator-build-button"
            >
              <Hammer className="h-4 w-4" />
              Build APK
            </Button>
          ) : (
            <>
              <Button
                onClick={handleLaunch}
                size="sm"
                className="flex-1 gap-2"
                disabled={isLaunching}
                data-testid="android-emulator-launch-button"
              >
                {isLaunching ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Play className="h-4 w-4" />
                )}
                {isLaunching ? "Launching…" : "Launch in Emulator"}
              </Button>
              <Button
                onClick={handleBuild}
                variant="outline"
                size="sm"
                className="gap-2"
                title="Rebuild the debug APK"
              >
                <Hammer className="h-4 w-4" />
                Rebuild
              </Button>
              {running && (
                <Button
                  onClick={handleStop}
                  variant="outline"
                  size="sm"
                  className="gap-2"
                >
                  <Square className="h-4 w-4" />
                  Stop
                </Button>
              )}
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
