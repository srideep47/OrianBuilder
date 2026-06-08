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
  Palette,
  Volume2,
  VolumeX,
  Zap,
  Hand,
  DownloadCloud,
  Activity,
  Terminal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ipc } from "@/ipc/types";
import { useVoiceToText } from "@/hooks/useVoiceToText";
import { useStreamChat } from "@/hooks/useStreamChat";
import { useSelectChat } from "@/hooks/useSelectChat";
import { useInitialChatMode } from "@/hooks/useInitialChatMode";
import { useSettings } from "@/hooks/useSettings";
import { showError } from "@/lib/toast";
import { ensureSelectedEmbeddedModelReady } from "@/lib/embeddedModelAutoload";
import { queryKeys } from "@/lib/queryKeys";
import { useQueryClient } from "@tanstack/react-query";
import { flowEventClient } from "@/ipc/types/intent";
import type {
  CapabilityDescriptor,
  CapabilityId,
  FlowRunResult,
  PipelineProgress,
  PipelineRunResult,
  StepResult,
} from "@/ipc/types/intent";
import {
  isStreamingByIdAtom,
  pushRecentViewedChatIdAtom,
} from "@/atoms/chatAtoms";

const CAPABILITY_ICON: Record<CapabilityId, ReactNode> = {
  generate_design: <Palette className="w-3.5 h-3.5" />,
  generate_image: <ImageIcon className="w-3.5 h-3.5" />,
  generate_audio: <Music className="w-3.5 h-3.5" />,
  generate_video: <Video className="w-3.5 h-3.5" />,
  generate_3d_asset: <Box className="w-3.5 h-3.5" />,
  research_news: <Newspaper className="w-3.5 h-3.5" />,
  track_website: <Eye className="w-3.5 h-3.5" />,
  track_price: <CircleDollarSign className="w-3.5 h-3.5" />,
  build_app: <Hammer className="w-3.5 h-3.5" />,
};

const EXAMPLES = [
  "Build a todo app with a custom hero image and a Node backend",
  "Generate a cinematic hero image of a mountain sunrise",
  "Create a landing page for a coffee brand with a logo and a promo video",
];

const ORION_SESSION_APP_NAME = "Orion Sessions";

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

/**
 * Orion command surface: one box that turns a typed or spoken command into a
 * chained flow via `ipc.flow.runCommand`, and renders the live step results.
 * Self-contained and additive; does not touch the chat input.
 */
