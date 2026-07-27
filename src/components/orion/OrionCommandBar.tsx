import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useSetAtom } from "jotai";
import {
  Sparkles,
  Mic,
  MicOff,
  Loader2,
  Send,
  CheckCircle2,
  XCircle,
  MinusCircle,
  Image as ImageIcon,
  Music,
  Video,
  Box,
  Newspaper,
  Eye,
  CircleDollarSign,
  Hammer,
  Gamepad2,
  Palette,
  Volume2,
  VolumeX,
  Zap,
  Hand,
  DownloadCloud,
  Activity,
  Terminal,
  MessageCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ipc } from "@/ipc/types";
import type { MediaJob } from "@/ipc/types";
import type { MediaAspectRatio } from "@/ipc/types/media_queue";
import { useVoiceToText } from "@/hooks/useVoiceToText";
import { useStreamChat } from "@/hooks/useStreamChat";
import { useSelectChat } from "@/hooks/useSelectChat";
import { useInitialChatMode } from "@/hooks/useInitialChatMode";
import { useSettings } from "@/hooks/useSettings";
import { showError } from "@/lib/toast";
import { ensureUsableModelForOrion } from "@/lib/embeddedModelAutoload";
import { OrionExecutorPicker, type OrionExecutor } from "./OrionExecutorPicker";
import { runClaudeCodeTurn } from "./runClaudeCodeTurn";
import { queryKeys } from "@/lib/queryKeys";
import { useQueryClient } from "@tanstack/react-query";
import { flowEventClient } from "@/ipc/types/intent";
import type {
  CapabilityDescriptor,
  CapabilityId,
  CommandIntent,
  FlowRunResult,
  MediaReplyAsset,
  PipelineProgress,
  PipelineRunResult,
  StepResult,
} from "@/ipc/types/intent";
import {
  isStreamingByIdAtom,
  pushRecentViewedChatIdAtom,
} from "@/atoms/chatAtoms";
import {
  detectAspectRatio,
  looksLikeStoryboardScript,
} from "./storyboard_script";
import {
  DEFAULT_MEDIA_RECIPE,
  OrionMediaComposerControls,
  type OrionMediaKind,
  type OrionMediaRecipe,
} from "./OrionMediaComposerControls";
import {
  resolveSelection,
  type OrionMediaSelection,
} from "@/shared/orion_media_catalog";
import { parseDirectMediaCommand } from "@/shared/orion_natural_command";
import { ORION_SESSION_APP_NAME } from "@/shared/orion_session";

export type OrionCommandFocus = "auto" | "software" | "media" | "design";

const CAPABILITY_ICON: Record<CapabilityId, ReactNode> = {
  generate_design: <Palette className="w-3.5 h-3.5" />,
  generate_image: <ImageIcon className="w-3.5 h-3.5" />,
  generate_audio: <Mic className="w-3.5 h-3.5" />,
  generate_music: <Music className="w-3.5 h-3.5" />,
  generate_video: <Video className="w-3.5 h-3.5" />,
  generate_3d_asset: <Box className="w-3.5 h-3.5" />,
  research_news: <Newspaper className="w-3.5 h-3.5" />,
  track_website: <Eye className="w-3.5 h-3.5" />,
  track_price: <CircleDollarSign className="w-3.5 h-3.5" />,
  build_app: <Hammer className="w-3.5 h-3.5" />,
  make_game: <Gamepad2 className="w-3.5 h-3.5" />,
};

/** Capabilities whose output is media we render inline as a chat reply. */
const MEDIA_CAPABILITIES = new Set<CapabilityId>([
  "generate_image",
  "generate_video",
  "generate_audio",
  "generate_music",
  "generate_3d_asset",
]);

function escAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Turn the generated media descriptors into an assistant chat message that
 * renders each asset inline (ChatGPT/Gemini-style) via the custom media tags.
 */
function formatMediaReply(command: string, assets: MediaReplyAsset[]): string {
  const parts: string[] = [];
  for (const asset of assets) {
    if (asset.error || !asset.relativePath) {
      parts.push(
        `Couldn't generate ${asset.kind}${asset.error ? `: ${asset.error}` : ""}.` +
          (asset.setupRoute
            ? " Set up the media backend, then try again."
            : ""),
      );
      continue;
    }
    // All kinds (image/video/audio/model) render large + inline via the media
    // tag — ChatGPT/Gemini-style — rather than the small image-generation card.
    parts.push(
      `<orianbuilder-media-generation kind="${escAttr(asset.kind)}" prompt="${escAttr(asset.prompt)}" path="${escAttr(asset.relativePath)}" absolute-path="${escAttr(asset.absolutePath ?? "")}" mime-type="${escAttr(asset.mimeType)}" duration-ms="${asset.durationMs ?? ""}" state="finished"></orianbuilder-media-generation>`,
    );
  }
  return parts.length
    ? parts.join("\n\n")
    : `No media was generated for: ${command}`;
}

const EXAMPLES = [
  "Generate a cinematic hero image of a mountain sunrise",
  "Make a 10-second lo-fi music track",
  "Generate a 3D model of a low-poly tree",
  "Build a todo app with a custom hero image and a Node backend",
];

const MEDIA_KIND_CAPABILITY: Record<OrionMediaKind, CapabilityId> = {
  image: "generate_image",
  video: "generate_video",
  music: "generate_music",
  speech: "generate_audio",
  threed: "generate_3d_asset",
};

function dimensionsForRecipe(recipe: OrionMediaRecipe): {
  width: number;
  height: number;
} {
  if (recipe.aspectRatio === "16:9") return { width: 1024, height: 576 };
  if (recipe.aspectRatio === "9:16") return { width: 576, height: 1024 };
  if (recipe.aspectRatio === "4:3") return { width: 896, height: 672 };
  if (recipe.aspectRatio === "3:4") return { width: 672, height: 896 };
  return { width: recipe.width, height: recipe.height };
}

function buildMediaIntent(
  command: string,
  recipe: OrionMediaRecipe,
  selection: Required<OrionMediaSelection>,
  appId?: number,
): CommandIntent {
  const modality = recipe.kind;
  const dimensions = dimensionsForRecipe(recipe);
  const options: Record<string, unknown> = {
    quality: recipe.quality,
    aspect_ratio: recipe.aspectRatio,
    width: dimensions.width,
    height: dimensions.height,
    steps: recipe.steps,
    guidance: recipe.guidance,
    duration_s: recipe.durationSeconds,
    ...(recipe.seed == null ? {} : { seed: recipe.seed }),
    ...(recipe.negativePrompt.trim()
      ? { negative_prompt: recipe.negativePrompt.trim() }
      : {}),
  };
  const count = recipe.kind === "image" ? recipe.variations : 1;
  return {
    goal: command,
    appId,
    constraints: {
      media: {
        kind: recipe.kind,
        modelId: selection[modality],
        options,
      },
    },
    steps: Array.from({ length: count }, (_, index) => ({
      id: `${recipe.kind}-${index + 1}`,
      capability: MEDIA_KIND_CAPABILITY[recipe.kind],
      description: `Generate ${recipe.kind}${count > 1 ? ` variation ${index + 1}` : ""}`,
      input: { prompt: command, options },
    })),
  };
}

