import { useCallback, useEffect, useRef, useState } from "react";
import {
  Rocket,
  CheckCircle2,
  XCircle,
  Loader2,
  CircleDashed,
  Cpu,
  Zap,
  Hand,
  RotateCw,
  Square,
  ChevronDown,
  ChevronRight,
  ArrowUpRight,
  Wand2,
} from "lucide-react";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { ipc } from "@/ipc/types";
import { orionSetupEventClient } from "@/ipc/types/orion_setup";
import type { OrionSetupState, OrionSetupStep } from "@/ipc/types/orion_setup";
import { showError } from "@/lib/toast";

/** Deep-link to the right setup screen for a `needs-action` step. Routes are a
 *  small known set so we keep TanStack's typed-route safety. */
function SetupActionLink({ route }: { route: string }) {
  const cls =
    "inline-flex items-center gap-1 rounded-3xl bg-white/[0.06] px-2 py-0.5 text-xs font-medium text-primary hover:bg-white/[0.1]";
  if (route === "/inference")
    return (
      <Link to="/inference" className={cls}>
        Open Engine <ArrowUpRight className="h-3 w-3" />
      </Link>
    );
  if (route === "/network")
    return (
      <Link to="/network" className={cls}>
        Open Network <ArrowUpRight className="h-3 w-3" />
      </Link>
    );
  return null;
}

function StepIcon({ status }: { status: OrionSetupStep["status"] }) {
  switch (status) {
    case "running":
      return <Loader2 className="h-4 w-4 animate-spin text-primary" />;
    case "done":
      return <CheckCircle2 className="h-4 w-4 text-emerald-400" />;
    case "failed":
      return <XCircle className="h-4 w-4 text-red-400" />;
    case "needs-action":
      return <ArrowUpRight className="h-4 w-4 text-amber-300" />;
    case "skipped":
      return <CircleDashed className="h-4 w-4 text-white/25" />;
    default:
      return <CircleDashed className="h-4 w-4 text-white/40" />;
  }
}

/**
 * Orion Setup: one-click, resumable provisioning of everything the auto
 * content-creation pipeline needs. The work runs in a persisted main-process
 * orchestrator, so progress survives reloads/restarts/dropped internet — this
 * panel just drives it and renders the live state streamed over `progress`.
 */