export function OrionCommandBar({ appId }: { appId?: number }) {
  const [text, setText] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [result, setResult] = useState<FlowRunResult | null>(null);
  const [pipelineResult, setPipelineResult] =
    useState<PipelineRunResult | null>(null);
  // "factory" = orchestrated single-prompt pipeline (plan → batch assets →
  // verify → autonomous build). "flow" = the lighter chained-capability runner.
  const [mode, setMode] = useState<"factory" | "flow">("factory");
  const [capabilities, setCapabilities] = useState<CapabilityDescriptor[]>([]);
  // Live activity feed streamed from the running pipeline (downloads, phases,
  // per-asset status). Cleared at the start of each run.
  const [progress, setProgress] = useState<PipelineProgress[]>([]);
  const [muted, setMuted] = useState(false);
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
      const chatId = await ipc.chat.createChat({
        appId: sessionAppId,
        initialChatMode: "conversational",
      });
      await ipc.chat.updateChat({
        chatId,
        title: titleFromCommand(command),
        chatMode: "conversational",
      });
      await ipc.chat.appendMessages({
        chatId,
        messages: [{ role: "user", content: command }],
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.chats.all });
      pushRecentViewedChatId(chatId);
      markCommandSessionStreaming(chatId, true);
      return { appId: sessionAppId, chatId };
    },
    [
      getOrCreateSessionAppId,
      markCommandSessionStreaming,
      pushRecentViewedChatId,
      queryClient,
    ],
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

  const run = useCallback(async () => {
    const command = text.trim();
    if (!command || isRunning) return;
    setIsRunning(true);
    setResult(null);
    setProgress([]);
    let commandSession: { appId: number; chatId: number } | null = null;
    // Persist the autonomy choice so the agent-build (which reads
    // `autonomousMode`) runs hands-free or asks on risky steps accordingly.
    try {
      commandSession = await createCommandSession(command);
      try {
        await updateSettings({ autonomousMode: autonomous });
      } catch {
        /* non-fatal: fall back to whatever the setting already was */
      }

      await ensureSelectedEmbeddedModelReady(settings);

      const flowResult = await ipc.flow.runCommand({ text: command, appId });
      setResult(flowResult);
      await appendFlowResultToSession(commandSession.chatId, flowResult);
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
        markCommandSessionStreaming(commandSession.chatId, false);
        streamMessage({
          prompt: handoff.buildGoal,
          chatId: handoff.chatId,
          appId: handoff.appId,
          requestedChatMode: initialChatMode,
        });
        selectChat({ chatId: handoff.chatId, appId: handoff.appId });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (commandSession) {
        await appendFlowErrorToSession(commandSession.chatId, message).catch(
          () => undefined,
        );
      }
      showError(message);
      speak("Sorry, the command failed.");
    } finally {
      if (commandSession) {
        markCommandSessionStreaming(commandSession.chatId, false);
      }
      setIsRunning(false);
    }
  }, [
    text,
    appId,
    isRunning,
    speak,
    streamMessage,
    selectChat,
    initialChatMode,
    autonomous,
    updateSettings,
    settings,
    queryClient,
    createCommandSession,
    appendFlowResultToSession,
    appendFlowErrorToSession,
    markCommandSessionStreaming,
  ]);

  /**
   * Orchestrated single-prompt pipeline: the main process plans the asset
   * manifest, batch-generates assets one pipeline at a time (LLM unloaded), then
   * hands off an autonomous Autopilot build that references the generated assets.
   */
  const runFactory = useCallback(async () => {
    const command = text.trim();
    if (!command || isRunning) return;
    setIsRunning(true);
    setResult(null);
    setPipelineResult(null);
    setProgress([]);
    // Persist the prompt as a session up front so it stays accessible from the
    // Sessions panel even if you navigate to another screen mid-run. The
    // pipeline is long-running (plan -> assets -> build); without this the chat
    // only existed after it finished.
    let commandSession: { appId: number; chatId: number } | null = null;
    try {
      commandSession = await createCommandSession(command);
      try {
        await updateSettings({ autonomousMode: autonomous });
      } catch {
        /* non-fatal */
      }
      await ensureSelectedEmbeddedModelReady(settings);

      const pr = await ipc.flow.runPipeline({ text: command, appId });
      setPipelineResult(pr);
      await ipc.chat.appendMessages({
        chatId: commandSession.chatId,
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
        markCommandSessionStreaming(commandSession.chatId, false);
        streamMessage({
          prompt: pr.buildGoal,
          chatId: pr.chatId,
          appId: pr.appId,
          requestedChatMode: initialChatMode,
        });
        selectChat({ chatId: pr.chatId, appId: pr.appId });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (commandSession) {
        await appendFlowErrorToSession(commandSession.chatId, message).catch(
          () => undefined,
        );
      }
      showError(message);
      speak("Sorry, the build failed.");
    } finally {
      if (commandSession) {
        markCommandSessionStreaming(commandSession.chatId, false);
      }
      setIsRunning(false);
    }
  }, [
    text,
    appId,
    isRunning,
    speak,
    streamMessage,
    selectChat,
    initialChatMode,
    autonomous,
    updateSettings,
    settings,
    queryClient,
    createCommandSession,
    appendFlowErrorToSession,
    markCommandSessionStreaming,
  ]);

  const launch = useCallback(() => {
    void (mode === "factory" ? runFactory() : run());
  }, [mode, runFactory, run]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      launch();
    }
  };

  return (
    <div className="w-full rounded-2xl border border-white/10 bg-white/[0.04] p-4 shadow-lg backdrop-blur">
      <div className="mb-3 flex items-center gap-2">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/20 text-primary">
          <Sparkles className="h-4 w-4" />
        </div>
        <div className="flex-1">
          <h3 className="text-sm font-semibold text-white/90">Orion Command</h3>
          <p className="text-xs text-white/50">
            One command, all workflows - chained automatically.
          </p>
        </div>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          title={muted ? "Unmute spoken status" : "Mute spoken status"}
          onClick={() => setMuted((m) => !m)}
          className="h-7 w-7 text-white/50 hover:text-white/90"
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
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          placeholder='Describe what to build or generate... e.g. "Build a todo app with a hero image"'
          className="w-full resize-none rounded-xl border border-white/10 bg-black/20 px-3 py-2.5 pr-24 text-sm text-white/90 placeholder:text-white/30 outline-none focus:border-primary/50"
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
            className="h-8 w-8 text-white/70 hover:text-white"
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
            onClick={launch}
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

      {/* Mode toggle - Factory (orchestrated pipeline) vs Flow (chained run) */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg border border-white/10 bg-black/20 p-0.5 text-xs">
          <button
            type="button"
            onClick={() => setMode("factory")}
            disabled={isRunning}
            className={
              "inline-flex items-center gap-1 rounded-md px-2.5 py-1 transition-colors " +
              (mode === "factory"
                ? "bg-primary/20 text-primary"
                : "text-white/50 hover:text-white/80")
            }
            title="Plan → batch-generate assets (one model at a time) → autonomous build"
          >
            <Sparkles className="h-3.5 w-3.5" />
            Factory
          </button>
          <button
            type="button"
            onClick={() => setMode("flow")}
            disabled={isRunning}
            className={
              "inline-flex items-center gap-1 rounded-md px-2.5 py-1 transition-colors " +
              (mode === "flow"
                ? "bg-primary/20 text-primary"
                : "text-white/50 hover:text-white/80")
            }
            title="Lighter chained-capability runner"
          >
            <Hammer className="h-3.5 w-3.5" />
            Flow
          </button>
        </div>
      </div>

      {/* Autonomy toggle - autonomous by default; "Ask me" enables approvals */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-lg border border-white/10 bg-black/20 p-0.5 text-xs">
          <button
            type="button"
            onClick={() => setAutonomous(true)}
            disabled={isRunning}
            className={
              "inline-flex items-center gap-1 rounded-md px-2.5 py-1 transition-colors " +
              (autonomous
                ? "bg-primary/20 text-primary"
                : "text-white/50 hover:text-white/80")
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
              "inline-flex items-center gap-1 rounded-md px-2.5 py-1 transition-colors " +
              (!autonomous
                ? "bg-amber-500/20 text-amber-300"
                : "text-white/50 hover:text-white/80")
            }
          >
            <Hand className="h-3.5 w-3.5" />
            Ask me
          </button>
        </div>
        <span className="text-xs text-white/40">
          {autonomous
            ? "Runs end-to-end - no interruptions."
            : "Pauses for approval on risky steps."}
        </span>
      </div>

      {/* Example chips - shown only before a run */}
      {!result && !pipelineResult && !isRunning && (
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
      {capabilities.length > 0 && !result && !pipelineResult && !isRunning && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-white/40">
          <span>Capabilities:</span>
          {capabilities.map((c) => (
            <span
              key={c.id}
              className="inline-flex items-center gap-1 rounded-md bg-white/[0.04] px-2 py-0.5 text-white/55"
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
          {mode === "factory"
            ? "Planning, generating assets, and building..."
            : "Orchestrating your command..."}
        </div>
      )}

      {/* Live activity feed - downloads, phase transitions, per-asset status */}
      {progress.length > 0 && (
        <div className="mt-3 rounded-xl border border-white/10 bg-black/30 p-2.5">
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
                className="flex items-start gap-2 rounded-md px-1 py-0.5 text-xs"
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

      {/* Factory (pipeline) result */}
      {pipelineResult && (
        <div className="mt-4 rounded-xl border border-white/10 bg-black/20 p-3">
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
                className="flex items-center gap-2 rounded-lg bg-white/[0.03] px-2.5 py-1.5 text-sm text-white/75"
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
        <div className="mt-4 rounded-xl border border-white/10 bg-black/20 p-3">
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
                  className="flex items-center gap-2 rounded-lg bg-white/[0.03] px-2.5 py-1.5 text-sm text-white/75"
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
