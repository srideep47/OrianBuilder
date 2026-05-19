import { atom } from "jotai";
import type { App, Version, ConsoleEntry } from "@/ipc/types";
import type { RuntimeMode2, UserSettings } from "@/lib/schemas";

export const currentAppAtom = atom<App | null>(null);
export const selectedAppIdAtom = atom<number | null>(null);
export const versionsListAtom = atom<Version[]>([]);
export const previewModeAtom = atom<
  | "preview"
  | "code"
  | "problems"
  | "configure"
  | "publish"
  | "security"
  | "plan"
>("preview");
export const selectedVersionIdAtom = atom<string | null>(null);

/**
 * Upper bound on retained console entries per app. A long agent run
 * (`npm install`, llama-server stats, Vite HMR, capacitor sync, etc.) can
 * push tens of thousands of log lines through the renderer in a single
 * turn. Combined with the quadratic copy in `[...prev, entry]`, this
 * routinely OOM'd the renderer process (~4GB heap → render-process-gone).
 * Anything older than this is dropped before the array hits memory.
 */
export const MAX_CONSOLE_ENTRIES = 2_000;

const _rawConsoleEntriesAtom = atom<ConsoleEntry[]>([]);

/**
 * Write proxy for `_rawConsoleEntriesAtom` that always trims to
 * MAX_CONSOLE_ENTRIES. Use this instead of `setAtom(rawAtom, ...)` directly
 * so every call site benefits from the cap.
 */
export const appConsoleEntriesAtom = atom(
  (get) => get(_rawConsoleEntriesAtom),
  (
    get,
    set,
    update: ConsoleEntry[] | ((prev: ConsoleEntry[]) => ConsoleEntry[]),
  ) => {
    const prev = get(_rawConsoleEntriesAtom);
    const next = typeof update === "function" ? update(prev) : update;
    if (next.length <= MAX_CONSOLE_ENTRIES) {
      set(_rawConsoleEntriesAtom, next);
      return;
    }
    // Keep the most recent MAX_CONSOLE_ENTRIES entries — old ones are
    // dropped silently. Users investigating earlier output can read the
    // full log via the main-process `lib/log_store` IPC.
    set(_rawConsoleEntriesAtom, next.slice(next.length - MAX_CONSOLE_ENTRIES));
  },
);
export const appUrlAtom = atom<
  | {
      appUrl: string;
      appId: number;
      originalUrl: string;
      mode: RuntimeMode2;
    }
  | {
      appUrl: null;
      appId: null;
      originalUrl: null;
      mode: null;
    }
>({ appUrl: null, appId: null, originalUrl: null, mode: null });
export const userSettingsAtom = atom<UserSettings | null>(null);

// Atom for storing allow-listed environment variables
export const envVarsAtom = atom<Record<string, string | undefined>>({});

export const previewPanelKeyAtom = atom<number>(0);

// Stores the current preview URL to preserve route across HMR-induced remounts
// Maps appId to the current URL for that app
export const previewCurrentUrlAtom = atom<Record<number, string>>({});

export const previewErrorMessageAtom = atom<
  | {
      message: string;
      source: "preview-app" | "orianbuilder-app" | "orianbuilder-sync";
    }
  | undefined
>(undefined);
