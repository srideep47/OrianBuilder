import { ipcMain } from "electron";
import { getServerStatus } from "../utils/embedded_inference_server";

export function registerEmbeddedLocalModelHandlers(): void {
  ipcMain.handle("local-models:list-embedded", async () => {
    const status = getServerStatus();
    if (!status.modelLoaded || !status.modelPath) {
      return { models: [] };
    }
    const modelName = status.modelPath.split(/[/\\]/).pop() ?? "embedded-model";
    return {
      models: [
        {
          id: modelName,
          name: modelName,
          provider: "embedded",
        },
      ],
    };
  });
}
