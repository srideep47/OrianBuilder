/**
 * Watchdog page.
 *
 * Two-state UI:
 *   1. Not set up → render the SetupCard, which detects Python, creates a
 *      venv under userData/watchdog/.venv, and pip-installs the FastAPI deps.
 *      Live progress streams in via ipc.events.watchdog.onSetupProgress.
 *   2. Set up → render the Dashboard placeholder. Step 3 of the integration
 *      plan replaces this with Website Radar + Price Monitor.
 *
 * Backend lifecycle is fully managed by the main process: once setup is
 * complete the page calls ipc.watchdog.start() and shows a status pill.
 * Closing the app stops the child via the existing main-process shutdown
 * hooks (added later in step 3 once the dashboard actually depends on it).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Eye,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Play,
  Square,
  Globe,
  LineChart as LineChartIcon,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { ipc } from "@/ipc/types";
import type {
  WatchdogStatus,
  WatchdogSetupPhase,
  WatchdogSetupProgress,
} from "@/ipc/types";
import { createWatchdogApi, type WatchdogApi } from "@/components/watchdog/api";
import { WebsiteRadar } from "@/components/watchdog/WebsiteRadar";
import { PriceMonitor } from "@/components/watchdog/PriceMonitor";

type DashboardTab = "websites" | "products";

const PHASE_LABELS: Record<WatchdogSetupPhase, string> = {
  "detecting-python": "Detecting Python…",
  "creating-venv": "Creating virtual environment…",
  "installing-deps": "Installing dependencies…",
  ready: "Setup complete",
  error: "Setup failed",
};

const MAX_LOG_LINES = 200;

export default function WatchdogPage() {
  const [status, setStatus] = useState<WatchdogStatus | null>(null);
  const [phase, setPhase] = useState<WatchdogSetupPhase | null>(null);
  const [pythonInfo, setPythonInfo] = useState<{
    version: string;
    command: string;
  } | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [pythonOverride, setPythonOverride] = useState("");
  const [setupInFlight, setSetupInFlight] = useState(false);
  const [startInFlight, setStartInFlight] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  // Initial status + status-changed subscription
  const refreshStatus = useCallback(async () => {
    const next = await ipc.watchdog.getStatus();
    setStatus(next);
    return next;
  }, []);

  useEffect(() => {
    void refreshStatus();
    const unsub = ipc.events.watchdog.onStatusChanged((s) => setStatus(s));
    return unsub;
  }, [refreshStatus]);

  // Setup progress subscription — runs for the lifetime of the page.
  useEffect(() => {
    const unsub = ipc.events.watchdog.onSetupProgress(
      (evt: WatchdogSetupProgress) => {
        setPhase(evt.phase);
        if (evt.python) setPythonInfo(evt.python);
        if (evt.message && evt.phase === "error") setSetupError(evt.message);
        if (evt.line) {
          setLogLines((prev) => {
            const next = [...prev, evt.line as string];
            // Cap log buffer so the renderer doesn't keep growing during a
            // long pip install on a slow connection.
            return next.length > MAX_LOG_LINES
              ? next.slice(next.length - MAX_LOG_LINES)
              : next;
          });
        }
      },
    );
    return unsub;
  }, []);

  // Auto-scroll the log to the bottom on new lines.
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logLines]);

  // Auto-start the backend once setup is complete (and not already running).
  useEffect(() => {
    if (!status) return;
    if (status.setupComplete && !status.running && !startInFlight) {
      void startBackend();
    }
    // We intentionally depend only on the two booleans, not the whole status
    // object, so flapping fields like `pid` don't trigger restart attempts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.setupComplete, status?.running]);

  const runSetup = useCallback(
    async (force = false) => {
      setSetupInFlight(true);
      setSetupError(null);
      setLogLines([]);
      setPhase("detecting-python");
      try {
        const result = await ipc.watchdog.runSetup({
          pythonOverride: pythonOverride.trim() || null,
          force,
        });
        if (!result.ok) {
          setSetupError(result.message);
          setPhase("error");
        } else {
          setPhase("ready");
        }
        await refreshStatus();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setSetupError(message);
        setPhase("error");
      } finally {
        setSetupInFlight(false);
      }
    },
    [pythonOverride, refreshStatus],
  );

  const startBackend = useCallback(async () => {
    setStartInFlight(true);
    setActionError(null);
    try {
      const result = await ipc.watchdog.start();
      if (!result.ok) setActionError(result.message);
      setStatus(result.status);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setStartInFlight(false);
    }
  }, []);

  const stopBackend = useCallback(async () => {
    setStartInFlight(true);
    setActionError(null);
    try {
      await ipc.watchdog.stop();
      await refreshStatus();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setStartInFlight(false);
    }
  }, [refreshStatus]);

  const uninstall = useCallback(async () => {
    if (
      !confirm(
        "Remove the Watchdog virtual environment? Your tracked websites and products will be preserved.",
      )
    )
      return;
    setSetupInFlight(true);
    try {
      await ipc.watchdog.uninstall();
      setPhase(null);
      setPythonInfo(null);
      setLogLines([]);
      await refreshStatus();
    } finally {
      setSetupInFlight(false);
    }
  }, [refreshStatus]);

  const setupComplete = status?.setupComplete ?? false;

  return (
    <div className="flex flex-col h-full overflow-hidden bg-background">
      <Header status={status} />

      <div className="flex-1 overflow-y-auto px-6 py-6">
        {!setupComplete ? (
          <SetupCard
            phase={phase}
            pythonInfo={pythonInfo}
            logLines={logLines}
            logRef={logRef}
            setupError={setupError}
            inFlight={setupInFlight}
            pythonOverride={pythonOverride}
            setPythonOverride={setPythonOverride}
            onRun={() => void runSetup(false)}
          />
        ) : (
          <Dashboard
            status={status}
            startInFlight={startInFlight}
            actionError={actionError}
            onStart={() => void startBackend()}
            onStop={() => void stopBackend()}
            onReset={() => void uninstall()}
            onReinstall={() => void runSetup(true)}
            inFlight={setupInFlight}
          />
        )}
      </div>
    </div>
  );
}

// ─── Header ──────────────────────────────────────────────────────────────────

function Header({ status }: { status: WatchdogStatus | null }) {
  const running = status?.running ?? false;
  const setupComplete = status?.setupComplete ?? false;
  return (
    <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-card/40">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center">
          <Eye className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h1 className="text-lg font-semibold">Watchdog</h1>
          <p className="text-xs text-muted-foreground">
            Track website changes and product prices, with AI-summarised diffs.
          </p>
        </div>
      </div>
      <StatusPill
        running={running}
        setupComplete={setupComplete}
        port={status?.port ?? null}
      />
    </div>
  );
}

function StatusPill({
  running,
  setupComplete,
  port,
}: {
  running: boolean;
  setupComplete: boolean;
  port: number | null;
}) {
  if (!setupComplete) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-muted text-muted-foreground">
        <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/60" />
        Not set up
      </span>
    );
  }
  if (running) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-green-500/10 text-green-600 dark:text-green-400">
        <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
        Running on :{port}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-yellow-500/10 text-yellow-600 dark:text-yellow-400">
      <span className="w-1.5 h-1.5 rounded-full bg-yellow-500" />
      Stopped
    </span>
  );
}

// ─── Setup card ──────────────────────────────────────────────────────────────

function SetupCard({
  phase,
  pythonInfo,
  logLines,
  logRef,
  setupError,
  inFlight,
  pythonOverride,
  setPythonOverride,
  onRun,
}: {
  phase: WatchdogSetupPhase | null;
  pythonInfo: { version: string; command: string } | null;
  logLines: string[];
  logRef: React.MutableRefObject<HTMLDivElement | null>;
  setupError: string | null;
  inFlight: boolean;
  pythonOverride: string;
  setPythonOverride: (value: string) => void;
  onRun: () => void;
}) {
  return (
    <div className="max-w-2xl mx-auto">
      <Card className="p-6 space-y-5">
        <div>
          <h2 className="text-base font-semibold mb-1">Set up Watchdog</h2>
          <p className="text-sm text-muted-foreground">
            Watchdog uses a small Python backend (FastAPI + a price/article
            scraper). The setup below creates an isolated virtual environment
            inside this app's user-data folder and installs the required
            packages. Nothing global is changed and no admin rights are needed.
          </p>
        </div>

        <div className="space-y-3">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Requirements
          </div>
          <ul className="text-sm space-y-1.5">
            <li className="flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 text-muted-foreground/70 mt-0.5 shrink-0" />
              <span>
                Python 3.11+ on this machine. The installer searches{" "}
                <code className="text-xs bg-muted px-1 py-0.5 rounded">
                  py
                </code>
                ,{" "}
                <code className="text-xs bg-muted px-1 py-0.5 rounded">
                  python3
                </code>{" "}
                and{" "}
                <code className="text-xs bg-muted px-1 py-0.5 rounded">
                  python
                </code>{" "}
                automatically.
              </span>
            </li>
            <li className="flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 text-muted-foreground/70 mt-0.5 shrink-0" />
              <span>
                A working internet connection (pip will download FastAPI,
                cloudscraper, apscheduler, etc.).
              </span>
            </li>
          </ul>
        </div>

        <div className="space-y-2">
          <label className="text-xs font-medium text-muted-foreground">
            Optional: explicit Python path
          </label>
          <Input
            value={pythonOverride}
            onChange={(e) => setPythonOverride(e.target.value)}
            placeholder="e.g. C:\Python313\python.exe — leave blank to auto-detect"
            disabled={inFlight}
            className="font-mono text-xs"
          />
        </div>

        {phase && <PhaseIndicator phase={phase} python={pythonInfo} />}

        {logLines.length > 0 && (
          <div
            ref={logRef}
            className="font-mono text-[11px] leading-relaxed bg-muted/50 border border-border rounded-md px-3 py-2 max-h-56 overflow-y-auto whitespace-pre-wrap"
          >
            {logLines.map((line, i) => (
              <div key={i} className="text-muted-foreground">
                {line}
              </div>
            ))}
          </div>
        )}

        {setupError && (
          <div className="flex items-start gap-2 text-sm text-red-600 dark:text-red-400 bg-red-500/10 border border-red-500/20 rounded-md px-3 py-2">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>{setupError}</span>
          </div>
        )}

        <div className="flex justify-end">
          <Button onClick={onRun} disabled={inFlight}>
            {inFlight ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Setting up…
              </>
            ) : (
              <>
                <Play className="w-4 h-4 mr-2" />
                Setup Watchdog
              </>
            )}
          </Button>
        </div>
      </Card>
    </div>
  );
}

function DashboardTabs({ status }: { status: WatchdogStatus | null }) {
  const [tab, setTab] = useState<DashboardTab>("websites");
  const baseUrl = useMemo(
    () =>
      status?.running && status.host && status.port
        ? `http://${status.host}:${status.port}`
        : null,
    [status?.running, status?.host, status?.port],
  );
  // Memoise the client so child components don't tear down their fetches on
  // every status poll. Keyed on baseUrl so it rebuilds when host/port change.
  const api: WatchdogApi | null = useMemo(
    () => (baseUrl ? createWatchdogApi(baseUrl) : null),
    [baseUrl],
  );

  if (!api) {
    // Brief gap between status flipping running=true and host/port being set.
    return (
      <Card className="p-5">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" />
          Connecting to backend…
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="inline-flex rounded-lg border border-border bg-card p-1 gap-1">
        <TabButton
          active={tab === "websites"}
          onClick={() => setTab("websites")}
          icon={<Globe className="w-3.5 h-3.5" />}
          label="Website Radar"
        />
        <TabButton
          active={tab === "products"}
          onClick={() => setTab("products")}
          icon={<LineChartIcon className="w-3.5 h-3.5" />}
          label="Price Monitor"
        />
      </div>
      {tab === "websites" ? (
        <WebsiteRadar api={api} />
      ) : (
        <PriceMonitor api={api} />
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
        active
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:text-foreground hover:bg-accent",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function PhaseIndicator({
  phase,
  python,
}: {
  phase: WatchdogSetupPhase;
  python: { version: string; command: string } | null;
}) {
  const isError = phase === "error";
  const isReady = phase === "ready";
  const isRunning = !isError && !isReady;
  return (
    <div className="flex items-center gap-2 text-sm">
      {isRunning && <Loader2 className="w-4 h-4 animate-spin text-primary" />}
      {isReady && <CheckCircle2 className="w-4 h-4 text-green-500" />}
      {isError && <AlertCircle className="w-4 h-4 text-red-500" />}
      <span className="font-medium">{PHASE_LABELS[phase]}</span>
      {python && (
        <span className="text-xs text-muted-foreground font-mono">
          (Python {python.version})
        </span>
      )}
    </div>
  );
}

// ─── Dashboard placeholder ───────────────────────────────────────────────────

function Dashboard({
  status,
  startInFlight,
  actionError,
  onStart,
  onStop,
  onReset,
  onReinstall,
  inFlight,
}: {
  status: WatchdogStatus | null;
  startInFlight: boolean;
  actionError: string | null;
  onStart: () => void;
  onStop: () => void;
  onReset: () => void;
  onReinstall: () => void;
  inFlight: boolean;
}) {
  const running = status?.running ?? false;
  const summaryText = useMemo(() => {
    if (running) {
      return `The Watchdog backend is reachable on http://${status?.host}:${status?.port}.`;
    }
    return "Setup is complete. Start the backend to begin tracking websites and products.";
  }, [running, status?.host, status?.port]);

  return (
    <div className="max-w-3xl mx-auto space-y-4">
      <Card className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <h2 className="text-base font-semibold mb-1">Backend</h2>
            <p className="text-sm text-muted-foreground">{summaryText}</p>
          </div>
          <div className="flex items-center gap-2">
            {running ? (
              <Button
                variant="outline"
                onClick={onStop}
                disabled={startInFlight}
              >
                {startInFlight ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <Square className="w-4 h-4 mr-2" />
                )}
                Stop
              </Button>
            ) : (
              <Button onClick={onStart} disabled={startInFlight}>
                {startInFlight ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <Play className="w-4 h-4 mr-2" />
                )}
                Start
              </Button>
            )}
          </div>
        </div>

        {actionError && (
          <div className="mt-4 flex items-start gap-2 text-sm text-red-600 dark:text-red-400 bg-red-500/10 border border-red-500/20 rounded-md px-3 py-2">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>{actionError}</span>
          </div>
        )}

        {status?.lastError && !running && (
          <details className="mt-4 text-xs">
            <summary className="cursor-pointer text-muted-foreground">
              Last error output
            </summary>
            <pre className="mt-2 font-mono bg-muted/50 border border-border rounded p-2 whitespace-pre-wrap max-h-48 overflow-y-auto">
              {status.lastError}
            </pre>
          </details>
        )}
      </Card>

      {running ? (
        <DashboardTabs status={status} />
      ) : (
        <Card className="p-5 border-dashed">
          <div className="text-sm text-muted-foreground">
            Start the backend above to enable Website Radar and Price Monitor.
            Setup data (tracked URLs, price history) is preserved across stops.
          </div>
        </Card>
      )}

      <Card className="p-5">
        <h3 className="text-sm font-semibold mb-2">Maintenance</h3>
        <p className="text-xs text-muted-foreground mb-3">
          Reinstall regenerates the virtual environment. Reset additionally
          discards it — your tracked URLs and price history stay intact.
        </p>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onReinstall}
            disabled={inFlight}
          >
            <RefreshCw className="w-3.5 h-3.5 mr-2" />
            Reinstall
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onReset}
            disabled={inFlight}
          >
            <Trash2 className="w-3.5 h-3.5 mr-2" />
            Reset
          </Button>
        </div>
      </Card>
    </div>
  );
}