function titleFromCommand(command: string): string {
  const title = command.trim().replace(/\s+/g, " ");
  return title.length > 80 ? `${title.slice(0, 77)}...` : title;
}

function formatFlowTranscript(result: FlowRunResult): string {
  const lines = [
    `Orion flow ${result.status}.`,
    "",
    `Goal: ${result.goal}`,
    "",
    "Steps:",
  ];

  for (const step of result.steps) {
    const status =
      step.status === "success"
        ? "done"
        : step.status === "failed"
          ? "failed"
          : "skipped";
    lines.push(`- ${step.stepId}: ${status}`);

    if (step.error) {
      lines.push(`  Error: ${step.error}`);
    }

    const outputPath = step.output.outputPath;
    if (typeof outputPath === "string") {
      lines.push(`  Output: ${outputPath}`);
    }
    const artifactPath = step.output.artifactPath;
    if (typeof artifactPath === "string") {
      lines.push(`  Artifact: ${artifactPath}`);
    }
    const designSessionId = step.output.designSessionId;
    if (typeof designSessionId === "number") {
      lines.push(`  Design session: ${designSessionId}`);
    }
    const category = step.output.category;
    const count = step.output.count;
    if (typeof category === "string" && typeof count === "number") {
      lines.push(`  News: ${count} ${category} stories`);
    }
    const trackedUrl = step.output.url;
    if (typeof trackedUrl === "string") {
      lines.push(`  Tracking: ${trackedUrl}`);
    }
    const reason = step.output.reason;
    if (typeof reason === "string") {
      lines.push(`  Note: ${reason}`);
    }
  }

  return lines.join("\n");
}

function formatPipelineTranscript(
  command: string,
  result: PipelineRunResult,
): string {
  const lines = [
    `Orion Factory ${result.status}.`,
    "",
    `Goal: ${command}`,
    "",
    "Phases:",
  ];

  for (const phase of result.phases) {
    lines.push(`- ${phase.phase}: ${phase.status} (${phase.detail})`);
  }

  lines.push("");
  lines.push(
    `Assets: ${result.assetSummary.done} ready, ` +
      `${result.assetSummary.placeholder} placeholder, ` +
      `${result.assetSummary.failed} failed.`,
  );

  if (result.runBuild) {
    lines.push("");
    lines.push("Build launched - continue in the linked build session.");
  }

  return lines.join("\n");
}

/** Icon for one live activity-feed row, by kind + status. */
function ProgressIcon({ event }: { event: PipelineProgress }) {
  if (event.status === "running")
    return <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />;
  if (event.status === "failed")
    return <XCircle className="h-3.5 w-3.5 text-red-400" />;
  if (event.status === "partial")
    return <MinusCircle className="h-3.5 w-3.5 text-amber-300" />;
  if (event.status === "ok")
    return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />;
  // No explicit status → icon by kind.
  if (event.kind === "download")
    return <DownloadCloud className="h-3.5 w-3.5 text-sky-300" />;
  if (event.kind === "log")
    return <Terminal className="h-3.5 w-3.5 text-white/40" />;
  return <Activity className="h-3.5 w-3.5 text-white/50" />;
}

function StepStatusIcon({ status }: { status: StepResult["status"] }) {
  if (status === "success")
    return <CheckCircle2 className="w-4 h-4 text-emerald-400" />;
  if (status === "failed") return <XCircle className="w-4 h-4 text-red-400" />;
  return <MinusCircle className="w-4 h-4 text-white/40" />;
}

/** Per-scene status dot for the inline storyboard progress view. */
function sceneDotClass(
  status: NonNullable<MediaJob["scenes"]>[number]["status"],
) {
  const base =
    "flex h-5 min-w-[1.25rem] items-center justify-center rounded px-1 text-[10px] font-semibold ";
  switch (status) {
    case "generating":
      return base + "bg-primary/30 text-primary animate-pulse";
    case "done":
      return base + "bg-emerald-500/20 text-emerald-300";
    case "failed":
      return base + "bg-red-500/20 text-red-300";
    default:
      return base + "bg-white/10 text-white/40";
  }
}

function jobStatusPillClass(status: MediaJob["status"]): string {
  const base = "rounded-full px-2 py-0.5 text-xs font-medium ";
  if (status === "done") return base + "bg-emerald-500/15 text-emerald-300";
  if (status === "failed") return base + "bg-red-500/15 text-red-300";
  if (status === "cancelled") return base + "bg-white/10 text-white/50";
  return base + "bg-primary/15 text-primary";
}

// ── Storyboard pipeline stage tracker ────────────────────────────────────────

type StoryboardPhaseStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "skipped";

/** Map the job's free-form `stage` string + status onto the fixed pipeline
 *  phases so the UI can show a checklist (parse → scenes → edit → audio →
 *  library) regardless of how granular the backend progress lines are. */
function storyboardPhaseIndex(job: MediaJob): number {
  if (job.status === "done") return 5;
  const s = job.stage ?? "";
  if (s.startsWith("editing")) return 2;
  if (s.startsWith("soundtrack") || s.startsWith("mux")) return 3;
  if (s.startsWith("scene")) return 1;
  if (job.scenes && job.scenes.length > 0) {
    // Past parsing; if every scene finished we're at/after the edit.
    return job.scenes.every((sc) => sc.status === "done") ? 2 : 1;
  }
  return 0;
}

function StoryboardPhaseIcon({ status }: { status: StoryboardPhaseStatus }) {
  if (status === "done")
    return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />;
  if (status === "running")
    return <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />;
  if (status === "failed")
    return <XCircle className="h-3.5 w-3.5 text-red-400" />;
  if (status === "skipped")
    return <MinusCircle className="h-3.5 w-3.5 text-white/35" />;
  return <span className="block h-2 w-2 rounded-full bg-white/20" />;
}

/** Visual pipeline: every step of script → final video, with per-scene dots
 *  under the "Scenes" phase and a synced-audio/tier badge once known. */
