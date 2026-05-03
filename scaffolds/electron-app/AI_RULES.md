# Tech Stack

- You are building an **Electron desktop app**.
- Architecture: **Main process** (`src/main/`) + **Renderer process** (`src/renderer/src/`) + **Preload script** (`src/preload/`).
- Renderer: React 18 + Vite + Tailwind CSS.
- Build tool: `electron-vite`.

## Process Architecture

```
Main Process (Node.js)          Preload Script          Renderer Process (browser)
src/main/index.ts               src/preload/index.ts    src/renderer/src/
  - File system access            - contextBridge         - React components
  - ipcMain.handle()              - Exposes safe API      - window.api.*
  - app lifecycle                 - NO direct ipcRenderer - NO direct Node.js
  - Native OS APIs
```

## IPC Pattern (main ↔ renderer communication)

**Main process** — register handlers:

```ts
// src/main/index.ts
import { ipcMain } from "electron";

ipcMain.handle("files:read", async (_, filePath: string) => {
  const fs = await import("fs/promises");
  return fs.readFile(filePath, "utf-8");
});
```

**Preload** — expose safe API via contextBridge:

```ts
// src/preload/index.ts
import { contextBridge, ipcRenderer } from "electron";

const api = {
  readFile: (path: string) => ipcRenderer.invoke("files:read", path),
};

contextBridge.exposeInMainWorld("api", api);

export type API = typeof api;
```

**Renderer** — call via `window.api`:

```tsx
// src/renderer/src/App.tsx
declare global {
  interface Window {
    api: import("../../../preload/index").API;
  }
}

const content = await window.api.readFile("/path/to/file");
```

## Critical Rules

- **NEVER** use `require('fs')`, `require('path')`, or any Node.js module directly in the renderer.
- **NEVER** expose `ipcRenderer` directly via contextBridge — always wrap in named methods.
- **NEVER** set `nodeIntegration: true` in `webPreferences` — use contextBridge instead.
- **NEVER** set `contextIsolation: false` — keep it enabled (default).
- **ALWAYS** add new capabilities in `ipcMain.handle()` + expose via preload `contextBridge`.

## File Structure

```
src/
  main/
    index.ts         — app lifecycle, BrowserWindow, ipcMain handlers
  preload/
    index.ts         — contextBridge exposing typed API to renderer
  renderer/
    index.html       — HTML entry point
    src/
      main.tsx       — React root
      App.tsx        — Root component
      pages/         — Page components
      components/    — Shared UI components
      index.css      — Tailwind directives
```

## Available packages (already installed)

- `electron`, `electron-vite`, `@electron-toolkit/utils`, `@electron-toolkit/preload`
- `react`, `react-dom`, `@vitejs/plugin-react`
- `tailwindcss`, `autoprefixer`, `postcss`

## Rules

- Use `is.dev` from `@electron-toolkit/utils` to detect dev mode.
- Use `shell.openExternal()` for opening URLs — never load external URLs in the main BrowserWindow.
- Store user data with `app.getPath('userData')` — never write to the app install directory.
- After editing a file, verify all imports are correct and types are sound.
