import { contextBridge, ipcRenderer } from "electron";
import { electronAPI } from "@electron-toolkit/preload";

// Expose a type-safe API to the renderer via contextBridge.
// Never expose ipcRenderer directly — always wrap in specific methods.
const api = {
  getVersion: () => ipcRenderer.invoke("app:getVersion"),
  // Add more methods here as you add ipcMain.handle() in main/index.ts
};

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld("electron", electronAPI);
    contextBridge.exposeInMainWorld("api", api);
  } catch (error) {
    console.error(error);
  }
} else {
  // @ts-ignore (for non-sandboxed fallback)
  window.electron = electronAPI;
  // @ts-ignore
  window.api = api;
}

export type API = typeof api;
