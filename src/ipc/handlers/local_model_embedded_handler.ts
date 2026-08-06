import { ipcMain } from "electron";
import { getServerStatus } from "../utils/embedded_inference_server";
import { listLocalModels } from "../utils/model_download_manager";

export function registerEmbeddedLocalModelHandlers(): void {
  ipcMain.handle("local-models:list-embedded", async () => {
    // Surface every downloaded GGUF as a selectable model under the "embedded" provider.
    // The currently-loaded model is what the chat actually hits at /v1/chat/completions —
    // we still show all of them so the model picker can drive load-on-select if desired.
    const status = getServerStatus();
    const downloaded = listLocalModels();

    const seen = new Set<string>();
    const models: {
      modelName: string;
      displayName: string;
      provider: "embedded";
    }[] = [];

    if (status.modelLoaded && status.modelPath) {
      const name = status.modelPath.split(/[/\\]/).pop() ?? "embedded-model";
      models.push({
        modelName: name,
        displayName: `${name} · loaded`,
        provider: "embedded",
      });
      seen.add(name);
    }

    for (const m of downloaded) {
      if (seen.has(m.fileName)) continue;
      models.push({
        modelName: m.fileName,
        displayName: m.fileName,
        provider: "embedded",
      });
      seen.add(m.fileName);
    }

    return { models };
  });
}
