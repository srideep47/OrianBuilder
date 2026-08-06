/**
 * Starting, stopping and placing Marta.
 *
 * This exists because without it she is unreachable. The composer tells the
 * user to "open Settings to start her" and, until this landed, there was
 * nothing there — the only control lived on a debug page the plan says to
 * delete. An orchestrator you cannot turn on is not a feature.
 *
 * It is also the only place the ladder's reasoning is visible: which rung this
 * machine earned, why, and whether she is currently holding the GPU or has been
 * pushed off it.
 */

import { useCallback, useEffect, useState } from "react";
import { useAtom, useSetAtom } from "jotai";
import { Cpu, Loader2, Play, Square } from "lucide-react";

import { ipc, type MartaPreferences, type MartaResidency } from "@/ipc/types";
import {
  martaModelStatusAtom,
  narrationDetailAtom,
} from "@/shell/stage/presence_state";
import { LBadge, LButton, Segmented } from "@/components/liquid";
import { showError } from "@/lib/toast";

export function MartaSettings() {
  const [model, setModel] = useAtom(martaModelStatusAtom);
  const [residency, setResidency] = useState<MartaResidency | null>(null);
  const [preferences, setPreferences] = useState<MartaPreferences | null>(null);
  const [busy, setBusy] = useState(false);
  // Mirrored into the atom the voice session reads synchronously, so a change
  // here takes effect on the very next narration rather than after a reload.
  const setNarrationDetail = useSetAtom(narrationDetailAtom);

  useEffect(() => {
    void ipc.marta
      .getResidency()
      .then(setResidency)
      .catch(() => setResidency(null));
    void ipc.marta
      .getPreferences()
      .then(setPreferences)
      .catch(() => setPreferences(null));
  }, []);

  const run = useCallback(
    async (action: () => Promise<typeof model>) => {
      setBusy(true);
      try {
        setModel(await action());
      } catch (error) {
        // Surfaced rather than swallowed: the commonest failure is "the model
        // is not downloaded", and the message names the exact directory.
        showError(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
    },
    [setModel],
  );

  const plan = residency?.plan;

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">Marta</span>
            {model.running ? (
              <LBadge
                tone={model.placement === "cpu" ? "warning" : "success"}
                dot
              >
                {model.placement === "cpu" ? "on CPU" : "on GPU"}
              </LBadge>
            ) : (
              <LBadge tone="neutral" dot>
                stopped
              </LBadge>
            )}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {plan ? plan.rationale : "Working out what this machine can run…"}
          </p>
          {model.running && model.modelId && (
            <p className="mt-1 font-mono text-[11px] text-muted-foreground/70">
              {model.modelId} · port {model.port}
            </p>
          )}
          {!model.running && model.lastError && (
            <p className="mt-1 text-[12px] text-[var(--cosmos-red)]">
              {model.lastError}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {model.running ? (
            <LButton
              tone="ghost"
              size="compact"
              icon={busy ? <Loader2 className="animate-spin" /> : <Square />}
              disabled={busy}
              onClick={() => void run(() => ipc.marta.stopModel())}
            >
              Stop
            </LButton>
          ) : (
            <LButton
              tone="primary"
              size="compact"
              icon={busy ? <Loader2 className="animate-spin" /> : <Play />}
              disabled={busy}
              onClick={() => void run(() => ipc.marta.startModel())}
            >
              Start
            </LButton>
          )}
        </div>
      </div>

      {model.running && (
        <div className="flex items-center gap-3">
          <Cpu className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <Segmented
            aria-label="Where Marta runs"
            size="compact"
            options={[
              { value: "gpu", label: "Use the GPU" },
              { value: "cpu", label: "Stay on CPU" },
            ]}
            value={model.placement ?? "gpu"}
            onChange={(placement) =>
              void run(() => ipc.marta.setPlacement({ placement }))
            }
          />
          <span className="text-[12px] text-muted-foreground">
            {/* "Stay on CPU" is a preference the gate will not undo, which is
                the distinction worth spelling out — it is not the same as the
                temporary demotion that happens when a heavy model loads. */}
            Keeping her on the CPU frees her VRAM for generation, permanently,
            until you change it back.
          </span>
        </div>
      )}

      {preferences && (
        <div className="flex items-start gap-3 border-t border-white/[0.07] pt-3">
          <div className="min-w-0 flex-1">
            <p className="text-[12px] font-medium text-foreground">
              Coding delegation
            </p>
            <p className="mt-0.5 text-[11px] leading-[1.45] text-muted-foreground">
              Ask every time is the safe default. A remembered worker keeps its
              exact local model or Claude model and effort.
            </p>
            {(preferences.localModel || preferences.claudeModel) && (
              <p className="mt-1 font-mono text-[10px] text-muted-foreground/70">
                Local: {preferences.localModel ?? "not chosen"} · Claude:{" "}
                {preferences.claudeModel ?? "not chosen"} · Effort:{" "}
                {preferences.claudeEffort ?? "medium"}
              </p>
            )}
          </div>
          <select
            value={preferences.codingWorker}
            onChange={(event) => {
              const codingWorker = event.target
                .value as MartaPreferences["codingWorker"];
              void ipc.marta
                .setPreferences({ codingWorker })
                .then(setPreferences)
                .catch((error) =>
                  showError(
                    error instanceof Error ? error.message : String(error),
                  ),
                );
            }}
            className="h-8 shrink-0 rounded-[9px] border border-white/10 bg-black/20 px-2 text-[11px] text-foreground outline-none focus:border-primary/45"
            aria-label="Default coding worker"
          >
            <option value="ask">Ask every time</option>
            <option value="local" disabled={!preferences.localModel}>
              Last local model
            </option>
            <option value="claude" disabled={!preferences.claudeModel}>
              Last Claude setup
            </option>
          </select>
        </div>
      )}

      {preferences && (
        <div className="flex items-start gap-3 border-t border-white/[0.07] pt-3">
          <div className="min-w-0 flex-1">
            <p className="text-[12px] font-medium text-foreground">
              Proactive reporting
            </p>
            <p className="mt-0.5 text-[11px] leading-[1.45] text-muted-foreground">
              How much Marta says about work you did not just ask about. Quiet
              still announces failures out loud — every update is written to the
              transcript regardless.
            </p>
          </div>
          <select
            value={preferences.narrationDetail}
            onChange={(event) => {
              const narrationDetail = event.target
                .value as MartaPreferences["narrationDetail"];
              setNarrationDetail(narrationDetail);
              void ipc.marta
                .setPreferences({ narrationDetail })
                .then(setPreferences)
                .catch((error) =>
                  showError(
                    error instanceof Error ? error.message : String(error),
                  ),
                );
            }}
            className="h-8 shrink-0 rounded-[9px] border border-white/10 bg-black/20 px-2 text-[11px] text-foreground outline-none focus:border-primary/45"
            aria-label="Proactive reporting detail"
          >
            <option value="quiet">Quiet — failures only</option>
            <option value="normal">Normal — milestones</option>
            <option value="detailed">Detailed — every step</option>
          </select>
        </div>
      )}
    </div>
  );
}