function StoryboardPipeline({ job }: { job: MediaJob }) {
  const phase = storyboardPhaseIndex(job);
  const sceneTotal = job.scenes?.length ?? 0;
  const sceneDone = job.scenes?.filter((s) => s.status === "done").length ?? 0;

  const phases: { label: string; detail?: string; skipped?: boolean }[] = [
    { label: "Read the script" },
    {
      label: "Generate scene clips",
      detail: sceneTotal > 0 ? `${sceneDone}/${sceneTotal}` : undefined,
    },
    { label: "Auto-edit (stitch in order)" },
    {
      label:
        job.syncedAudio === true
          ? "Soundtrack — synced by the model"
          : "Soundtrack",
      skipped: job.syncedAudio === true,
    },
    { label: "Save to Library" },
  ];

  const statusFor = (idx: number): StoryboardPhaseStatus => {
    if (phases[idx].skipped && job.status !== "failed") {
      return idx < phase || job.status === "done" ? "skipped" : "pending";
    }
    if (idx < phase) return "done";
    if (idx === phase) {
      if (job.status === "failed") return "failed";
      if (job.status === "running") return "running";
      if (job.status === "done") return "done";
      return "pending";
    }
    return "pending";
  };

  return (
    <div className="flex flex-col gap-1">
      {phases.map((p, idx) => (
        <div key={p.label} className="flex flex-col gap-1">
          <div className="flex items-center gap-2 text-xs">
            <span className="flex w-4 justify-center">
              <StoryboardPhaseIcon status={statusFor(idx)} />
            </span>
            <span
              className={
                statusFor(idx) === "pending"
                  ? "text-white/35"
                  : statusFor(idx) === "failed"
                    ? "text-red-300/90"
                    : "text-white/75"
              }
            >
              {p.label}
            </span>
            {p.detail && <span className="text-white/40">{p.detail}</span>}
            {idx === phase && job.status === "running" && job.stage && (
              <span className="truncate text-white/40">· {job.stage}</span>
            )}
          </div>
          {idx === 1 && job.scenes && job.scenes.length > 0 && (
            <div className="ml-6 flex flex-wrap gap-1.5">
              {job.scenes.map((s) => (
                <span
                  key={s.index}
                  title={`${s.title} - ${s.status}`}
                  className={sceneDotClass(s.status)}
                >
                  {s.index + 1}
                </span>
              ))}
            </div>
          )}
        </div>
      ))}
      {(job.videoTier || job.syncedAudio !== undefined) && (
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {job.videoTier && (
            <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[10px] font-medium text-white/55">
              {job.videoTier}
            </span>
          )}
          {job.syncedAudio === true && (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-300">
              <Volume2 className="h-3 w-3" /> synced audio+video
            </span>
          )}
          <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[10px] font-medium text-white/55">
            {job.aspectRatio}
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * Orion command surface: one box that turns a typed or spoken command into a
 * chained flow via `ipc.flow.runCommand`, and renders the live step results.
 * Self-contained and additive; does not touch the chat input.
 */
export function OrionCommandBar({
  appId,
  initialFocus = "auto",
}: {
  appId?: number;
  initialFocus?: OrionCommandFocus;
}) {
  const [mode, setMode] = useState<"orchestrate" | "chat">("orchestrate");
  /**
   * Who runs this command. Null until the picker seeds itself from the persisted
   * model selection, which is also what runs if the user never opens it.
   */
  const [executor, setExecutor] = useState<OrionExecutor | null>(null);
  const [focus, setFocus] = useState<OrionCommandFocus>(initialFocus);
  const [text, setText] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<FlowRunResult | null>(null);
  const [pipelineResult, setPipelineResult] =
    useState<PipelineRunResult | null>(null);
  const [capabilities, setCapabilities] = useState<CapabilityDescriptor[]>([]);
  // Live activity feed streamed from the running pipeline (downloads, phases,
  // per-asset status). Cleared at the start of each run.
  const [progress, setProgress] = useState<PipelineProgress[]>([]);
  // Live storyboard job (script → video) dispatched to the media queue.
  const [storyboardJobId, setStoryboardJobId] = useState<string | null>(null);
  const [storyboardJob, setStoryboardJob] = useState<MediaJob | null>(null);
  const [muted, setMuted] = useState(false);
  // Output shape for storyboard/video jobs. "auto" infers it from the script
  // ("9:16", "vertical", "shorts", …) and falls back to 16:9.
  const [aspect, setAspect] = useState<"auto" | MediaAspectRatio>("auto");
  const [mediaRecipe, setMediaRecipe] =
    useState<OrionMediaRecipe>(DEFAULT_MEDIA_RECIPE);
  const [mediaSelection, setMediaSelection] = useState<
    Required<OrionMediaSelection>
  >(() => resolveSelection(undefined));
  // Autonomous by default: after the first prompt the agent runs end-to-end with
  // no approval prompts. Toggle off ("Ask me") to get blocking approvals on
  // risky steps. Drives the global `autonomousMode` setting the agent reads.
  const [autonomous, setAutonomous] = useState(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const { streamMessage } = useStreamChat({ hasChatId: false });
  const { selectChat } = useSelectChat();
  const initialChatMode = useInitialChatMode();
  const { settings, updateSettings } = useSettings();
  const queryClient = useQueryClient();
  const setIsStreamingById = useSetAtom(isStreamingByIdAtom);
  const pushRecentViewedChatId = useSetAtom(pushRecentViewedChatIdAtom);

  // Initialise the toggle from the persisted setting once it loads.
  useEffect(() => {
    if (typeof settings?.autonomousMode === "boolean") {
      setAutonomous(settings.autonomousMode);
    }
  }, [settings?.autonomousMode]);

  useEffect(() => {
    const saved = (
      settings as { orionMediaModels?: OrionMediaSelection } | null
    )?.orionMediaModels;
    setMediaSelection(resolveSelection(saved));
  }, [settings]);

  const updateMediaSelection = useCallback(
    (next: Required<OrionMediaSelection>) => {
      setMediaSelection(next);
      void updateSettings({ orionMediaModels: next } as any);
    },
    [updateSettings],
  );

  // Speak a short status update using the browser's built-in TTS (zero-dep).
  const speak = useCallback(
    (message: string) => {
      if (muted || typeof window === "undefined" || !window.speechSynthesis) {
        return;
      }
      try {
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(new SpeechSynthesisUtterance(message));
      } catch {
        /* TTS is best-effort; ignore failures */
      }
    },
    [muted],
  );

  useEffect(() => {
    let active = true;
    ipc.flow
      .listCapabilities()
      .then((caps) => active && setCapabilities(caps))
      .catch(() => {
        /* non-fatal: hint chips just won't show */
      });
    return () => {
      active = false;
    };
  }, []);

  // Subscribe to the live pipeline progress stream (downloads + phases + assets).
  useEffect(() => {
    const off = flowEventClient.onPipelineProgress((p) => {
      setProgress((prev) => [...prev, p].slice(-80));
    });
    return off;
  }, []);

  // Keep the activity feed scrolled to the latest line.
  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
  }, [progress]);

  // Track the dispatched storyboard job so its per-scene progress renders inline.
  useEffect(() => {
    if (!storyboardJobId) return;
    const off = ipc.events.mediaQueue.onChanged(({ jobs }) => {
      const j = jobs.find((x) => x.id === storyboardJobId);
      if (j) setStoryboardJob(j);
    });
    return off;
  }, [storyboardJobId]);

  const handleTranscription = useCallback((transcribed: string) => {
    setText((prev) => (prev ? `${prev} ${transcribed}` : transcribed));
    textareaRef.current?.focus();
  }, []);

  const { isRecording, isTranscribing, toggleRecording } = useVoiceToText({
    enabled: true,
    onTranscription: handleTranscription,
    onError: (message) => showError(message),
  });

  const getOrCreateSessionAppId = useCallback(async (): Promise<number> => {
    const storedAppId = (settings as { orionSessionAppId?: unknown } | null)
      ?.orionSessionAppId;
    if (typeof storedAppId === "number") {
      try {
        await ipc.app.getApp(storedAppId);
        return storedAppId;
      } catch {
        /* stale setting; fall through and recover */
      }
    }

    const listed = await ipc.app.listApps(undefined);
    const existing = listed.apps.find(
      (app) => app.name === ORION_SESSION_APP_NAME,
    );
    if (existing) {
      void updateSettings({ orionSessionAppId: existing.id } as any);
      return existing.id;
    }

    const candidates = [
      ORION_SESSION_APP_NAME,
      `${ORION_SESSION_APP_NAME} 2`,
      `${ORION_SESSION_APP_NAME} ${Date.now()}`,
    ];
    let lastError: unknown;
    for (const name of candidates) {
      try {
        const created = await ipc.app.createApp({
          name,
          initialChatMode: "conversational",
        });
        void updateSettings({ orionSessionAppId: created.app.id } as any);
        void queryClient.invalidateQueries({ queryKey: queryKeys.apps.all });
        return created.app.id;
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("Failed to create an Orion session app.");
  }, [queryClient, settings, updateSettings]);

  const markCommandSessionStreaming = useCallback(
    (chatId: number, streaming: boolean) => {
      setIsStreamingById((prev) => {
        const next = new Map(prev);
        next.set(chatId, streaming);
        return next;
      });
    },
    [setIsStreamingById],
  );

  const createCommandSession = useCallback(
    async (command: string) => {
      const sessionAppId = await getOrCreateSessionAppId();
      // Create the session in local-agent (Agent) mode so FOLLOW-UP prompts the
      // user types in this chat are classified by the LLM and routed to the right
      // media/build tool — instead of being answered as plain conversation.
      const chatId = await ipc.chat.createChat({
        appId: sessionAppId,
        initialChatMode: "local-agent",
      });
      await ipc.chat.updateChat({
        chatId,
        title: titleFromCommand(command),
        chatMode: "local-agent",
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.chats.all });
      pushRecentViewedChatId(chatId);
      return { appId: sessionAppId, chatId };
    },
    [getOrCreateSessionAppId, pushRecentViewedChatId, queryClient],
  );

  /** Manual flow runners persist their own prompt. Chat-stream-owned commands
   *  must not call this because the shared stream handler inserts it exactly
   *  once together with the live assistant placeholder. */
  const persistCommandPrompt = useCallback(
    async (command: string, chatId: number) => {
      await ipc.chat.appendMessages({
        chatId,
        messages: [{ role: "user", content: command }],
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.chats.all });
      markCommandSessionStreaming(chatId, true);
    },
    [markCommandSessionStreaming, queryClient],
  );

  const createConversationSession = useCallback(
    async (command: string) => {
      const sessionAppId = await getOrCreateSessionAppId();
      const chatId = await ipc.chat.createChat({
        appId: sessionAppId,
        initialChatMode: "conversational",
      });
      await ipc.chat.updateChat({
        chatId,
        title: titleFromCommand(command),
        chatMode: "conversational",
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.chats.all });
      pushRecentViewedChatId(chatId);
      return { appId: sessionAppId, chatId };
    },
    [getOrCreateSessionAppId, pushRecentViewedChatId, queryClient],
  );

  const appendFlowResultToSession = useCallback(
    async (chatId: number, flowResult: FlowRunResult) => {
      await ipc.chat.appendMessages({
        chatId,
        messages: [
          { role: "assistant", content: formatFlowTranscript(flowResult) },
        ],
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.chats.all });
    },
    [queryClient],
  );

  const appendFlowErrorToSession = useCallback(
    async (chatId: number, message: string) => {
      await ipc.chat.appendMessages({
        chatId,
        messages: [
          { role: "assistant", content: `Orion flow failed.\n\n${message}` },
        ],
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.chats.all });
    },
    [queryClient],
  );

  // ── Routed cores (lifecycle owned by `launch`) ──────────────────────────────

  /**
   * Media-only command: generate each asset with the user's selected model at
   * the device's best settings, then post an assistant reply that renders the
   * media inline (ChatGPT/Gemini-style) in the command's chat.
   */
  const runMediaCore = useCallback(
    async (
      command: string,
      intent: CommandIntent,
      session: { appId: number; chatId: number },
    ) => {
      // Write files under the session's app so the chat can resolve them.
      const reply = await ipc.flow.generateMedia({
        intent: { ...intent, appId: session.appId },
      });
      await ipc.chat.appendMessages({
        chatId: session.chatId,
        messages: [
          {
            role: "assistant",
            content: formatMediaReply(command, reply.assets),
          },
        ],
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.chats.all });
      const ok = reply.assets.filter((a) => a.relativePath && !a.error).length;
      speak(
        ok > 0
          ? `Generated ${ok} ${ok === 1 ? "asset" : "assets"}.`
          : "Sorry, nothing was generated.",
      );
      markCommandSessionStreaming(session.chatId, false);
      selectChat({ chatId: session.chatId, appId: session.appId });
    },
    [queryClient, speak, markCommandSessionStreaming, selectChat],
  );

  /**
   * Script command: a multi-scene script becomes a storyboard job (parse →
   * per-scene clips → auto-edit → soundtrack), dispatched to the media queue so
   * it runs unattended. If the media backend isn't set up yet, keep the prompt
   * and point the user at "Set up Orion" instead of silently failing.
   */
  const runStoryboardCore = useCallback(
    async (command: string, session: { appId: number; chatId: number }) => {
      const status = await ipc.mediaAi.getStatus().catch(() => null);
      const usable =
        !!status &&
        (status.healthy || (status.venvExists && status.depsInstalled));
      if (!usable) {
        await ipc.chat.appendMessages({
          chatId: session.chatId,
          messages: [
            {
              role: "assistant",
              content:
                "This looks like a multi-scene script, but Orion's media backend isn't set up yet. " +
                "Open Orion → **Set up Orion** to install it (one click, resumes if interrupted), then send this again — it'll render the whole video unattended.",
            },
          ],
        });
        void queryClient.invalidateQueries({ queryKey: queryKeys.chats.all });
        speak("Set up Orion first.");
        markCommandSessionStreaming(session.chatId, false);
        selectChat({ chatId: session.chatId, appId: session.appId });
        return;
      }

      const aspectRatio: MediaAspectRatio =
        aspect !== "auto" ? aspect : (detectAspectRatio(command) ?? "16:9");
      const job = await ipc.mediaQueue.enqueue({
        kind: "storyboard",
        prompt: command,
        aspectRatio,
      });
      setStoryboardJobId(job.id);
      setStoryboardJob(job);
      await ipc.chat.appendMessages({
        chatId: session.chatId,
        messages: [
          {
            role: "assistant",
            content:
              `Storyboard queued (${aspectRatio}). Orion will parse this into scenes, render each ` +
              "clip in order, auto-edit them together and add a soundtrack — or keep the model's " +
              "own synced audio when an LTX-2.3 audio+video tier is running. Progress shows " +
              "here and in Library → Media Queue; the finished video lands in Library → Media.",
          },
        ],
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.chats.all });
      speak("Storyboard queued.");
      markCommandSessionStreaming(session.chatId, false);
      selectChat({ chatId: session.chatId, appId: session.appId });
    },
    [queryClient, speak, markCommandSessionStreaming, selectChat, aspect],
  );

  /** Lighter chained-capability runner (news, tracking, mixed flows). Reuses
   *  the already-parsed intent so there's no redundant LLM parse. */
  const runFlowCore = useCallback(
    async (
      command: string,
      intent: CommandIntent,
      session: { appId: number; chatId: number },
    ) => {
      const flowResult = await ipc.flow.runFlow({ ...intent, appId });
      setResult(flowResult);
      await appendFlowResultToSession(session.chatId, flowResult);
      const ok = flowResult.steps.filter((s) => s.status === "success").length;
      speak(
        `Command ${flowResult.status}. ${ok} of ${flowResult.steps.length} steps succeeded.`,
      );

      // Hands-free build: if a build_app step prepared a handoff, launch the
      // Autopilot agent-build on the new app + chat and navigate to it.
      const buildStep = flowResult.steps.find(
        (s) =>
          s.capability === "build_app" &&
          s.status === "success" &&
          s.output.runBuild === true,
      );
      if (buildStep) {
        const handoff = buildStep.output as {
          appId: number;
          chatId: number;
          buildGoal: string;
        };
        void ipc.chat.updateChat({
          chatId: handoff.chatId,
          title: titleFromCommand(command),
          chatMode: initialChatMode,
        });
        void queryClient.invalidateQueries({ queryKey: queryKeys.chats.all });
        speak("Starting the build.");
        markCommandSessionStreaming(session.chatId, false);
        streamMessage({
          prompt: handoff.buildGoal,
          chatId: handoff.chatId,
          appId: handoff.appId,
          requestedChatMode: initialChatMode,
        });
        selectChat({ chatId: handoff.chatId, appId: handoff.appId });
      }
    },
    [
      appId,
      speak,
      streamMessage,
      selectChat,
      initialChatMode,
      queryClient,
      appendFlowResultToSession,
      markCommandSessionStreaming,
    ],
  );

  /**
   * Orchestrated single-prompt pipeline: the main process plans the asset
   * manifest, batch-generates assets one pipeline at a time (LLM unloaded), then
   * hands off an autonomous Autopilot build that references the generated assets.
   */
  const runFactoryCore = useCallback(
    async (command: string, session: { appId: number; chatId: number }) => {
      const pr = await ipc.flow.runPipeline({ text: command, appId });
      setPipelineResult(pr);
      await ipc.chat.appendMessages({
        chatId: session.chatId,
        messages: [
          { role: "assistant", content: formatPipelineTranscript(command, pr) },
        ],
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.chats.all });
      speak(
        `Pipeline ${pr.status}. ${pr.assetSummary.done} asset${
          pr.assetSummary.done === 1 ? "" : "s"
        } ready.`,
      );

      if (
        pr.runBuild &&
        pr.appId != null &&
        pr.chatId != null &&
        pr.buildGoal
      ) {
        void ipc.chat.updateChat({
          chatId: pr.chatId,
          title: titleFromCommand(command),
          chatMode: initialChatMode,
        });
        void queryClient.invalidateQueries({ queryKey: queryKeys.chats.all });
        speak("Starting the build.");
        markCommandSessionStreaming(session.chatId, false);
        streamMessage({
          prompt: pr.buildGoal,
          chatId: pr.chatId,
          appId: pr.appId,
          requestedChatMode: initialChatMode,
        });
        selectChat({ chatId: pr.chatId, appId: pr.appId });
      }
    },
    [
      appId,
      speak,
      streamMessage,
      selectChat,
      initialChatMode,
      queryClient,
      markCommandSessionStreaming,
    ],
  );

  /**
   * Single entry for the one Orion input: create the command's chat, parse the
   * intent, and route — media-only → inline media reply; an app build → the
   * Factory pipeline; everything else → the chained flow. Build/parse failures
   * fall back to the Factory pipeline so a prompt is never dropped.
   */
  const launch = useCallback(async () => {
    const command = text.trim();
    if (!command || isRunning) return;
    setIsRunning(true);
    setResult(null);
    setPipelineResult(null);
    setProgress([]);
    setStoryboardJob(null);
    setStoryboardJobId(null);
    let session: { appId: number; chatId: number } | null = null;
    let streamOwnsSession = false;
    try {
      // Claude Code runs the command itself, with its own Read/Write/Edit/Bash
      // against the project directory. It does not go through Orion's planner —
      // that would mean intercepting and re-implementing the tools that make it
      // worth using. It still lands in a normal chat session, so the transcript,
      // history and tabs behave like every other conversation.
      if (executor?.kind === "claude-code") {
        const ccSession =
          mode === "chat"
            ? await createConversationSession(command)
            : await createCommandSession(command);
        selectChat({ chatId: ccSession.chatId, appId: ccSession.appId });
        await persistCommandPrompt(command, ccSession.chatId);
        setText("");

        const turn = await runClaudeCodeTurn({
          prompt: command,
          appId: ccSession.appId,
          handlers: {
            // Each tool the CLI runs becomes an activity line, so the user can
            // watch it work instead of staring at a spinner.
            onToolStart: (tool) =>
              setProgress((prev) => [
                ...prev,
                {
                  kind: "log",
                  label: tool.name,
                  detail:
                    typeof tool.input.file_path === "string"
                      ? tool.input.file_path
                      : typeof tool.input.command === "string"
                        ? tool.input.command
                        : undefined,
                  status: "running",
                },
              ]),
            onToolEnd: (tool) =>
              setProgress((prev) => [
                ...prev,
                {
                  kind: "log",
                  label: tool.ok ? "done" : "failed",
                  status: tool.ok ? "ok" : "failed",
                },
              ]),
          },
        });
        if (!turn.ok) {
          // Written into the transcript rather than faked as a FlowRunResult:
          // this turn never went through the flow pipeline, so presenting it as
          // a flow result would misreport what actually ran.
          await appendFlowErrorToSession(
            ccSession.chatId,
            turn.error ?? "Claude Code did not complete the turn.",
          );
        }
        return;
      }

      if (mode === "chat") {
        const chatSession = await createConversationSession(command);
        selectChat({ chatId: chatSession.chatId, appId: chatSession.appId });
        if (!parseDirectMediaCommand(command, chatSession.appId)) {
          await ensureUsableModelForOrion(settings, (model) =>
            updateSettings({ selectedModel: model }),
          );
        }
        streamMessage({
          prompt: command,
          chatId: chatSession.chatId,
          appId: chatSession.appId,
          requestedChatMode: "conversational",
        });
        setText("");
        return;
      }

      session = await createCommandSession(command);
      // Enter the chat immediately so the user sees their prompt right away,
      // instead of waiting on the (slow) parse + generation before navigating.
      selectChat({ chatId: session.chatId, appId: session.appId });
      // Persist the autonomy choice so the agent-build (which reads
      // `autonomousMode`) runs hands-free or asks on risky steps accordingly.
      try {
        await updateSettings({ autonomousMode: autonomous });
      } catch {
        /* non-fatal: keep whatever the setting already was */
      }

      // A multi-scene script → storyboard job. Routed BEFORE the LLM preload
      // because the authored scene format parses deterministically (no model
      // needed), and before intent parsing because a long script would
      // otherwise be misread as a single-clip request.
      if (looksLikeStoryboardScript(command)) {
        await persistCommandPrompt(command, session.chatId);
        await runStoryboardCore(command, session);
        return;
      }

      // Anything mode is genuinely mode-free: an obvious natural-language
      // media request routes immediately without loading the coding LLM or
      // requiring the user to open/select the Media controls.
      const naturalMediaIntent =
        focus === "auto"
          ? parseDirectMediaCommand(command, session.appId)
          : null;

      // Natural-language media commands use the same streamed chat lifecycle
      // as every other message. This gives them a live placeholder, backend
      // progress, cancellation, durable errors, and an immediate inline result
      // without asking the user to choose a mode or model first.
      if (naturalMediaIntent) {
        streamOwnsSession = true;
        streamMessage({
          prompt: command,
          chatId: session.chatId,
          appId: session.appId,
          requestedChatMode: "local-agent",
        });
        setText("");
        return;
      }

      await persistCommandPrompt(command, session.chatId);

      // Immediate feedback so the command's chat isn't blank during the
      // (sometimes multi-minute) pre-build phase — loading the local model on
      // first use, generating requested assets, then planning. Without this the
      // user stares at an empty chat until the build chat opens.
      const postStatus = (content: string) =>
        ipc.chat
          .appendMessages({
            chatId: session!.chatId,
            messages: [{ role: "assistant", content }],
          })
          .then(() =>
            queryClient.invalidateQueries({ queryKey: queryKeys.chats.all }),
          )
          .catch(() => undefined);
      await postStatus(
        focus === "media" || naturalMediaIntent
          ? "**Media recipe locked.** Starting the selected local model and rendering the result here."
          : focus === "design"
            ? "**Design workspace ready.** Turning the brief into a structured design artifact."
            : "**On it — working locally.** Getting the right model ready, then planning and completing the work here.",
      );

      // Explicit media/design modes do not need an LLM intent parse. Skipping
      // that load preserves RAM/VRAM for the selected generator and makes the
      // recipe deterministic. Auto mode still plans mixed multi-tool requests.
      if (focus === "media") {
        const mediaIntent = buildMediaIntent(
          command,
          mediaRecipe,
          mediaSelection,
          session.appId,
        );
        await runMediaCore(command, mediaIntent, session);
        return;
      }

      if (focus === "design") {
        const designIntent: CommandIntent = {
          goal: command,
          appId: session.appId,
          steps: [
            {
              id: "design-1",
              capability: "generate_design",
              description: "Create an Open Design artifact",
              input: { prompt: command },
            },
          ],
        };
        await runFlowCore(command, designIntent, session);
        return;
      }

      // Guarantee Orion has a usable model: if the picker is on a cloud/"auto"
      // model that can't run here (no keys / offline), load the local embedded
      // model and select it so the whole pipeline (parse → plan → agent build)
      // runs locally instead of failing. The status callback keeps the chat
      // alive during a slow first-time model load.
      await ensureUsableModelForOrion(
        settings,
        (model) => updateSettings({ selectedModel: model }),
        postStatus,
      );

      if (focus === "software") {
        await runFactoryCore(command, session);
        return;
      }

      let intent: CommandIntent | null = null;
      try {
        intent = await ipc.flow.parseCommand({
          text: command,
          appId: session.appId,
        });
      } catch {
        /* parse failed → fall through to the Factory build path */
      }

      const hasBuild = !!intent?.steps.some(
        (s) => s.capability === "build_app",
      );
      const hasMedia = !!intent?.steps.some((s) =>
        MEDIA_CAPABILITIES.has(s.capability),
      );

      if (intent && hasMedia && !hasBuild) {
        await runMediaCore(command, intent, session);
      } else if (intent && !hasBuild && intent.steps.length > 0) {
        await runFlowCore(command, intent, session);
      } else {
        await runFactoryCore(command, session);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (session) {
        await appendFlowErrorToSession(session.chatId, message).catch(
          () => undefined,
        );
      }
      showError(message);
      speak("Sorry, the command failed.");
    } finally {
      if (session && !streamOwnsSession) {
        markCommandSessionStreaming(session.chatId, false);
      }
      setIsRunning(false);
    }
  }, [
    text,
    mode,
    focus,
    appId,
    isRunning,
    autonomous,
    executor,
    mediaRecipe,
    mediaSelection,
    updateSettings,
    settings,
    createConversationSession,
    createCommandSession,
    persistCommandPrompt,
    streamMessage,
    selectChat,
    runMediaCore,
    runFlowCore,
    runFactoryCore,
    runStoryboardCore,
    appendFlowErrorToSession,
    markCommandSessionStreaming,
    speak,
  ]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void launch();
    }
  };

  return (
    <div className="w-full rounded-[22px] border border-border/80 bg-card/72 p-4 shadow-[0_18px_60px_rgba(0,0,0,0.18)] backdrop-blur-xl">
      <div className="mb-3 flex items-center gap-2">
        <div className="flex h-7 w-7 items-center justify-center rounded-2xl bg-primary/20 text-primary">
          <Sparkles className="h-4 w-4" />
        </div>
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-foreground">
            {mode === "chat" ? "Chat with Orion" : "Orion Command"}
          </h3>
          <p className="text-xs text-muted-foreground">
            {mode === "chat"
              ? "A focused conversation using your local model."
              : "One command, all workflows - chained automatically."}
          </p>
        </div>
        {/* Who runs this. Sits next to the mode toggle because the two together
            are the whole routing decision: what kind of work, and on what. */}
        <OrionExecutorPicker value={executor} onChange={setExecutor} />
        <div className="inline-flex rounded-xl border border-border/70 bg-muted/30 p-0.5 text-xs">
          <button
            type="button"
            onClick={() => setMode("orchestrate")}
            disabled={isRunning}
            className={
              "inline-flex items-center gap-1 rounded-3xl px-2.5 py-1 transition-colors " +
              (mode === "orchestrate"
                ? "bg-primary/20 text-primary"
                : "text-muted-foreground hover:text-foreground")
            }
          >
            <Sparkles className="h-3.5 w-3.5" />
            Create
          </button>
          <button
            type="button"
            onClick={() => setMode("chat")}
            disabled={isRunning}
            className={
              "inline-flex items-center gap-1 rounded-3xl px-2.5 py-1 transition-colors " +
              (mode === "chat"
                ? "bg-primary/20 text-primary"
                : "text-muted-foreground hover:text-foreground")
            }
          >
            <MessageCircle className="h-3.5 w-3.5" />
            Chat
          </button>
        </div>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          title={muted ? "Unmute spoken status" : "Mute spoken status"}
          onClick={() => setMuted((m) => !m)}
          className="h-7 w-7 text-muted-foreground hover:text-foreground"
        >
          {muted ? (
            <VolumeX className="h-4 w-4" />
          ) : (
            <Volume2 className="h-4 w-4" />
          )}
        </Button>
      </div>

      <div className="relative">
        <textarea
          ref={textareaRef}
          data-testid="orion-command-input"
          aria-label={mode === "chat" ? "Chat with Orion" : "Orion command"}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          placeholder={
            mode === "chat"
              ? "Ask Orion anything..."
              : 'Describe what to build or generate... e.g. "Build a todo app with a hero image"'
          }
          className="w-full resize-none rounded-2xl border border-border bg-background/60 px-3 py-3 pr-24 text-sm text-foreground placeholder:text-muted-foreground/60 outline-none transition-colors focus:border-primary/55"
          disabled={isRunning}
        />
        <div className="absolute bottom-2.5 right-2.5 flex items-center gap-1.5">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            title={isRecording ? "Stop dictation" : "Dictate command"}
            onClick={toggleRecording}
            disabled={isRunning || isTranscribing}
            className="h-8 w-8 text-muted-foreground hover:text-foreground"
          >
            {isTranscribing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : isRecording ? (
              <MicOff className="h-4 w-4 text-red-400" />
            ) : (
              <Mic className="h-4 w-4" />
            )}
          </Button>
          <Button
            type="button"
            size="icon"
            title="Run command (Cmd/Ctrl + Enter)"
            aria-label="Run Orion command"
            onClick={() => void launch()}
            disabled={isRunning || !text.trim()}
            className="h-8 w-8"
          >
            {isRunning ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </Button>
        </div>
      </div>

      {mode === "orchestrate" && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-medium text-muted-foreground">
            Make
          </span>
          <div className="inline-flex rounded-xl border border-border/70 bg-muted/25 p-0.5 text-xs">
            {(
              [
                ["auto", "Anything", Sparkles],
                ["software", "Software", Hammer],
                ["media", "Media", ImageIcon],
                ["design", "Design", Palette],
              ] as const
            ).map(([value, label, Icon]) => (
              <button
                key={value}
                type="button"
                onClick={() => setFocus(value)}
                disabled={isRunning}
                className={
                  "inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 transition-colors " +
                  (focus === value
                    ? "bg-primary/16 text-primary"
                    : "text-muted-foreground hover:bg-background/50 hover:text-foreground")
                }
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </div>
          <span className="text-[11px] text-muted-foreground">
            {focus === "auto"
              ? "Orion chooses and chains the right tools."
              : focus === "media"
                ? "Uses this recipe without loading an LLM first."
                : focus === "software"
                  ? "Plans, builds, tests, and prepares delivery."
                  : "Creates an editable Open Design artifact."}
          </span>
        </div>
      )}

      {mode === "orchestrate" && focus === "media" && (
        <OrionMediaComposerControls
          value={mediaRecipe}
          selection={mediaSelection}
          onChange={setMediaRecipe}
          onSelectionChange={updateMediaSelection}
          disabled={isRunning}
        />
      )}

      {/* Autonomy toggle - autonomous by default; "Ask me" enables approvals */}
      {mode === "orchestrate" && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-xl border border-border/70 bg-muted/25 p-0.5 text-xs">
            <button
              type="button"
              onClick={() => setAutonomous(true)}
              disabled={isRunning}
              className={
                "inline-flex items-center gap-1 rounded-3xl px-2.5 py-1 transition-colors " +
                (autonomous
                  ? "bg-primary/20 text-primary"
                  : "text-muted-foreground hover:text-foreground")
              }
            >
              <Zap className="h-3.5 w-3.5" />
              Autonomous
            </button>
            <button
              type="button"
              onClick={() => setAutonomous(false)}
              disabled={isRunning}
              className={
                "inline-flex items-center gap-1 rounded-3xl px-2.5 py-1 transition-colors " +
                (!autonomous
                  ? "bg-amber-500/20 text-amber-300"
                  : "text-muted-foreground hover:text-foreground")
              }
            >
              <Hand className="h-3.5 w-3.5" />
              Ask me
            </button>
          </div>
          <span className="text-xs text-muted-foreground">
            {autonomous
              ? "Runs end-to-end - no interruptions."
              : "Pauses for approval on risky steps."}
          </span>

          {/* Aspect ratio for video/storyboard output. Auto reads the script. */}
          {focus !== "media" && (
            <div className="ml-auto inline-flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground">
                Storyboard ratio
              </span>
              <div className="inline-flex rounded-xl border border-border/70 bg-muted/25 p-0.5 text-xs">
                {(["auto", "16:9", "9:16", "1:1"] as const).map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setAspect(r)}
                    disabled={isRunning}
                    title={
                      r === "auto"
                        ? "Detect from the script (vertical/shorts → 9:16); defaults to 16:9"
                        : `Render video at ${r}`
                    }
                    className={
                      "rounded-3xl px-2 py-1 transition-colors " +
                      (aspect === r
                        ? "bg-primary/20 text-primary"
                        : "text-muted-foreground hover:text-foreground")
                    }
                  >
                    {r === "auto" ? "Auto" : r}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Example chips - shown only before a run */}
      {mode === "orchestrate" && !result && !pipelineResult && !isRunning && (
        <div className="mt-3 flex flex-wrap gap-2">
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              type="button"
              onClick={() => setText(ex)}
              className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-xs text-white/60 transition-colors hover:border-primary/40 hover:text-white/90"
            >
              {ex}
            </button>
          ))}
        </div>
      )}

      {/* Capability hints */}
      {mode === "orchestrate" &&
        capabilities.length > 0 &&
        !result &&
        !pipelineResult &&
        !isRunning && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-white/40">
            <span>Capabilities:</span>
            {capabilities.map((c) => (
              <span
                key={c.id}
                className="inline-flex items-center gap-1 rounded-3xl bg-white/[0.04] px-2 py-0.5 text-white/55"
                title={c.description}
              >
                {CAPABILITY_ICON[c.id]}
                {c.label}
              </span>
            ))}
          </div>
        )}

      {/* Running indicator */}
      {isRunning && (
        <div className="mt-3 flex items-center gap-2 text-sm text-white/60">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          Understanding your command and getting to work...
        </div>
      )}

      {/* Live activity feed - downloads, phase transitions, per-asset status */}
      {progress.length > 0 && (
        <div className="mt-3 rounded-3xl border border-white/10 bg-black/30 p-2.5">
          <div className="mb-1.5 flex items-center gap-1.5 px-1 text-xs font-medium text-white/55">
            <Activity className="h-3.5 w-3.5" />
            Activity
          </div>
          <div
            ref={feedRef}
            className="flex max-h-48 flex-col gap-1 overflow-y-auto pr-1"
          >
            {progress.map((p, i) => (
              <div
                key={i}
                className="flex items-start gap-2 rounded-3xl px-1 py-0.5 text-xs"
              >
                <span className="mt-0.5 flex-shrink-0">
                  <ProgressIcon event={p} />
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    className={
                      p.status === "failed"
                        ? "text-red-300/90"
                        : "text-white/75"
                    }
                  >
                    {p.label}
                  </span>
                  {p.detail && (
                    <span
                      className={
                        "ml-1.5 break-all " +
                        (p.kind === "log"
                          ? "font-mono text-[11px] text-white/35"
                          : "text-white/40")
                      }
                    >
                      {p.detail}
                    </span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Storyboard job (script → video) progress: full pipeline checklist */}
      {storyboardJob && (
        <div className="mt-4 rounded-3xl border border-white/10 bg-black/20 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="inline-flex items-center gap-1.5 text-sm font-medium text-white/85">
              <Video className="h-4 w-4" /> Storyboard
            </span>
            <span className={jobStatusPillClass(storyboardJob.status)}>
              {storyboardJob.status}
            </span>
          </div>
          {storyboardJob.status === "queued" &&
          (!storyboardJob.scenes || storyboardJob.scenes.length === 0) ? (
            <p className="text-xs text-white/45">
              Queued - parsing the script into scenes...
            </p>
          ) : (
            <StoryboardPipeline job={storyboardJob} />
          )}
          {storyboardJob.warning && (
            <p className="mt-2 text-xs text-amber-300/80">
              {storyboardJob.warning}
            </p>
          )}
          {storyboardJob.error && (
            <p className="mt-2 text-xs text-red-300/80">
              {storyboardJob.error}
            </p>
          )}
          {storyboardJob.status === "done" && (
            <p className="mt-2 text-xs text-emerald-300/80">
              Finished - open Library &rarr; Media to view the video.
            </p>
          )}
        </div>
      )}

      {/* Factory (pipeline) result */}
      {pipelineResult && (
        <div className="mt-4 rounded-3xl border border-white/10 bg-black/20 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium text-white/85">
              Orion Factory
            </span>
            <span
              className={
                "rounded-full px-2 py-0.5 text-xs font-medium " +
                (pipelineResult.status === "completed"
                  ? "bg-emerald-500/15 text-emerald-300"
                  : pipelineResult.status === "failed"
                    ? "bg-red-500/15 text-red-300"
                    : "bg-amber-500/15 text-amber-300")
              }
            >
              {pipelineResult.status}
            </span>
          </div>
          <ul className="flex flex-col gap-1.5">
            {pipelineResult.phases.map((p) => (
              <li
                key={p.phase}
                className="flex items-center gap-2 rounded-2xl bg-white/[0.03] px-2.5 py-1.5 text-sm text-white/75"
              >
                <StepStatusIcon
                  status={
                    p.status === "ok"
                      ? "success"
                      : p.status === "failed"
                        ? "failed"
                        : "skipped"
                  }
                />
                <span className="flex-1 capitalize">{p.phase}</span>
                <span
                  className="max-w-[55%] truncate text-xs text-white/45"
                  title={p.detail}
                >
                  {p.detail}
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex items-center gap-3 text-xs text-white/45">
            <span className="inline-flex items-center gap-1">
              <ImageIcon className="h-3 w-3" />{" "}
              {pipelineResult.assetSummary.done} ready
            </span>
            {pipelineResult.assetSummary.placeholder > 0 && (
              <span>{pipelineResult.assetSummary.placeholder} placeholder</span>
            )}
            {pipelineResult.assetSummary.failed > 0 && (
              <span className="text-red-300/80">
                {pipelineResult.assetSummary.failed} failed
              </span>
            )}
            {pipelineResult.runBuild && (
              <span className="inline-flex items-center gap-1 text-emerald-300/80">
                <Hammer className="h-3 w-3" /> build launched
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={() => setPipelineResult(null)}
            className="mt-2 text-xs text-white/40 hover:text-white/70"
          >
            Run another command
          </button>
        </div>
      )}

      {/* Results */}
      {result && (
        <div className="mt-4 rounded-3xl border border-white/10 bg-black/20 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium text-white/85">
              {result.goal}
            </span>
            <span
              className={
                "rounded-full px-2 py-0.5 text-xs font-medium " +
                (result.status === "completed"
                  ? "bg-emerald-500/15 text-emerald-300"
                  : result.status === "failed"
                    ? "bg-red-500/15 text-red-300"
                    : "bg-amber-500/15 text-amber-300")
              }
            >
              {result.status}
            </span>
          </div>
          <ul className="flex flex-col gap-1.5">
            {result.steps.map((step) => {
              const setupRequired = step.output.setupRequired === true;
              const reason =
                typeof step.output.reason === "string"
                  ? step.output.reason
                  : undefined;
              return (
                <li
                  key={step.stepId}
                  className="flex items-center gap-2 rounded-2xl bg-white/[0.03] px-2.5 py-1.5 text-sm text-white/75"
                >
                  <StepStatusIcon status={step.status} />
                  <span className="inline-flex items-center gap-1 text-white/50">
                    {CAPABILITY_ICON[step.capability]}
                  </span>
                  <span className="flex-1 truncate">{step.stepId}</span>
                  {step.error ? (
                    <span
                      className="max-w-[40%] truncate text-xs text-red-300/80"
                      title={step.error}
                    >
                      {step.error}
                    </span>
                  ) : setupRequired ? (
                    <span
                      className="max-w-[40%] truncate rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-300"
                      title={reason}
                    >
                      setup required
                    </span>
                  ) : (
                    <span className="text-xs text-white/35">
                      {Math.round(step.durationMs)}ms
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          <button
            type="button"
            onClick={() => setResult(null)}
            className="mt-2 text-xs text-white/40 hover:text-white/70"
          >
            Run another command
          </button>
        </div>
      )}
    </div>
  );
}
