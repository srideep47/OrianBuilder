/**
 * Marta's own status, polled once for the whole shell.
 *
 * An atom rather than a hook-per-consumer: the orb, the ambient rail and the
 * settings surface all want it, and three independent `useQuery`s would mean
 * three polls and three chances to disagree about whether she is up.
 */

import { atom, useSetAtom } from "jotai";
import { useEffect } from "react";

import {
  ipc,
  type MartaModelStatus,
  type MartaNarrationDetail,
} from "@/ipc/types";

export const UNKNOWN_MODEL_STATUS: MartaModelStatus = {
  running: false,
  modelId: null,
  modelPath: null,
  placement: null,
  port: null,
  lastError: null,
};

export const martaModelStatusAtom =
  atom<MartaModelStatus>(UNKNOWN_MODEL_STATUS);

/**
 * How chatty Marta is allowed to be about work the user did not ask about.
 *
 * Mirrored into an atom rather than read per-consumer: the voice session needs
 * it synchronously inside a narration decision, and an async preference read at
 * that point would either block speech or race it.
 */
export const narrationDetailAtom = atom<MartaNarrationDetail>("normal");

/**
 * How often to re-check.
 *
 * Polled rather than pushed because the interesting transitions — a demotion to
 * CPU when a heavy model loads — originate deep in the gate, and threading an
 * event channel out through it for a status dot is not worth the coupling. Four
 * seconds is well inside the time it takes a user to notice she got slower.
 */
const POLL_MS = 4_000;

/** Mount once, near the root. */
export function useMartaStatusPoll(): void {
  const setStatus = useSetAtom(martaModelStatusAtom);
  const setNarrationDetail = useSetAtom(narrationDetailAtom);

  // Read once: the reporting preference changes only from Settings, which sets
  // the atom itself. Polling it would waste a round trip every four seconds.
  useEffect(() => {
    void ipc.marta
      .getPreferences()
      .then((preferences) => setNarrationDetail(preferences.narrationDetail))
      .catch(() => {
        // Keep the default until main is up.
      });
  }, [setNarrationDetail]);

  useEffect(() => {
    let cancelled = false;

    const tick = async () => {
      try {
        const status = await ipc.marta.getModelStatus();
        if (!cancelled) setStatus(status);
      } catch {
        // Main not ready yet, or the handler threw. The next tick retries;
        // resetting to "unknown" here would flicker the orb on any hiccup.
      }
    };

    void tick();
    const id = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [setStatus]);
}
