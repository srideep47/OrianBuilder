/**
 * Bridges llama-server's `/slots` endpoint into our in-process StatsTracker.
 *
 * llama-server publishes per-slot telemetry (timings, n_decoded, n_prompt_tokens,
 * is_processing flag) on `GET /slots`. We poll it while the server is running
 * and translate transitions into the same beginSession / recordTokenCount /
 * stopStatsBroadcast / setState calls the old in-process inference path used,
 * so the Inference Monitor UI keeps showing live tps / session counts / peak
 * tps / state without caring whether tokens were generated in this process or
 * in the child llama-server.
 *
 * Concurrency: we lock onto the slot with the highest `n_decoded` among
 * currently-processing slots (in practice the agent runs one slot at a time;
 * this is just defense against the multi-slot configuration llama-server
 * defaults to with `--parallel`).
 */

import http from "node:http";
import log from "electron-log";
import { statsTracker } from "@/ipc/utils/inference/stats_tracker";

const logger = log.scope("llama-server-stats");

const POLL_INTERVAL_MS = 400;
const REQUEST_TIMEOUT_MS = 750;

interface SlotTimings {
  prompt_n?: number;
  prompt_ms?: number;
  predicted_n?: number;
  predicted_ms?: number;
  predicted_per_second?: number;
}

interface Slot {
  id: number;
  is_processing?: boolean;
  n_prompt_tokens?: number;
  n_decoded?: number;
  timings?: SlotTimings;
}

interface SessionLockState {
  slotId: number;
  lastReportedDecoded: number;
  beginEmitted: boolean;
  promptTokens: number;
}

export class LlamaServerStatsPoller {
  private timer: NodeJS.Timeout | null = null;
  private host = "127.0.0.1";
  private port = 0;
  private inflight = false;
  private session: SessionLockState | null = null;

  start(host: string, port: number): void {
    this.stop();
    this.host = host;
    this.port = port;
    this.timer = setInterval(() => {
      if (this.inflight) return;
      this.inflight = true;
      this.tick().finally(() => {
        this.inflight = false;
      });
    }, POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.session) {
      statsTracker.stopStatsBroadcast();
      this.session = null;
    }
  }

  private async tick(): Promise<void> {
    let slots: Slot[];
    try {
      slots = await this.fetchSlots();
    } catch {
      // Transient — /slots is unavailable while llama-server is starting/stopping.
      return;
    }

    // Pick the slot we should track this tick. Priority order:
    //   1. The slot we already locked onto, if it's still around.
    //   2. The processing slot with the most decoded tokens (most progressed).
    const currentSession = this.session;
    let active: Slot | null = null;
    if (currentSession) {
      active = slots.find((s) => s.id === currentSession.slotId) ?? null;
    }
    if (!active || !active.is_processing) {
      active =
        slots
          .filter((s) => s.is_processing)
          .sort((a, b) => (b.n_decoded ?? 0) - (a.n_decoded ?? 0))[0] ?? null;
    }

    if (!active || !active.is_processing) {
      // No active processing — end any session we were tracking.
      if (this.session) {
        // Final flush: emit any remaining tokens we haven't reported yet.
        const totalDecoded = active?.n_decoded ?? 0;
        const delta = Math.max(
          0,
          totalDecoded - this.session.lastReportedDecoded,
        );
        if (delta > 0) statsTracker.recordTokenCount(delta);
        statsTracker.stopStatsBroadcast();
        this.session = null;
      }
      return;
    }

    // active.is_processing === true
    if (!this.session || this.session.slotId !== active.id) {
      // New session — close any prior one cleanly, then start fresh.
      if (this.session) statsTracker.stopStatsBroadcast();
      const promptTokens =
        active.n_prompt_tokens ?? active.timings?.prompt_n ?? 0;
      this.session = {
        slotId: active.id,
        lastReportedDecoded: 0,
        beginEmitted: false,
        promptTokens,
      };
      statsTracker.beginSession(promptTokens);
      statsTracker.setState("prefilling", "llama-server prefill…");
    }

    // Decoded-tokens delta → recordTokenCount.
    const decoded = active.n_decoded ?? active.timings?.predicted_n ?? 0;
    const delta = decoded - this.session.lastReportedDecoded;
    if (delta > 0) {
      statsTracker.recordTokenCount(delta);
      this.session.lastReportedDecoded = decoded;
      // First emitted decode token → transition to "generating".
      if (
        !this.session.beginEmitted &&
        statsTracker.getInferenceState() !== "generating"
      ) {
        statsTracker.setState("generating", "llama-server generating…");
        this.session.beginEmitted = true;
      }
    }
  }

  private fetchSlots(): Promise<Slot[]> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: this.host,
          port: this.port,
          path: "/slots",
          method: "GET",
          timeout: REQUEST_TIMEOUT_MS,
        },
        (res) => {
          if ((res.statusCode ?? 0) >= 400) {
            res.resume();
            reject(new Error(`/slots returned ${res.statusCode}`));
            return;
          }
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString());
              if (Array.isArray(body)) {
                resolve(body as Slot[]);
              } else {
                // Some llama-server builds wrap the array in an object.
                resolve(
                  Array.isArray(body?.slots) ? (body.slots as Slot[]) : [],
                );
              }
            } catch (err) {
              reject(err as Error);
            }
          });
        },
      );
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("/slots request timed out"));
      });
      req.end();
    });
  }
}

export const llamaServerStatsPoller = new LlamaServerStatsPoller();

/**
 * Forward a single llama-server stderr line into the engine-logs ring buffer
 * so the UI's "ENGINE LOGS" pane has something to show again. Lines like
 * `slot print_timing: ... prompt eval time = ...` carry useful diagnostics
 * even after we extract structured stats from /slots.
 */
export function forwardLlamaServerLog(
  level: "info" | "warn" | "error",
  line: string,
): void {
  if (!line.trim()) return;
  // Drop the high-precision millisecond clock prefix llama-server emits to
  // keep the log pane readable: "2.51.729.984 I srv  …" → "I srv  …".
  const stripped = line.replace(/^\d+\.\d+\.\d+\.\d+\s+/, "");
  statsTracker.emitLog(level, stripped);
  logger.silly?.(stripped);
}
