import { useEffect, useMemo, useState } from "react";
import {
  Cpu,
  RefreshCw,
  Layers,
  Image as ImageIcon,
  Box,
  Palette,
  Network as NetworkIcon,
  Eye,
  Grid3x3,
  Loader2,
  MessageSquare,
  Newspaper,
} from "lucide-react";
import { useAtomValue } from "jotai";
import { Link } from "@tanstack/react-router";
import { ipc } from "@/ipc/types";
import type {
  AvailableTiers,
  OrchestratorStatus,
} from "@/ipc/types/model_orchestrator";
import { isStreamingByIdAtom } from "@/atoms/chatAtoms";
import { useChats } from "@/hooks/useChats";
import { useLoadApps } from "@/hooks/useLoadApps";
import { useSelectChat } from "@/hooks/useSelectChat";

const STATE_STYLES: Record<
  OrchestratorStatus["state"],
  { label: string; className: string; pulse?: boolean }
> = {
  idle: { label: "Idle", className: "bg-white/10 text-white/60" },
  "llm-loading": {
    label: "Loading language model",
    className: "bg-sky-500/20 text-sky-300",
    pulse: true,
  },
  "llm-loaded": {
    label: "Language model ready",
    className: "bg-sky-500/20 text-sky-300",
  },
  "swapping-out": {
    label: "Freeing VRAM...",
    className: "bg-amber-500/20 text-amber-300",
    pulse: true,
  },
  "media-loading": {
    label: "Loading media model",
    className: "bg-fuchsia-500/20 text-fuchsia-300",
    pulse: true,
  },
  "media-loaded": {
    label: "Media model ready",
    className: "bg-fuchsia-500/20 text-fuchsia-300",
  },
  "swapping-back": {
    label: "Restoring language model...",
    className: "bg-amber-500/20 text-amber-300",
    pulse: true,
  },
};

function shortModel(path: string | null): string {
  if (!path) return "-";
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** Live view of the model orchestrator; visualizes automatic load/unload. */
export function ModelEnginePanel() {
  const [status, setStatus] = useState<OrchestratorStatus | null>(null);
  const [tiers, setTiers] = useState<AvailableTiers | null>(null);

  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const s = await ipc.orchestrator.getStatus();
        if (active) setStatus(s);
      } catch {
        /* engine not ready yet; keep last known */
      }
      try {
        const t = await ipc.orchestrator.getAvailableTiers();
        if (active) setTiers(t);
      } catch {
        /* VRAM probing is best-effort */
      }
    };
    void poll();
    const id = window.setInterval(poll, 10_000); // 10 s is fine for orchestrator status display
    return () => {
      active = false;
      window.clearInterval(id);
    };
  }, []);

  const style = status ? STATE_STYLES[status.state] : STATE_STYLES.idle;

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
      <div className="mb-3 flex items-center gap-2">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-sky-500/20 text-sky-300">
          <Cpu className="h-4 w-4" />
        </div>
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-white/90">Model Engine</h3>
          <p className="text-xs text-white/50">
            Models load &amp; unload automatically as commands need them.
          </p>
        </div>
        <span
          className={
            "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium " +
            style.className
          }
        >
          {style.pulse && <RefreshCw className="h-3 w-3 animate-spin" />}
          {style.label}
        </span>
      </div>

      <dl className="grid grid-cols-1 gap-2 sm:grid-cols-4">
        <div className="rounded-lg bg-black/20 px-3 py-2">
          <dt className="text-xs text-white/40">Language model</dt>
          <dd
            className="truncate text-sm text-white/85"
            title={status?.currentLlmModel ?? undefined}
          >
            {shortModel(status?.currentLlmModel ?? null)}
          </dd>
        </div>
        <div className="rounded-lg bg-black/20 px-3 py-2">
          <dt className="text-xs text-white/40">Media model</dt>
          <dd
            className="truncate text-sm text-white/85"
            title={status?.currentMediaModel ?? undefined}
          >
            {shortModel(status?.currentMediaModel ?? null)}
          </dd>
        </div>
        <div className="rounded-lg bg-black/20 px-3 py-2">
          <dt className="text-xs text-white/40">Last swap</dt>
          <dd className="text-sm text-white/85">
            {status?.lastSwapDurationMs != null
              ? `${Math.round(status.lastSwapDurationMs)} ms`
              : "-"}
          </dd>
        </div>
        <div className="rounded-lg bg-black/20 px-3 py-2">
          <dt className="text-xs text-white/40">VRAM plan</dt>
          <dd className="text-sm text-white/85">
            {tiers
              ? `${Math.round(tiers.projectedAvailableVramMb)} MB free`
              : "Auto"}
          </dd>
        </div>
      </dl>
      {tiers && (
        <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-white/45 sm:grid-cols-4">
          <div className="rounded-lg bg-black/10 px-3 py-1.5">
            Image tiers: {tiers.image.length}
          </div>
          <div className="rounded-lg bg-black/10 px-3 py-1.5">
            Audio tiers: {tiers.audio.length}
          </div>
          <div className="rounded-lg bg-black/10 px-3 py-1.5">
            STT tiers: {tiers.audioStt.length}
          </div>
          <div className="rounded-lg bg-black/10 px-3 py-1.5">
            Video tiers: {tiers.video.length}
          </div>
        </div>
      )}
    </div>
  );
}

