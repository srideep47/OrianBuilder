import { useAtomValue } from "jotai";
import { appConsoleEntriesAtom } from "@/atoms/appAtoms";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Smartphone,
  ExternalLink,
  Loader2,
  RefreshCw,
  Copy,
  Check,
  Monitor,
  Play,
} from "lucide-react";
import { ipc } from "@/ipc/types";
import { cn } from "@/lib/utils";
import { showError } from "@/lib/toast";
import { useRunApp } from "@/hooks/useRunApp";

// Expo Metro outputs lines like:
//   › Metro waiting on exp://192.168.1.5:8081
//   › Metro waiting on exp://localhost:8081
const EXPO_URL_RE = /exp:\/\/[^\s\]"',]+/;

// Default Expo web dev port. We probe this URL for actual reachability
// rather than scanning console text — console messages survive past the
// dev server's death, leading to a "ready" indicator over a dead iframe.
const EXPO_WEB_URL = "http://localhost:8081";

// Probe cadence. 1.5s keeps the indicator honest without flooding the
// loopback socket. Each probe is a HEAD with a 1s AbortController timeout.
const PROBE_INTERVAL_MS = 1500;
const PROBE_TIMEOUT_MS = 1000;

function extractExpoUrl(message: string): string | null {
  const m = EXPO_URL_RE.exec(message);
  return m ? m[0] : null;
}

type ServerStatus = "checking" | "up" | "down";

/**
 * Polls `http://localhost:8081` and reports whether Metro is actually
 * accepting connections. We use `no-cors` HEAD because Metro's web bundler
 * doesn't always send CORS headers; we don't read the body, only whether
 * the fetch resolves at all. A network failure / ECONNREFUSED rejects the
 * promise; a 4xx/5xx still resolves and counts as "up" (Metro is alive).
 */
function useExpoServerStatus(intervalMs = PROBE_INTERVAL_MS): ServerStatus {
  const [status, setStatus] = useState<ServerStatus>("checking");

  useEffect(() => {
    let cancelled = false;
    let timerId: ReturnType<typeof setTimeout> | null = null;

    const probe = async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
      try {
        await fetch(EXPO_WEB_URL, {
          method: "HEAD",
          mode: "no-cors",
          cache: "no-store",
          signal: controller.signal,
        });
        if (!cancelled) setStatus("up");
      } catch {
        // ECONNREFUSED, AbortError, network unreachable all land here.
        if (!cancelled) setStatus("down");
      } finally {
        clearTimeout(timeoutId);
        if (!cancelled) {
          timerId = setTimeout(probe, intervalMs);
        }
      }
    };

    void probe();
    return () => {
      cancelled = true;
      if (timerId) clearTimeout(timerId);
    };
  }, [intervalMs]);

  return status;
}

interface ExpoPreviewPanelProps {
  appId: number;
}

type PreviewTab = "web" | "device";

