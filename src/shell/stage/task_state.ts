import { atom } from "jotai";

/** The delegated task whose workspace and telemetry are currently emphasised. */
export const focusedTaskIdAtom = atom<string | null>(null);
