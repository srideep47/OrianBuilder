/**
 * System-tray integration for background scheduled posts.
 *
 * When the "Run in background" setting is enabled:
 *   - A tray icon appears with show/quit menu items.
 *   - Clicking the window's close (X) button hides it instead of quitting,
 *     so the main process (and the schedule engine) keeps running.
 *   - Electron is asked to auto-launch at OS login, so scheduled jobs fire
 *     even after a reboot without the user opening the app.
 *
 * When the setting is disabled, none of this runs and the app behaves
 * exactly as it did before (close = quit).
 *
 * We intentionally only enable auto-launch via `app.setLoginItemSettings` —
 * not via OS-specific cron/Task Scheduler — to keep the install footprint
 * to zero new system-level artifacts.
 */
import * as path from "path";
import { app, Tray, Menu, BrowserWindow, nativeImage } from "electron";
import log from "electron-log/main";

const logger = log.scope("schedule-tray");

let tray: Tray | null = null;
/** True once a window close has been intercepted at least once — used to
 *  decide whether the "Quit" tray menu action should still fire `will-quit`
 *  cleanup. */
let trayActive = false;
/** When true, our `before-quit` handler lets the app actually exit; otherwise
 *  the close button is hijacked to hide the window. */
let allowQuit = false;

function trayIconPath(): string {
  // The packaged app keeps its assets next to `app.getAppPath()`; dev mode
  // uses the same path because electron-forge mirrors the layout.
  return path.join(app.getAppPath(), "assets/icon/logo.png");
}

function showAndFocusMainWindow(): void {
  const wins = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());
  if (wins.length === 0) return;
  const win = wins[0];
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
}

function buildContextMenu(): Menu {
  return Menu.buildFromTemplate([
    {
      label: "Open OrianBuilder",
      click: () => showAndFocusMainWindow(),
    },
    { type: "separator" },
    {
      label: "Quit OrianBuilder",
      click: () => {
        allowQuit = true;
        app.quit();
      },
    },
  ]);
}

export function isTrayActive(): boolean {
  return trayActive;
}

export function enableBackgroundMode(window: BrowserWindow): void {
  if (trayActive) return;
  trayActive = true;
  logger.info("Enabling background mode (tray + auto-launch)");

  // 1. Create the tray icon.
  try {
    const icon = nativeImage.createFromPath(trayIconPath());
    // Some platforms ignore large images; resizing keeps the tray neat.
    tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 }));
    tray.setToolTip("OrianBuilder — running in background");
    tray.setContextMenu(buildContextMenu());
    tray.on("click", () => showAndFocusMainWindow());
  } catch (err) {
    logger.warn("Failed to create tray icon:", err);
  }

  // 2. Intercept the window close so the scheduler keeps running.
  window.on("close", (event) => {
    if (allowQuit) return; // letting it through (Quit menu / app.quit)
    event.preventDefault();
    window.hide();
  });

  // 3. Ask the OS to launch us at login.
  try {
    app.setLoginItemSettings({
      openAtLogin: true,
      // On Windows we use --hidden so we don't pop a window on each boot.
      // macOS uses `openAsHidden` (different field name).
      args: process.platform === "win32" ? ["--hidden"] : [],
      openAsHidden: process.platform === "darwin",
    });
  } catch (err) {
    logger.warn("Failed to set login item:", err);
  }
}

export function disableBackgroundMode(window: BrowserWindow | null): void {
  if (!trayActive) return;
  trayActive = false;
  logger.info("Disabling background mode");

  if (tray) {
    try {
      tray.destroy();
    } catch {
      // ignore
    }
    tray = null;
  }

  try {
    app.setLoginItemSettings({ openAtLogin: false });
  } catch (err) {
    logger.warn("Failed to clear login item:", err);
  }

  // Remove the close-interceptor. Easiest way: a no-op listener that calls
  // `removeAllListeners('close')` would also nuke Electron's internal close
  // handling, so we instead rely on `allowQuit = true` for the *next* close.
  // The next quit will exit cleanly; live window doesn't need rewiring.
  allowQuit = true;
  void window;
}

/** Called from `app.on('before-quit')`. Returns false to veto the quit. */
export function shouldVetoQuit(): boolean {
  // Tray mode: don't veto. Window-close interception happens at the window
  // level, not the app level — so when `app.quit()` is invoked from anywhere
  // (eg the tray Quit menu) we want it to go through. The `allowQuit` flag
  // already lets the window close listener through in that case.
  return false;
}

/** Boot-time check: if the OS auto-launched us with `--hidden`, don't show
 *  the window. The renderer can ask to be shown later if the user clicks
 *  the tray icon. */
export function shouldStartHidden(): boolean {
  return process.argv.includes("--hidden");
}