export function ExpoPreviewPanel({ appId }: ExpoPreviewPanelProps) {
  const consoleEntries = useAtomValue(appConsoleEntriesAtom);
  const { runApp, loading: runAppLoading } = useRunApp();
  const serverStatus = useExpoServerStatus();
  const [copied, setCopied] = useState(false);
  const [openingAndroid, setOpeningAndroid] = useState(false);
  const [enablingWeb, setEnablingWeb] = useState(false);
  const [tab, setTab] = useState<PreviewTab>("web");
  const [iframeReloadKey, setIframeReloadKey] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  // Scan console entries newest-first so we get the most recent URL
  const expoUrl = useMemo(() => {
    for (let i = consoleEntries.length - 1; i >= 0; i--) {
      const entry = consoleEntries[i];
      if (entry.appId !== appId) continue;
      const url = extractExpoUrl(entry.message);
      if (url) return url;
    }
    return null;
  }, [consoleEntries, appId]);

  // Auto-reload the iframe the moment the probe flips from down → up.
  const prevStatusRef = useRef<ServerStatus>("checking");
  useEffect(() => {
    if (prevStatusRef.current !== "up" && serverStatus === "up") {
      setIframeReloadKey((k) => k + 1);
    }
    prevStatusRef.current = serverStatus;
  }, [serverStatus]);

  const handleCopy = async () => {
    if (!expoUrl) return;
    await navigator.clipboard.writeText(expoUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleOpenWebExternal = () => {
    ipc.system.openExternalUrl(EXPO_WEB_URL);
  };

  const handleReloadIframe = () => {
    setIframeReloadKey((prev) => prev + 1);
  };

  const handleStartDevServer = async () => {
    try {
      await runApp(appId);
    } catch (error) {
      showError(error);
    }
  };

  // Send 'w' to Metro's stdin so it boots the web bundler if it hasn't
  // already. Only useful when Metro is up but hasn't opened the web port.
  const handleEnableWebMode = async () => {
    setEnablingWeb(true);
    try {
      await ipc.app.respondToAppInput({ appId, response: "w" });
      setTimeout(() => setIframeReloadKey((prev) => prev + 1), 4_000);
    } catch (error) {
      showError(error);
    } finally {
      setEnablingWeb(false);
    }
  };

  const handleOpenAndroid = async () => {
    setOpeningAndroid(true);
    try {
      await ipc.app.respondToAppInput({ appId, response: "a" });
    } catch (error) {
      showError(error);
    } finally {
      setOpeningAndroid(false);
    }
  };

  const statusBadge =
    serverStatus === "up" ? (
      <span className="text-green-600 dark:text-green-400">● running</span>
    ) : serverStatus === "down" ? (
      <span className="text-red-500">● not running</span>
    ) : (
      <span className="text-amber-500">● checking…</span>
    );

  // ---- WEB PREVIEW TAB ----------------------------------------------------
  const webTab = (
    <div className="relative flex flex-col h-full">
      <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-b border-border bg-[var(--background-darkest)]">
        <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
          <Monitor size={14} />
          <code className="text-xs">{EXPO_WEB_URL}</code>
          {statusBadge}
        </div>
        <div className="flex items-center gap-1">
          {serverStatus === "down" ? (
            <button
              onClick={handleStartDevServer}
              disabled={runAppLoading}
              className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-60"
            >
              {runAppLoading ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Play size={12} />
              )}
              Start dev server
            </button>
          ) : (
            <button
              onClick={handleEnableWebMode}
              disabled={enablingWeb}
              title="Send 'w' to Metro so it enables the web bundler"
              className="flex items-center gap-1 px-2 py-1 text-xs rounded hover:bg-[var(--background-darker)] transition-colors disabled:opacity-60"
            >
              {enablingWeb ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Monitor size={12} />
              )}
              Enable web
            </button>
          )}
          <button
            onClick={handleReloadIframe}
            title="Reload preview"
            className="flex items-center gap-1 px-2 py-1 text-xs rounded hover:bg-[var(--background-darker)] transition-colors"
          >
            <RefreshCw size={12} />
            Reload
          </button>
          <button
            onClick={handleOpenWebExternal}
            title="Open in external browser"
            className="flex items-center gap-1 px-2 py-1 text-xs rounded hover:bg-[var(--background-darker)] transition-colors"
          >
            <ExternalLink size={12} />
            Open
          </button>
        </div>
      </div>
      <div className="flex-1 relative bg-white">
        {/* Only mount the iframe when the server is reachable. Mounting it
            against a refused port produces a permanent error page that
            Chromium caches; remounting after the server comes up is
            unreliable. The `key` bumps on every up-transition. */}
        {serverStatus === "up" && (
          <iframe
            key={iframeReloadKey}
            ref={iframeRef}
            src={EXPO_WEB_URL}
            title="Expo web preview"
            className="absolute inset-0 w-full h-full border-0"
          />
        )}
        {serverStatus !== "up" && (
          <div className="absolute inset-0 flex items-center justify-center bg-white/95 dark:bg-black/85">
            <div className="flex flex-col items-center gap-3 text-center max-w-sm px-6">
              {serverStatus === "checking" ? (
                <Loader2 size={28} className="animate-spin text-primary" />
              ) : (
                <Smartphone
                  size={36}
                  className="text-gray-300 dark:text-gray-600"
                />
              )}
              <p className="text-sm text-gray-700 dark:text-gray-200 font-medium">
                {serverStatus === "checking"
                  ? "Looking for Metro on localhost:8081…"
                  : "Metro dev server is not running"}
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {serverStatus === "checking"
                  ? "Probing the port. This usually resolves in under a second."
                  : "The Android pipeline built the APK with a one-shot Gradle process, but no Metro instance is running. Start the dev server to get a live web preview here."}
              </p>
              {serverStatus === "down" && (
                <button
                  onClick={handleStartDevServer}
                  disabled={runAppLoading}
                  className="mt-1 flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-60"
                >
                  {runAppLoading ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Play size={14} />
                  )}
                  Start dev server
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );

  // ---- DEVICE TAB (QR for Expo Go) ---------------------------------------
  const deviceTab = (
    <div className="flex flex-col items-center justify-center h-full gap-5 p-8 overflow-auto">
      <div className="flex items-center gap-2">
        <Smartphone size={20} className="text-primary" />
        <h2 className="text-base font-semibold">Expo Go preview</h2>
      </div>

      {expoUrl && serverStatus === "up" ? (
        <>
          <p className="text-sm text-gray-500 dark:text-gray-400 text-center max-w-xs">
            Scan with{" "}
            <strong className="text-gray-700 dark:text-gray-300">
              Expo Go
            </strong>{" "}
            on Android or the{" "}
            <strong className="text-gray-700 dark:text-gray-300">
              Camera app
            </strong>{" "}
            on iOS to open on your device
          </p>

          <div className="p-4 bg-white rounded-2xl shadow-lg border border-gray-100 dark:border-gray-700">
            <QRCodeSVG
              value={expoUrl}
              size={220}
              bgColor="#ffffff"
              fgColor="#000000"
              level="M"
              marginSize={1}
            />
          </div>

          <div className="flex items-center gap-2 bg-gray-100 dark:bg-gray-800 rounded-lg px-3 py-1.5 max-w-full">
            <code className="text-xs text-gray-600 dark:text-gray-300 truncate max-w-[240px]">
              {expoUrl}
            </code>
            <button
              onClick={handleCopy}
              title="Copy URL"
              className={cn(
                "p-1 rounded transition-colors flex-shrink-0",
                copied
                  ? "text-green-500"
                  : "text-gray-400 hover:text-gray-600 dark:hover:text-gray-200",
              )}
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
          </div>

          <div className="flex flex-col sm:flex-row gap-2 items-center">
            <button
              onClick={handleOpenAndroid}
              disabled={openingAndroid}
              className="flex items-center gap-2 px-4 py-2 border border-border rounded-lg text-sm hover:bg-[var(--background-darkest)] transition-colors disabled:opacity-60"
            >
              {openingAndroid ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Smartphone size={14} />
              )}
              Android emulator
            </button>
            <button
              onClick={() => ipc.system.openExternalUrl(expoUrl)}
              className="flex items-center gap-2 px-4 py-2 border border-border rounded-lg text-sm hover:bg-[var(--background-darkest)] transition-colors"
            >
              <ExternalLink size={14} />
              Open in Expo Go
            </button>
          </div>

          <p className="text-xs text-gray-400 dark:text-gray-500 text-center max-w-xs">
            Make sure your phone is on the same Wi-Fi network as this computer
          </p>
        </>
      ) : serverStatus === "down" ? (
        <>
          <div className="relative">
            <Smartphone
              size={48}
              className="text-gray-300 dark:text-gray-600"
            />
          </div>
          <h2 className="text-base font-semibold text-gray-700 dark:text-gray-300">
            Metro is not running
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 text-center max-w-xs">
            Start the dev server to get an exp:// URL for Expo Go.
          </p>
          <button
            onClick={handleStartDevServer}
            disabled={runAppLoading}
            className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-60"
          >
            {runAppLoading ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Play size={14} />
            )}
            Start dev server
          </button>
        </>
      ) : (
        <>
          <div className="relative">
            <Smartphone
              size={48}
              className="text-gray-300 dark:text-gray-600"
            />
            <Loader2
              size={20}
              className="absolute -bottom-1 -right-1 animate-spin text-primary"
            />
          </div>
          <h2 className="text-base font-semibold text-gray-700 dark:text-gray-300">
            Waiting for Metro to publish an exp:// URL
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 text-center max-w-xs">
            Metro is up but hasn&apos;t emitted the device URL yet. This usually
            appears within a few seconds of the first bundle.
          </p>
        </>
      )}
    </div>
  );

  return (
    <div className="flex flex-col h-full">
      <div className="flex border-b border-border bg-[var(--background-darkest)] text-xs">
        <button
          onClick={() => setTab("web")}
          className={cn(
            "flex items-center gap-1.5 px-3 py-2 border-b-2 transition-colors",
            tab === "web"
              ? "border-primary text-foreground font-medium"
              : "border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200",
          )}
        >
          <Monitor size={14} />
          Web preview
        </button>
        <button
          onClick={() => setTab("device")}
          className={cn(
            "flex items-center gap-1.5 px-3 py-2 border-b-2 transition-colors",
            tab === "device"
              ? "border-primary text-foreground font-medium"
              : "border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200",
          )}
        >
          <Smartphone size={14} />
          On device
          {serverStatus === "up" && expoUrl ? (
            <span className="ml-1 inline-block w-1.5 h-1.5 rounded-full bg-green-500" />
          ) : null}
        </button>
      </div>
      <div className="flex-1 overflow-hidden">
        {tab === "web" ? webTab : deviceTab}
      </div>
    </div>
  );
}