const WORKFLOWS = [
  {
    to: "/mediaai",
    label: "Gen Assets",
    icon: ImageIcon,
    desc: "Image · audio · video · music",
  },
  {
    to: "/3dassets",
    label: "3D Assets",
    icon: Box,
    desc: "Text/image to 3D models",
  },
  {
    to: "/design-studio",
    label: "Design",
    icon: Palette,
    desc: "AI UI generation",
  },
  {
    to: "/dailyaidigest",
    label: "News",
    icon: Newspaper,
    desc: "Daily AI digest",
  },
  {
    to: "/inference",
    label: "Engine",
    icon: Cpu,
    desc: "Local model inference",
  },
  { to: "/network", label: "Network", icon: NetworkIcon, desc: "P2P compute" },
  {
    to: "/watchdog",
    label: "Watchdog",
    icon: Eye,
    desc: "Site & price tracking",
  },
] as const;

/** Quick-launch tiles to every workflow screen. */
export function WorkflowsPanel() {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
      <div className="mb-3 flex items-center gap-2">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-fuchsia-500/20 text-fuchsia-300">
          <Grid3x3 className="h-4 w-4" />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-white/90">Workflows</h3>
          <p className="text-xs text-white/50">
            Jump into any workflow - or just describe what you want above.
          </p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {WORKFLOWS.map((w) => (
          <Link
            key={w.to}
            to={w.to}
            className="group flex flex-col gap-1 rounded-xl border border-white/10 bg-black/20 p-3 transition-colors hover:border-primary/40 hover:bg-white/[0.06]"
          >
            <w.icon className="h-4 w-4 text-white/60 group-hover:text-primary" />
            <span className="text-sm font-medium text-white/85">{w.label}</span>
            <span className="text-xs text-white/40">{w.desc}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}

function modeLabel(mode: string | null): string {
  switch (mode) {
    case "build":
      return "Build";
    case "ask":
      return "Ask";
    case "local-agent":
      return "Agent";
    case "plan":
      return "Plan";
    case "conversational":
      return "Chat";
    default:
      return "Chat";
  }
}

function formatSessionTime(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

/** Recent and active chat sessions, with active streams pinned first. */
export function OrionSessionsPanel() {
  const { chats, loading } = useChats(null);
  const { apps } = useLoadApps();
  const { selectChat } = useSelectChat();
  const isStreamingById = useAtomValue(isStreamingByIdAtom);

  const appNameById = useMemo(
    () => new Map(apps.map((app) => [app.id, app.name])),
    [apps],
  );

  const sessions = useMemo(() => {
    return [...chats]
      .sort((a, b) => {
        const aActive = isStreamingById.get(a.id) === true;
        const bActive = isStreamingById.get(b.id) === true;
        if (aActive !== bActive) return aActive ? -1 : 1;
        return b.createdAt.getTime() - a.createdAt.getTime();
      })
      .slice(0, 8);
  }, [chats, isStreamingById]);

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
      <div className="mb-3 flex items-center gap-2">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-500/20 text-emerald-300">
          <MessageSquare className="h-4 w-4" />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-white/90">Sessions</h3>
          <p className="text-xs text-white/50">
            Active runs stay at the top; recent chats stay one click away.
          </p>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-3 text-sm text-white/50">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading sessions...
        </div>
      ) : sessions.length === 0 ? (
        <div className="rounded-lg border border-dashed border-white/10 px-3 py-4 text-sm text-white/45">
          No sessions yet. Run a command above to create one.
        </div>
      ) : (
        <div className="divide-y divide-white/10 overflow-hidden rounded-lg border border-white/10 bg-black/20">
          {sessions.map((chat) => {
            const active = isStreamingById.get(chat.id) === true;
            const title = chat.title?.trim() || "New chat";
            const appName = appNameById.get(chat.appId) ?? `App ${chat.appId}`;
            return (
              <button
                key={chat.id}
                type="button"
                onClick={() =>
                  selectChat({ chatId: chat.id, appId: chat.appId })
                }
                className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-white/[0.05]"
              >
                <span
                  className={
                    "flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md " +
                    (active
                      ? "bg-primary/20 text-primary"
                      : "bg-white/[0.06] text-white/45")
                  }
                >
                  {active ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <MessageSquare className="h-3.5 w-3.5" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-white/85">
                    {title}
                  </span>
                  <span className="block truncate text-xs text-white/40">
                    {appName} - {modeLabel(chat.chatMode)} -{" "}
                    {formatSessionTime(chat.createdAt)}
                  </span>
                </span>
                {active && (
                  <span className="rounded-full bg-primary/15 px-2 py-0.5 text-xs font-medium text-primary">
                    Active
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Short explainer of the Orion command flow. */
export function HowItWorksPanel() {
  const steps = [
    "You issue one command - typed or spoken.",
    "Orion parses it into a plan of capability steps.",
    "Media is generated, swapping models within your VRAM budget.",
    "The app is scaffolded and the Autopilot agent builds it end-to-end.",
    'It runs hands-free - unless you switch to "Ask me".',
  ];
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
      <div className="mb-3 flex items-center gap-2">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/20 text-primary">
          <Layers className="h-4 w-4" />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-white/90">
            How Orion works
          </h3>
          <p className="text-xs text-white/50">One prompt to every workflow.</p>
        </div>
      </div>
      <ol className="flex flex-col gap-1.5">
        {steps.map((s, i) => (
          <li key={i} className="flex items-start gap-2 text-sm text-white/70">
            <span className="mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-primary/25 text-[10px] font-bold text-primary">
              {i + 1}
            </span>
            {s}
          </li>
        ))}
      </ol>
    </div>
  );
}
