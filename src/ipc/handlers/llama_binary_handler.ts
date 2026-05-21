import { app, BrowserWindow } from "electron";
import { createTypedHandler } from "./base";
import {
  llamaBinaryContracts,
  llamaBinaryEvents,
} from "@/ipc/types/llama_binary";
import {
  resolveLlamaServerBinary,
  pickLlamaServerVariant,
} from "@/main/llm/llama_server_binary";
import { downloadLlamaServerBinary } from "@/main/llm/llama_server_downloader";
import { getCachedHardwareProfile } from "@/main/hardware/detect";

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

let activeAbortController: AbortController | null = null;

export function registerLlamaBinaryHandlers(): void {
  createTypedHandler(llamaBinaryContracts.check, async () => {
    try {
      const profile = await getCachedHardwareProfile();
      const location = resolveLlamaServerBinary(profile);
      return { exists: true, variant: location.variant, path: location.path };
    } catch {
      try {
        const profile = await getCachedHardwareProfile();
        const variant = pickLlamaServerVariant(profile);
        return { exists: false, variant, path: null };
      } catch {
        return { exists: false, variant: null, path: null };
      }
    }
  });

  createTypedHandler(llamaBinaryContracts.download, async () => {
    if (activeAbortController) {
      return { ok: false, error: "A download is already in progress." };
    }

    activeAbortController = new AbortController();
    const signal = activeAbortController.signal;

    try {
      const profile = await getCachedHardwareProfile();
      const variant = pickLlamaServerVariant(profile);

      await downloadLlamaServerBinary(
        variant,
        (progress) => broadcast(llamaBinaryEvents.progress.channel, progress),
        signal,
      );

      return { ok: true, error: null };
    } catch (err: any) {
      if (err?.name === "AbortError") {
        return { ok: false, error: "Download cancelled." };
      }
      return { ok: false, error: String(err?.message ?? err) };
    } finally {
      activeAbortController = null;
    }
  });

  createTypedHandler(llamaBinaryContracts.abort, async () => {
    activeAbortController?.abort();
    activeAbortController = null;
  });

  createTypedHandler(llamaBinaryContracts.restart, async () => {
    app.relaunch();
    app.quit();
  });
}
