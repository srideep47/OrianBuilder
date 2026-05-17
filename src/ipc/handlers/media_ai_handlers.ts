import { mediaAiContracts } from "../types/media_ai";
import { createTypedHandler } from "./base";
import {
  downloadMediaAiModels,
  getMediaAiBackendStatus,
  installMediaAiDependencies,
  startMediaAiBackend,
  stopMediaAiBackend,
} from "../utils/media_ai_backend";

export function registerMediaAiHandlers() {
  createTypedHandler(mediaAiContracts.getStatus, async () => {
    return getMediaAiBackendStatus();
  });

  createTypedHandler(mediaAiContracts.installDependencies, async () => {
    const output = await installMediaAiDependencies();
    return { success: true, output };
  });

  createTypedHandler(mediaAiContracts.downloadModels, async (_, params) => {
    const output = await downloadMediaAiModels(params.models);
    return { success: true, output };
  });

  createTypedHandler(mediaAiContracts.startBackend, async () => {
    startMediaAiBackend();
    return getMediaAiBackendStatus();
  });

  createTypedHandler(mediaAiContracts.stopBackend, async () => {
    stopMediaAiBackend();
    return getMediaAiBackendStatus();
  });

  // Image proxy via main-process fetch (no CORS / Origin / Referer issues).
  // The renderer can't reliably load cloud images like Pollinations.ai because
  // Electron sends an unblockable Referer that some hosts reject. Routing
  // through Node here avoids all browser-side request mutation.
  createTypedHandler(mediaAiContracts.fetchCloudImage, async (_, params) => {
    const res = await fetch(params.url);
    if (!res.ok) {
      throw new Error(
        `Fetch failed for ${params.url}: HTTP ${res.status} ${res.statusText}`,
      );
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      base64: buf.toString("base64"),
      contentType: res.headers.get("content-type") || "image/jpeg",
    };
  });
}
