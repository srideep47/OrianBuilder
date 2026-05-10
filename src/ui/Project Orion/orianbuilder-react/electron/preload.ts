import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("orian", {
  platform: process.platform,
  versions: process.versions,
  invoke: (channel: string, ...args: unknown[]) =>
    ipcRenderer.invoke(channel, ...args),
});
