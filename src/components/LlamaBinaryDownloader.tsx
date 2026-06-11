import { useState, useEffect } from "react";
import { ipc } from "@/ipc/types";
import type { LlamaBinaryDownloadProgress } from "@/ipc/types/llama_binary";
import { Button } from "@/components/ui/button";
import { Download, Cpu, CheckCircle2, XCircle, RotateCcw } from "lucide-react";

type Phase = "idle" | "downloading" | "done" | "error";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function LlamaBinaryDownloader() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<LlamaBinaryDownloadProgress | null>(
    null,
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(5);

  // Subscribe to progress events from main process
  useEffect(() => {
    const unsub = ipc.events.llamaBinary.onProgress((p) => {
      setProgress(p);
      if (p.stage === "done") setPhase("done");
    });
    return unsub;
  }, []);

  // Auto-restart countdown after successful download
  useEffect(() => {
    if (phase !== "done") return;
    setCountdown(5);
    const timer = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          clearInterval(timer);
          ipc.llamaBinary.restart();
          return 0;
        }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [phase]);

  const handleDownload = async () => {
    setPhase("downloading");
    setErrorMsg(null);
    setProgress(null);
    try {
      const result = await ipc.llamaBinary.download();
      if (!result.ok) {
        setPhase("error");
        setErrorMsg(result.error ?? "Download failed.");
      }
      // On success the progress event sets phase → "done"
    } catch (err: any) {
      setPhase("error");
      setErrorMsg(String(err?.message ?? err));
    }
  };

  const handleAbort = async () => {
    await ipc.llamaBinary.abort();
    setPhase("idle");
    setProgress(null);
  };

  const handleRestartNow = () => ipc.llamaBinary.restart();

  const handleRestartLater = () => {
    setPhase("idle");
    setProgress(null);
  };

  return (
    <div className="w-full max-w-lg mx-auto">
      <div className="rounded-2xl border border-white/10 bg-[oklch(0.10_0.018_280/0.88)] backdrop-filter backdrop-blur-2xl shadow-2xl p-8 space-y-6">
        {/* Header */}
        <div className="flex items-start gap-4">
          <div className="flex-shrink-0 w-11 h-11 rounded-3xl bg-indigo-500/15 border border-indigo-400/20 flex items-center justify-center">
            <Cpu className="w-5 h-5 text-indigo-300" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-white/90">
              Inference Engine Required
            </h2>
            <p className="mt-0.5 text-sm text-white/50">
              llama-server binary not found.
            </p>
          </div>
        </div>

        {/* Explanation */}
        {phase === "idle" && (
          <p className="text-sm text-white/60 leading-relaxed">
            OrianBuilder runs local AI models using{" "}
            <span className="text-white/80 font-medium">llama.cpp</span> — a
            fast open-source inference engine. The binary ({" "}
            <span className="font-mono text-[11px] text-indigo-300">
              llama-server.exe
            </span>
            ) needs to be downloaded once (~300 MB) and will be stored locally.
          </p>
        )}

        {/* Progress section */}
        {(phase === "downloading" || progress) &&
          phase !== "done" &&
          phase !== "error" && (
            <div className="space-y-3">
              <div className="flex justify-between items-center text-xs">
                <span className="text-white/60">
                  {progress?.label ?? "Preparing…"}
                </span>
                <span className="text-white/80 font-medium tabular-nums">
                  {progress ? `${Math.round(progress.percent)}%` : "0%"}
                </span>
              </div>
              <div className="h-2 rounded-full bg-white/8 overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-blue-400 transition-all duration-300 ease-out"
                  style={{ width: `${progress?.percent ?? 0}%` }}
                />
              </div>
              {progress && progress.totalBytes > 0 && (
                <p className="text-[11px] text-white/40 tabular-nums">
                  {formatBytes(progress.bytesDownloaded)} /{" "}
                  {formatBytes(progress.totalBytes)}
                </p>
              )}
            </div>
          )}

        {/* Done state */}
        {phase === "done" && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-emerald-400 text-sm font-medium">
              <CheckCircle2 className="w-4 h-4" />
              Download complete!
            </div>
            <div className="h-2 rounded-full bg-white/8 overflow-hidden">
              <div className="h-full w-full rounded-full bg-gradient-to-r from-emerald-500 to-green-400" />
            </div>
            <p className="text-xs text-white/50">
              A restart is required to load the inference engine.
              Auto-restarting in{" "}
              <span className="text-white/80 font-medium tabular-nums">
                {countdown}s
              </span>
              …
            </p>
          </div>
        )}

        {/* Error state */}
        {phase === "error" && errorMsg && (
          <div className="rounded-2xl bg-red-500/10 border border-red-500/20 p-3 space-y-1">
            <div className="flex items-center gap-2 text-red-400 text-sm font-medium">
              <XCircle className="w-4 h-4 shrink-0" />
              Download failed
            </div>
            <p className="text-[11px] text-red-300/70 leading-snug pl-6">
              {errorMsg}
            </p>
          </div>
        )}

        {/* Action buttons */}
        <div className="flex items-center gap-3">
          {phase === "idle" && (
            <Button
              onClick={handleDownload}
              className="flex-1 gap-2 bg-indigo-600 hover:bg-indigo-500 text-white border-0"
            >
              <Download className="w-4 h-4" />
              Download Inference Engine
            </Button>
          )}

          {phase === "downloading" && (
            <Button
              onClick={handleAbort}
              variant="outline"
              className="flex-1 gap-2"
            >
              Cancel
            </Button>
          )}

          {phase === "done" && (
            <>
              <Button
                onClick={handleRestartNow}
                className="flex-1 gap-2 bg-indigo-600 hover:bg-indigo-500 text-white border-0"
              >
                <RotateCcw className="w-4 h-4" />
                Restart Now
              </Button>
              <Button
                onClick={handleRestartLater}
                variant="outline"
                className="gap-2"
              >
                Later
              </Button>
            </>
          )}

          {phase === "error" && (
            <Button
              onClick={handleDownload}
              className="flex-1 gap-2 bg-indigo-600 hover:bg-indigo-500 text-white border-0"
            >
              <RotateCcw className="w-4 h-4" />
              Retry Download
            </Button>
          )}
        </div>

        {phase === "idle" && (
          <p className="text-[11px] text-white/30 text-center">
            Source: github.com/ggerganov/llama.cpp · latest release
          </p>
        )}
      </div>
    </div>
  );
}
