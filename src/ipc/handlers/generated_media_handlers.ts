/**
 * IPC for the global generated-media store (see main/generated_media/store.ts).
 * Backs the unified Library → Media view and is the source for publishing and
 * peer sharing.
 */
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { BrowserWindow } from "electron";
import log from "electron-log/main";
import { generatedMediaContracts, generatedMediaEvents } from "@/ipc/types/generated_media";
import { createTypedHandler } from "./base";
import * as store from "@/main/generated_media/store";
import { mediaShare } from "@/main/network/media-share";
import {
  MEDIA_AI_SERVER_URL,
  isMediaAiBackendHealthy,
  startMediaAiBackend,
} from "@/ipc/utils/media_ai_backend";

const logger = log.scope("generated-media-handlers");

function emitChanged(): void {
  const count = store.list().length;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(generatedMediaEvents.changed.channel, { count });
    }
  }
}

export function registerGeneratedMediaHandlers(): void {
  createTypedHandler(generatedMediaContracts.list, async () => store.list());

  createTypedHandler(generatedMediaContracts.saveFromUrl, async (_e, params) => {
    const item = await store.saveFromUrl(params.url, {
      prompt: params.prompt ?? null,
      promptOrStem: params.prompt ?? undefined,
      ext: params.ext,
    });
    emitChanged();
    return item;
  });

  createTypedHandler(generatedMediaContracts.remove, async (_e, { fileName }) => {
    store.remove(fileName);
    emitChanged();
    // A removed item may have been shared — re-announce the smaller set.
    mediaShare.announceToAll();
    return { ok: true };
  });

  createTypedHandler(
    generatedMediaContracts.getFilePath,
    async (_e, { fileName }) => {
      // `store.getFilePath` enforces the same directory-traversal guard the
      // store uses for read/write — passing a malicious filename throws.
      return { path: store.getFilePath(fileName) };
    },
  );

  createTypedHandler(
    generatedMediaContracts.setShared,
    async (_e, { fileName, shared }) => {
      store.setShared(fileName, shared);
      emitChanged();
      // Broadcast the updated sharable set to trusted peers.
      mediaShare.announceToAll();
      return { ok: true };
    },
  );

  createTypedHandler(
    generatedMediaContracts.setThumbnail,
    async (_e, { fileName, thumbnail }) => {
      store.setThumbnail(fileName, thumbnail);
      return { ok: true };
    },
  );

  createTypedHandler(
    generatedMediaContracts.concatVideos,
    async (
      _e,
      { fileNames, mode, targetWidth, targetHeight, targetFps, prompt },
    ) => {
      // Auto-start the Media AI backend if it's not already running. The video
      // editor pipeline (ffmpeg concat) lives in the Python backend, so we
      // need it healthy before posting to /v1/edit/concat.
      if (!(await isMediaAiBackendHealthy())) {
        logger.info("Media AI backend not healthy — auto-starting for concat");
        try {
          await startMediaAiBackend();
        } catch (e) {
          logger.warn("startMediaAiBackend threw:", e);
        }
        // Poll for readiness — backend takes a few seconds to bind 127.0.0.1:8001.
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          if (await isMediaAiBackendHealthy()) break;
          await new Promise((r) => setTimeout(r, 750));
        }
        if (!(await isMediaAiBackendHealthy())) {
          throw new Error(
            "Couldn't start the Media AI backend. Open the Media AI page once to complete first-run setup, then try again.",
          );
        }
      }

      // Validate every clip exists; reject anything that isn't a video.
      const inputPaths: string[] = [];
      for (const fn of fileNames) {
        const item = store.statItem(fn);
        if (item.kind !== "video") {
          throw new Error(`Not a video: ${fn}`);
        }
        inputPaths.push(store.getFilePath(fn));
      }

      // Backend writes the file into a tmp path we own, then we copy it into
      // the global store so it shows up in Library → Media.
      const tmpOut = path.join(
        os.tmpdir(),
        `orian-edit-${Date.now()}-${Math.floor(Math.random() * 1e6)}.mp4`,
      );

      logger.info(`Concatenating ${fileNames.length} videos via backend`);
      const res = await fetch(`${MEDIA_AI_SERVER_URL}/v1/edit/concat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input_paths: inputPaths,
          output_path: tmpOut,
          mode: mode ?? "reencode",
          target_width: targetWidth,
          target_height: targetHeight,
          target_fps: targetFps ?? 24,
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Backend concat failed (${res.status}): ${text}`);
      }

      const stem = (prompt ?? `edited_${fileNames.length}_clips`).slice(0, 40);
      const saved = await store.saveFromPath(tmpOut, {
        promptOrStem: stem,
        prompt: prompt ?? `Edited: ${fileNames.length} clips concatenated`,
      });
      try {
        fs.unlinkSync(tmpOut);
      } catch {
        /* ignore tmp cleanup */
      }

      emitChanged();
      return saved;
    },
  );
}