export function OrionSetupPanel() {
  const [state, setState] = useState<OrionSetupState | null>(null);
  const [includeEngine, setIncludeEngine] = useState(true);
  const [includeP2p, setIncludeP2p] = useState(true);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const feedRef = useRef<HTMLDivElement>(null);

  // Seed from current state, then keep live via the progress stream.
  useEffect(() => {
    let active = true;
    ipc.orionSetup
      .getState()
      .then((s) => {
        if (!active) return;
        setState(s);
        setIncludeEngine(s.includeEngine);
        setIncludeP2p(s.includeP2p);
        // Collapse once everything's ready; expand while there's work to do.
        setExpanded(s.overall !== "completed");
      })
      .catch(() => {
        /* non-fatal: panel just stays in its default state */
      });
    const off = orionSetupEventClient.onProgress((s) => {
      if (active) setState(s);
    });
    return () => {
      active = false;
      off();
    };
  }, []);

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
  }, [state?.log]);

  const run = useCallback(async (fn: () => Promise<OrionSetupState>) => {
    setBusy(true);
    try {
      setState(await fn());
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const overall = state?.overall ?? "idle";
  const isRunning = overall === "running";
  const isCompleted = overall === "completed";
  const steps = state?.steps ?? [];
  const failedRequired = steps.find((s) => s.required && s.status === "failed");

  // Collapsed "ready" chip.
  if (isCompleted && !expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="flex w-full items-center gap-2 rounded-2xl border border-emerald-500/20 bg-emerald-500/[0.06] px-4 py-3 text-left transition-colors hover:bg-emerald-500/[0.1]"
      >
        <CheckCircle2 className="h-4 w-4 text-emerald-400" />
        <span className="flex-1 text-sm font-medium text-emerald-200/90">
          Orion is ready — content commands run end-to-end.
        </span>
        <ChevronRight className="h-4 w-4 text-white/40" />
      </button>
    );
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
      <div className="mb-3 flex items-center gap-2">
        <div className="flex h-7 w-7 items-center justify-center rounded-2xl bg-primary/20 text-primary">
          <Rocket className="h-4 w-4" />
        </div>
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-white/90">Set up Orion</h3>
          <p className="text-xs text-white/50">
            {isCompleted
              ? "Everything's installed — re-run any step below if needed."
              : "Installs the media backend, your models, the local LLM & P2P — resumes if interrupted."}
          </p>
        </div>
        {state?.hardwareSummary && (
          <span
            className="inline-flex items-center gap-1 rounded-full bg-black/30 px-2.5 py-1 text-xs text-white/60"
            title="Detected hardware"
          >
            <Cpu className="h-3 w-3" />
            {state.hardwareSummary}
          </span>
        )}
        {isCompleted && (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            className="text-white/40 hover:text-white/70"
            title="Collapse"
          >
            <ChevronDown className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Scope toggles + primary action (hidden once a run is underway) */}
      {(overall === "idle" || isCompleted) && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setIncludeEngine((v) => !v)}
            disabled={busy}
            className={
              "inline-flex items-center gap-1 rounded-3xl px-2.5 py-1 text-xs transition-colors " +
              (includeEngine
                ? "bg-primary/20 text-primary"
                : "bg-black/20 text-white/50 hover:text-white/80")
            }
          >
            <Zap className="h-3.5 w-3.5" />
            Local LLM
          </button>
          <button
            type="button"
            onClick={() => setIncludeP2p((v) => !v)}
            disabled={busy}
            className={
              "inline-flex items-center gap-1 rounded-3xl px-2.5 py-1 text-xs transition-colors " +
              (includeP2p
                ? "bg-primary/20 text-primary"
                : "bg-black/20 text-white/50 hover:text-white/80")
            }
          >
            <Hand className="h-3.5 w-3.5" />
            Pair a teammate
          </button>
          <div className="flex-1" />
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() =>
              void run(() =>
                ipc.orionSetup.start({ includeEngine, includeP2p }),
              )
            }
            className="gap-1.5"
          >
            <Wand2 className="h-4 w-4" />
            {isCompleted ? "Run setup again" : "Set up Orion"}
          </Button>
        </div>
      )}

      {/* Run controls */}
      {(isRunning || overall === "paused") && (
        <div className="mb-3 flex items-center gap-2">
          {overall === "paused" && (
            <Button
              type="button"
              size="sm"
              disabled={busy}
              onClick={() => void run(() => ipc.orionSetup.resume())}
              className="gap-1.5"
            >
              <RotateCw className="h-4 w-4" />
              Resume setup
            </Button>
          )}
          {isRunning && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void run(() => ipc.orionSetup.cancel())}
              className="gap-1.5 text-white/60"
            >
              <Square className="h-3.5 w-3.5" />
              Cancel
            </Button>
          )}
          {failedRequired && (
            <span className="text-xs text-red-300/80">
              {failedRequired.label} failed — resume to retry.
            </span>
          )}
        </div>
      )}

      {/* Step checklist */}
      <ul className="flex flex-col gap-1.5">
        {steps.map((step) => (
          <li
            key={step.id}
            className="rounded-2xl bg-white/[0.03] px-2.5 py-1.5 text-sm"
          >
            <div className="flex items-center gap-2">
              <StepIcon status={step.status} />
              <span className="flex-1 text-white/80">
                {step.label}
                {!step.required && (
                  <span className="ml-1.5 text-xs text-white/35">
                    (optional)
                  </span>
                )}
              </span>
              {step.status === "needs-action" && step.actionRoute && (
                <SetupActionLink route={step.actionRoute} />
              )}
              {step.status === "failed" && !isRunning && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(() =>
                      ipc.orionSetup.retryStep({ stepId: step.id }),
                    )
                  }
                  className="rounded-3xl bg-white/[0.06] px-2 py-0.5 text-xs text-white/70 hover:bg-white/[0.1]"
                >
                  Retry
                </button>
              )}
              {!step.required &&
                step.status === "needs-action" &&
                !isRunning && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        ipc.orionSetup.skipStep({ stepId: step.id }),
                      )
                    }
                    className="text-xs text-white/35 hover:text-white/60"
                  >
                    Skip
                  </button>
                )}
            </div>
            {(step.detail || step.error) && (
              <div
                className={
                  "mt-1 pl-6 text-xs " +
                  (step.error ? "text-red-300/80" : "text-white/40")
                }
              >
                {step.error ?? step.detail}
              </div>
            )}
            {step.status === "running" && step.percent != null && (
              <div className="mt-1 ml-6 h-1.5 overflow-hidden rounded-full bg-black/30">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${step.percent}%` }}
                />
              </div>
            )}
          </li>
        ))}
      </ul>

      {/* Live activity feed */}
      {state && state.log.length > 0 && (
        <div
          ref={feedRef}
          className="mt-3 max-h-32 overflow-y-auto rounded-2xl border border-white/10 bg-black/30 p-2 font-mono text-[11px] leading-relaxed text-white/45"
        >
          {state.log.map((line, i) => (
            <div key={i} className="break-all">
              {line}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
