import {
  useState,
  useEffect,
  useRef,
  useCallback,
  type KeyboardEvent,
} from "react";
import type { ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ipc } from "@/ipc/types";
import type {
  DesignSkill,
  DesignSystem,
  DesignChatMessage,
  DesignSessionSummary,
} from "@/ipc/types";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useNavigate } from "@tanstack/react-router";
import {
  Palette,
  Send,
  Square,
  ChevronDown,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Monitor,
  Smartphone,
  Tablet,
  User,
  Bot,
  Trash2,
  PanelLeft,
  Plus,
  Clock,
  Download,
  MessageSquare,
  Sparkles,
  BookOpen,
  Star,
  FileText,
  Archive,
  Cpu,
  Zap,
  Settings2,
  ChevronRight,
} from "lucide-react";
import {
  MODES,
  FIDELITY_LEVELS,
  VISUAL_DIRECTIONS,
  SCENARIOS,
  AUDIENCES,
  TONES,
  PROMPT_GALLERY,
  type DesignMode,
  type FidelityLevel,
  type DirectionId,
} from "./constants";
import {
  buildSystemPrompt,
  withArtifactReminder,
  buildCritiquePrompt,
} from "./prompt-builder";

// =============================================================================
// Constants
// =============================================================================
const logger = {
  error: (...a: unknown[]) => console.error("[design-studio]", ...a),
};
const EMBEDDED_BASE_URL = "http://127.0.0.1:11435";

// =============================================================================
// Provider types
// =============================================================================
type DesignProvider =
  | "embedded-llama"
  | "claude-code"
  | "ollama"
  | "openai-compat";

interface ProviderSettings {
  provider: DesignProvider;
  claudeModel: string;
  ollamaUrl: string;
  ollamaModel: string;
  openAiCompatUrl: string;
  openAiCompatKey: string;
  openAiCompatModel: string;
}

const CLAUDE_MODELS = [
  { id: "claude-opus-4-7", label: "Opus 4.7", hint: "Most powerful" },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6", hint: "Balanced · default" },
  { id: "claude-haiku-4-5", label: "Haiku 4.5", hint: "Fastest" },
] as const;

const PROVIDER_META: Record<
  DesignProvider,
  { label: string; shortLabel: string; icon: ReactNode; color: string }
> = {
  "embedded-llama": {
    label: "Local Llama",
    shortLabel: "Llama",
    icon: <Cpu className="h-3 w-3" />,
    color: "text-emerald-400",
  },
  "claude-code": {
    label: "Claude Code CLI",
    shortLabel: "Claude",
    icon: <Zap className="h-3 w-3" />,
    color: "text-amber-400",
  },
  ollama: {
    label: "Ollama",
    shortLabel: "Ollama",
    icon: <span className="text-[10px] font-bold leading-none">🦙</span>,
    color: "text-blue-400",
  },
  "openai-compat": {
    label: "OpenAI-compat",
    shortLabel: "OpenAI",
    icon: <span className="text-[10px] font-bold leading-none">▲</span>,
    color: "text-blue-400",
  },
};

const QK = {
  skills: ["design-studio:skills"],
  designSystems: ["design-studio:design-systems"],
  craftRules: ["design-studio:craft-rules"],
  sessions: ["design-studio:sessions"],
  modelStatus: ["embedded-model:status"],
} as const;

const FRAME_OPTIONS = [
  { id: "desktop", label: "Desktop", icon: Monitor },
  { id: "tablet", label: "Tablet", icon: Tablet },
  { id: "mobile", label: "Mobile", icon: Smartphone },
] as const;
type FrameOption = (typeof FRAME_OPTIONS)[number]["id"];

interface CritiqueScore {
  philosophy: number;
  hierarchy: number;
  detail: number;
  function: number;
  innovation: number;
  summary: string;
}

interface ElementClick {
  tagName: string;
  className: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

// =============================================================================
// Streaming helpers
// =============================================================================
function parseArtifact(text: string): string | null {
  const m = text.match(
    /<artifact[^>]*type=["']html["'][^>]*>([\s\S]*?)<\/artifact>/i,
  );
  if (m) return m[1].trim();
  const f = text.match(/```html\n?([\s\S]*?)```/i);
  if (f) return f[1].trim();
  if (
    text.trim().startsWith("<!DOCTYPE html") ||
    text.trim().startsWith("<html")
  )
    return text.trim();
  return null;
}

// Extract partial (in-progress) artifact for live preview
function extractPartialArtifact(text: string): string | null {
  const m = text.match(/<artifact[^>]*type=["']html["'][^>]*>([\s\S]*)/i);
  if (m && m[1].length > 40) return m[1];
  const f = text.match(/```html\n?([\s\S]{40,})/i);
  if (f) return f[1];
  if (
    text.trim().startsWith("<!DOCTYPE html") ||
    text.trim().startsWith("<html")
  )
    return text.trim();
  return null;
}

// Shared OpenAI-compatible SSE stream reader
async function* streamOpenAICompat(
  baseUrl: string,
  model: string,
  messages: Array<{ role: string; content: string }>,
  signal: AbortSignal,
  apiKey?: string,
): AsyncGenerator<string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      max_tokens: 16384,
      temperature: 0.7,
    }),
    signal,
  });
  if (!res.ok)
    throw new Error(
      `Inference error (${res.status}): ${await res.text().catch(() => res.statusText)}`,
    );
  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const d = t.slice(5).trim();
      if (d === "[DONE]") return;
      try {
        const delta = JSON.parse(d).choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {
        /**/
      }
    }
  }
}

// Legacy alias for embedded Llama
function streamChat(
  messages: Array<{ role: string; content: string }>,
  signal: AbortSignal,
): AsyncGenerator<string> {
  return streamOpenAICompat(EMBEDDED_BASE_URL, "local", messages, signal);
}

interface ClaudeUsage {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

// Claude Code CLI streaming (via IPC)
function streamChatClaude(
  systemPrompt: string,
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  signal: AbortSignal,
  model?: string,
  onUsage?: (u: ClaudeUsage) => void,
): AsyncGenerator<string> {
  const sessionId = crypto.randomUUID();
  const queue: Array<string | Error | null> = [];
  let notify: (() => void) | null = null;

  const push = (item: string | Error | null) => {
    queue.push(item);
    const n = notify;
    notify = null;
    n?.();
  };

  ipc.designStudioStream.start(
    { sessionId, systemPrompt, messages, model },
    {
      onChunk: (d) => push(d.delta),
      onEnd: (d) => {
        if (onUsage && d.costUsd !== undefined) {
          onUsage({
            costUsd: d.costUsd,
            inputTokens: d.inputTokens ?? 0,
            outputTokens: d.outputTokens ?? 0,
          });
        }
        push(null);
      },
      onError: (d) => push(new Error(d.error)),
    },
  );

  const onAbort = () => {
    void ipc.designStudio.cancelDesignChat(sessionId);
    push(null);
  };
  signal.addEventListener("abort", onAbort);

  async function* gen(): AsyncGenerator<string> {
    try {
      while (true) {
        if (queue.length === 0) {
          await new Promise<void>((r) => {
            notify = r;
          });
        }
        if (signal.aborted) return;
        const item = queue.shift();
        if (item === null) return;
        if (item instanceof Error) throw item;
        if (typeof item === "string") yield item;
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
  return gen();
}

// Comment-mode injection script (injected into artifact HTML)
const COMMENT_MODE_SCRIPT = `<script id="__od_comment__">
(function(){
  document.body.style.cursor='crosshair';
  document.addEventListener('click',function(e){
    e.preventDefault(); e.stopPropagation();
    const el=e.target;
    const r=el.getBoundingClientRect();
    window.parent.postMessage({type:'od-element-click',tagName:el.tagName,className:el.className||'',
      text:(el.innerText||el.textContent||'').slice(0,200),x:r.left,y:r.top,width:r.width,height:r.height},'*');
  },true);
})();
</script>`;

// =============================================================================
// Main page
// =============================================================================
export default function DesignStudioPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // ── Remote data ──────────────────────────────────────────────────────────────
  const { data: skills = [] } = useQuery({
    queryKey: QK.skills,
    queryFn: () => ipc.designStudio.listSkills(),
  });
  const { data: designSystems = [] } = useQuery({
    queryKey: QK.designSystems,
    queryFn: () => ipc.designStudio.listDesignSystems(),
  });
  const { data: craftRules = [] } = useQuery({
    queryKey: QK.craftRules,
    queryFn: () => ipc.designStudio.listCraftRules(),
  });
  const { data: sessions = [] } = useQuery({
    queryKey: QK.sessions,
    queryFn: () => ipc.designStudio.listSessions(),
  });
  const { data: modelStatus, isLoading: statusLoading } = useQuery({
    queryKey: QK.modelStatus,
    queryFn: () => ipc.embeddedModel.getStatus(),
    refetchInterval: 3000,
  });

  // ── Mutations ─────────────────────────────────────────────────────────────────
  const createSessionMut = useMutation({
    mutationFn: (p: Parameters<typeof ipc.designStudio.createSession>[0]) =>
      ipc.designStudio.createSession(p),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: QK.sessions }),
  });
  const updateSessionMut = useMutation({
    mutationFn: (p: Parameters<typeof ipc.designStudio.updateSession>[0]) =>
      ipc.designStudio.updateSession(p),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: QK.sessions }),
  });
  const deleteSessionMut = useMutation({
    mutationFn: (id: number) => ipc.designStudio.deleteSession(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: QK.sessions }),
  });

  // ── Provider state ────────────────────────────────────────────────────────────
  const [providerSettings, setProviderSettings] = useState<ProviderSettings>({
    provider: "embedded-llama",
    claudeModel: "claude-sonnet-4-6",
    ollamaUrl: "http://localhost:11434",
    ollamaModel: "mistral",
    openAiCompatUrl: "https://api.openai.com",
    openAiCompatKey: "",
    openAiCompatModel: "gpt-4o",
  });
  const [claudeAvailable, setClaudeAvailable] = useState<boolean | null>(null);
  const [lastUsage, setLastUsage] = useState<ClaudeUsage | null>(null);

  // ── Core state ────────────────────────────────────────────────────────────────
  const [activeSessionId, setActiveSessionId] = useState<number | null>(null);
  const [messages, setMessages] = useState<DesignChatMessage[]>([]);
  const [currentArtifact, setCurrentArtifact] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);

  // Design config
  const [selectedSkill, setSelectedSkill] = useState<DesignSkill | null>(null);
  const [selectedDs, setSelectedDs] = useState<DesignSystem | null>(null);
  const [dsTokens, setDsTokens] = useState<string | null>(null);
  const [mode, setMode] = useState<DesignMode>("prototype");
  const [fidelity, setFidelity] = useState<FidelityLevel>("high-fi");
  const [selectedDirection, setSelectedDirection] =
    useState<DirectionId | null>(null);
  const [activeCraftIds, setActiveCraftIds] = useState<string[]>([]);
  const [audience, setAudience] = useState("");
  const [tone, setTone] = useState("");

  // UI state
  const [frame, setFrame] = useState<FrameOption>("desktop");
  const [leftPanelOpen, setLeftPanelOpen] = useState(true);
  const [skillFilter, setSkillFilter] = useState("");
  const [dsFilter, setDsFilter] = useState("");
  const [scenarioFilter, setScenarioFilter] = useState("all");
  const [commentMode, setCommentMode] = useState(false);
  const [showDirectionPicker, setShowDirectionPicker] = useState(false);
  const [showPromptGallery, setShowPromptGallery] = useState(false);
  const [elementClick, setElementClick] = useState<ElementClick | null>(null);
  const [commentInput, setCommentInput] = useState("");
  const [critiqueScore, setCritiqueScore] = useState<CritiqueScore | null>(
    null,
  );
  const [isRunningCritique, setIsRunningCritique] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const hasAutoRestored = useRef(false);
  // Refs so loadSession always sees the latest data without stale closures
  const skillsRef = useRef(skills);
  const designSystemsRef = useRef(designSystems);
  useEffect(() => {
    skillsRef.current = skills;
  }, [skills]);
  useEffect(() => {
    designSystemsRef.current = designSystems;
  }, [designSystems]);

  const modelRunning =
    (modelStatus?.running && modelStatus?.modelLoaded) ?? false;

  // ── Detect Claude CLI once on mount ──────────────────────────────────────────
  useEffect(() => {
    ipc.designStudio
      .detectClaude()
      .then((r) => setClaudeAvailable(r.available))
      .catch(() => setClaudeAvailable(false));
  }, []);

  // Derived: is the active provider ready to send?
  const providerReady =
    providerSettings.provider === "embedded-llama"
      ? modelRunning
      : providerSettings.provider === "claude-code"
        ? claudeAvailable === true
        : true; // Ollama/OpenAI-compat: assume available (fail at request time)

  // ── Auto-restore most recent session once sessions first load ─────────────────
  useEffect(() => {
    if (
      sessions.length > 0 &&
      !hasAutoRestored.current &&
      activeSessionId === null &&
      !isStreaming
    ) {
      hasAutoRestored.current = true;
      void loadSession(sessions[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions]);

  // ── Load design system tokens when ds changes ─────────────────────────────────
  useEffect(() => {
    if (!selectedDs) {
      setDsTokens(null);
      return;
    }
    ipc.designStudio
      .getDesignSystemTokens(selectedDs.id)
      .then(setDsTokens)
      .catch(() => setDsTokens(null));
  }, [selectedDs]);

  // ── Auto-scroll chat ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (chatScrollRef.current)
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
  }, [messages]);

  // ── Comment-mode iframe message listener ──────────────────────────────────────
  useEffect(() => {
    const handler = (e: MessageEvent) => {
      if (e.data?.type === "od-element-click")
        setElementClick(e.data as ElementClick);
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  // ── Persist session (debounced) ───────────────────────────────────────────────
  const persistSession = useCallback(
    (id: number, msgs: DesignChatMessage[], artifact: string | null) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        updateSessionMut.mutate({
          id,
          messages: msgs,
          currentArtifact: artifact,
          skillId: selectedSkill?.id ?? null,
          designSystemId: selectedDs?.id ?? null,
        });
      }, 800);
    },
    [updateSessionMut, selectedSkill?.id, selectedDs?.id],
  );

  // ── Load session ──────────────────────────────────────────────────────────────
  const loadSession = useCallback(async (id: number) => {
    try {
      const s = await ipc.designStudio.getSession(id);
      setActiveSessionId(s.id);
      setMessages(s.messages ?? []);
      setCurrentArtifact(s.currentArtifact ?? null);
      setCritiqueScore(null);
      setCommentMode(false);
      setElementClick(null);
      setInput("");
      // Use refs so this always sees the latest skills/DS regardless of when it was created
      setSelectedSkill(
        s.skillId
          ? (skillsRef.current.find((sk) => sk.id === s.skillId) ?? null)
          : null,
      );
      setSelectedDs(
        s.designSystemId
          ? (designSystemsRef.current.find((d) => d.id === s.designSystemId) ??
              null)
          : null,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Could not open session: ${msg.slice(0, 80)}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── New session ───────────────────────────────────────────────────────────────
  const newSession = useCallback(() => {
    setActiveSessionId(null);
    setMessages([]);
    setCurrentArtifact(null);
    setSelectedSkill(null);
    setSelectedDs(null);
    setInput("");
    setCritiqueScore(null);
    setElementClick(null);
    setCommentMode(false);
    setLastUsage(null);
  }, []);

  // ── Run self-critique ─────────────────────────────────────────────────────────
  const runCritique = useCallback(
    async (artifact: string) => {
      setIsRunningCritique(true);
      try {
        const critiqueMessages = [
          { role: "user" as const, content: buildCritiquePrompt(artifact) },
        ];
        const critiqueStream =
          providerSettings.provider === "claude-code"
            ? streamChatClaude(
                "",
                critiqueMessages,
                new AbortController().signal,
                providerSettings.claudeModel || undefined,
              )
            : providerSettings.provider === "ollama"
              ? streamOpenAICompat(
                  providerSettings.ollamaUrl,
                  providerSettings.ollamaModel || "mistral",
                  critiqueMessages,
                  new AbortController().signal,
                )
              : providerSettings.provider === "openai-compat"
                ? streamOpenAICompat(
                    providerSettings.openAiCompatUrl,
                    providerSettings.openAiCompatModel || "gpt-4o",
                    critiqueMessages,
                    new AbortController().signal,
                    providerSettings.openAiCompatKey || undefined,
                  )
                : streamChat(critiqueMessages, new AbortController().signal);
        let acc = "";
        for await (const delta of critiqueStream) {
          acc += delta;
        }
        const match = acc.match(/\{[\s\S]*\}/);
        if (match) {
          const parsed = JSON.parse(match[0]) as CritiqueScore;
          setCritiqueScore(parsed);
        }
      } catch {
        /* critique is optional, silently fail */
      } finally {
        setIsRunningCritique(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [providerSettings],
  );

  // ── Send message ──────────────────────────────────────────────────────────────
  const sendMessage = useCallback(
    async (overrideInput?: string) => {
      const trimmed = (overrideInput ?? input).trim();
      if (!trimmed || isStreaming) return;
      if (providerSettings.provider === "embedded-llama" && !modelRunning) {
        toast.error("No model loaded — open the Engine page.");
        navigate({ to: "/inference" });
        return;
      }
      if (
        providerSettings.provider === "claude-code" &&
        claudeAvailable === false
      ) {
        toast.error(
          "Claude CLI not found. Install it with: npm install -g @anthropic-ai/claude-code",
        );
        return;
      }

      let sessionId = activeSessionId;
      if (sessionId === null) {
        try {
          const s = await createSessionMut.mutateAsync({
            title: trimmed.slice(0, 60),
            skillId: selectedSkill?.id ?? null,
            designSystemId: selectedDs?.id ?? null,
          });
          sessionId = s.id;
          setActiveSessionId(sessionId);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error("[DesignStudio] Session create failed:", msg);
          toast.error(`Session not saved: ${msg.slice(0, 80)}`);
          // Still allow generation to proceed even without a saved session
        }
      }

      const userMsg: DesignChatMessage = {
        id: crypto.randomUUID(),
        role: "user",
        content: trimmed,
      };
      const asstMsg: DesignChatMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: "",
      };
      const nextMessages = [...messages, userMsg, asstMsg];
      setMessages(nextMessages);
      setInput("");
      setIsStreaming(true);

      const abort = new AbortController();
      abortRef.current = abort;

      const systemPrompt = buildSystemPrompt({
        mode,
        fidelity,
        skill: selectedSkill,
        designSystem: selectedDs,
        designSystemTokens: dsTokens,
        craftRules,
        activeCraftRuleIds: activeCraftIds,
        direction: selectedDirection,
        audience,
        tone,
        currentArtifact,
      });

      const historyApi = messages.slice(-10).map((m) => ({
        role: m.role as "user" | "assistant",
        content:
          m.role === "assistant"
            ? m.content
                .replace(/<artifact[\s\S]*?<\/artifact>/gi, "[artifact]")
                .replace(/<artifact\b[\s\S]*/gi, "[artifact]")
                .slice(0, 600)
            : m.content,
      }));

      const apiMessages = [
        { role: "system" as const, content: systemPrompt },
        ...historyApi,
        { role: "user" as const, content: withArtifactReminder(trimmed) },
      ];

      // Pick stream source based on provider
      const getStream = (): AsyncGenerator<string> => {
        const {
          provider,
          claudeModel,
          ollamaUrl,
          ollamaModel,
          openAiCompatUrl,
          openAiCompatKey,
          openAiCompatModel,
        } = providerSettings;
        if (provider === "claude-code") {
          return streamChatClaude(
            systemPrompt,
            historyApi.concat({
              role: "user" as const,
              content: withArtifactReminder(trimmed),
            }),
            abort.signal,
            claudeModel || undefined,
            (u) => setLastUsage(u),
          );
        }
        if (provider === "ollama") {
          return streamOpenAICompat(
            ollamaUrl,
            ollamaModel || "mistral",
            apiMessages,
            abort.signal,
          );
        }
        if (provider === "openai-compat") {
          return streamOpenAICompat(
            openAiCompatUrl,
            openAiCompatModel || "gpt-4o",
            apiMessages,
            abort.signal,
            openAiCompatKey || undefined,
          );
        }
        // default: embedded-llama
        return streamChat(apiMessages, abort.signal);
      };

      try {
        let acc = "";
        let lastLiveUpdate = 0;
        for await (const delta of getStream()) {
          acc += delta;
          setMessages((prev) =>
            prev.map((m) => (m.id === asstMsg.id ? { ...m, content: acc } : m)),
          );
          // Live preview: throttled to every 400ms to avoid flooding the iframe
          const now = Date.now();
          if (now - lastLiveUpdate > 400) {
            lastLiveUpdate = now;
            const partial = extractPartialArtifact(acc);
            if (partial) setCurrentArtifact(partial);
          }
        }
        const fullText = acc.includes("</artifact>")
          ? acc
          : acc + "</artifact>";
        const artifact = parseArtifact(fullText);
        if (artifact) {
          setCurrentArtifact(artifact);
          setCritiqueScore(null);
        }

        const finalMsgs = nextMessages.map((m) =>
          m.id === asstMsg.id
            ? { ...m, content: acc, artifactHtml: artifact ?? undefined }
            : m,
        );
        setMessages(finalMsgs);
        if (sessionId)
          persistSession(sessionId, finalMsgs, artifact ?? currentArtifact);
        if (artifact) void runCritique(artifact);
      } catch (err: unknown) {
        if ((err as Error)?.name !== "AbortError") {
          const msg = err instanceof Error ? err.message : "Unknown error";
          toast.error(`Generation failed: ${msg}`);
          setMessages((prev) =>
            prev.map((m) =>
              m.id === asstMsg.id
                ? {
                    ...m,
                    content: `⚠️ ${msg}\n\nCheck that your selected provider is available.`,
                  }
                : m,
            ),
          );
        }
      } finally {
        setIsStreaming(false);
        abortRef.current = null;
      }
    },
    [
      input,
      isStreaming,
      messages,
      modelRunning,
      navigate,
      mode,
      fidelity,
      selectedSkill,
      selectedDs,
      dsTokens,
      craftRules,
      activeCraftIds,
      selectedDirection,
      audience,
      tone,
      currentArtifact,
      activeSessionId,
      createSessionMut,
      persistSession,
      runCritique,
      providerSettings,
      claudeAvailable,
    ],
  );

  // ── Comment mode send ─────────────────────────────────────────────────────────
  const sendComment = useCallback(() => {
    if (!elementClick || !commentInput.trim()) return;
    const prompt = `In the current design, there is a <${elementClick.tagName.toLowerCase()}> element${elementClick.text ? ` with text "${elementClick.text.slice(0, 60)}"` : ""}. ${commentInput.trim()}. Update only that element (but output the complete HTML as always).`;
    setCommentMode(false);
    setElementClick(null);
    setCommentInput("");
    void sendMessage(prompt);
  }, [elementClick, commentInput, sendMessage]);

  // ── Export ────────────────────────────────────────────────────────────────────
  const exportAs = useCallback(
    async (format: "html" | "pdf" | "zip") => {
      if (!currentArtifact) return;
      const base = `design-${Date.now()}`;
      try {
        let result;
        if (format === "html")
          result = await ipc.designStudio.exportHtml({
            html: currentArtifact,
            filename: `${base}.html`,
          });
        else if (format === "pdf")
          result = await ipc.designStudio.exportPdf({
            html: currentArtifact,
            filename: `${base}.pdf`,
          });
        else
          result = await ipc.designStudio.exportZip({
            html: currentArtifact,
            filename: `${base}.zip`,
          });
        if (result.success)
          toast.success(`Exported as ${format.toUpperCase()}`);
        else toast.error(result.error ?? "Export failed");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Export failed");
      }
    },
    [currentArtifact],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void sendMessage();
      }
    },
    [sendMessage],
  );

  // ── Prepare artifact HTML for display ─────────────────────────────────────────
  const displayArtifact = currentArtifact
    ? commentMode
      ? currentArtifact.replace("</body>", COMMENT_MODE_SCRIPT + "</body>")
      : currentArtifact
    : null;

  // ── Filter helpers ────────────────────────────────────────────────────────────
  const filteredSkills = skills.filter((s) => {
    const matchesFilter =
      !skillFilter || s.name.toLowerCase().includes(skillFilter.toLowerCase());
    const matchesScenario =
      scenarioFilter === "all" || s.scenario === scenarioFilter;
    return matchesFilter && matchesScenario;
  });

  const filteredDs = designSystems.filter(
    (d) => !dsFilter || d.name.toLowerCase().includes(dsFilter.toLowerCase()),
  );

  // ── Relative time ─────────────────────────────────────────────────────────────
  const relTime = (date: Date) => {
    const diff = Date.now() - new Date(date).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return "just now";
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  };

  // =============================================================================
  // Render
  // =============================================================================
  return (
    <div className="flex h-full w-full overflow-hidden bg-transparent relative">
      {/* ── Modals ──────────────────────────────────────────────────────────────── */}
      {showDirectionPicker && (
        <DirectionPickerModal
          current={selectedDirection}
          onSelect={(id) => {
            setSelectedDirection(id);
            setShowDirectionPicker(false);
          }}
          onClose={() => setShowDirectionPicker(false)}
        />
      )}
      {showPromptGallery && (
        <PromptGalleryModal
          onSelect={(p) => {
            setInput(p);
            setShowPromptGallery(false);
            inputRef.current?.focus();
          }}
          onClose={() => setShowPromptGallery(false)}
        />
      )}
      {commentMode && elementClick && (
        <div
          className="fixed z-50 bg-popover border border-border rounded-3xl shadow-xl p-3 w-72"
          style={{
            left: Math.min(elementClick.x + 10, window.innerWidth - 300),
            top: Math.min(elementClick.y + 10, window.innerHeight - 160),
          }}
        >
          <p className="text-xs text-muted-foreground mb-2">
            Editing:{" "}
            <code className="text-primary">{`<${elementClick.tagName.toLowerCase()}>`}</code>
            {elementClick.text && <> — "{elementClick.text.slice(0, 40)}"</>}
          </p>
          <Textarea
            autoFocus
            value={commentInput}
            onChange={(e) => setCommentInput(e.target.value)}
            placeholder="What should change? (Enter to apply)"
            className="text-xs min-h-[60px] resize-none mb-2"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendComment();
              }
              if (e.key === "Escape") {
                setElementClick(null);
                setCommentInput("");
              }
            }}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              className="flex-1 h-7 text-xs"
              onClick={sendComment}
              disabled={!commentInput.trim()}
            >
              Apply
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              onClick={() => {
                setElementClick(null);
                setCommentInput("");
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* ── Left Panel ─────────────────────────────────────────────────────────── */}
      <div
        className={cn(
          "flex flex-col shrink-0 transition-all duration-200 overflow-hidden border-r border-white/[0.06] bg-[#0d0d12]",
          leftPanelOpen ? "w-[256px]" : "w-0",
        )}
      >
        {leftPanelOpen && (
          <div className="flex flex-col h-full overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-4 pt-4 pb-3 shrink-0">
              <div className="flex items-center gap-2">
                <Palette className="h-4 w-4 text-primary" />
                <span className="text-sm font-semibold">Design Studio</span>
              </div>
              {statusLoading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
              ) : !providerReady ? (
                <button
                  onClick={() =>
                    providerSettings.provider === "embedded-llama"
                      ? navigate({ to: "/inference" })
                      : undefined
                  }
                  className="flex items-center gap-1 text-[10px] text-amber-400 hover:text-amber-300 bg-amber-400/10 border border-amber-400/20 rounded-full px-2 py-0.5 transition-colors"
                >
                  <AlertCircle className="h-2.5 w-2.5" />
                  {providerSettings.provider === "embedded-llama"
                    ? "No engine"
                    : "Not ready"}
                </button>
              ) : (
                <div className="flex items-center gap-1 text-[10px] text-emerald-400 bg-emerald-400/10 border border-emerald-400/20 rounded-full px-2 py-0.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  Ready
                </div>
              )}
            </div>

            {/* ── SESSIONS — most prominent, fixed at top ── */}
            <div className="shrink-0 px-3 pb-3 border-b border-white/[0.06]">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-foreground">
                    Sessions
                  </span>
                  {sessions.length > 0 && (
                    <span className="text-[10px] text-muted-foreground bg-white/[0.06] rounded-full px-1.5 py-0.5">
                      {sessions.length}
                    </span>
                  )}
                </div>
                <button
                  onClick={newSession}
                  className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-primary bg-white/[0.04] hover:bg-primary/10 border border-white/[0.06] hover:border-primary/30 rounded-3xl px-2 py-1 transition-all"
                >
                  <Plus className="h-3 w-3" />
                  New
                </button>
              </div>
              {sessions.length === 0 ? (
                <div className="text-[11px] text-muted-foreground/40 text-center py-3 border border-dashed border-white/[0.05] rounded-2xl">
                  No sessions yet — start by typing below
                </div>
              ) : (
                <div className="flex flex-col gap-0.5 max-h-[200px] overflow-y-auto">
                  {sessions.map((s) => (
                    <SessionItem
                      key={s.id}
                      session={s}
                      active={s.id === activeSessionId}
                      relTime={relTime}
                      onClick={() => void loadSession(s.id)}
                      onDelete={() => {
                        deleteSessionMut.mutate(s.id);
                        if (activeSessionId === s.id) newSession();
                      }}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* ── Scrollable design settings ── */}
            <ScrollArea className="flex-1 min-h-0">
              <div className="px-3 pt-3 pb-6 space-y-4">
                {/* Mode */}
                <div>
                  <PanelLabel>Output type</PanelLabel>
                  <div className="grid grid-cols-2 gap-1 mt-1.5">
                    {MODES.map((m) => (
                      <button
                        key={m.id}
                        onClick={() => setMode(m.id)}
                        title={m.hint}
                        className={cn(
                          "flex items-center gap-1.5 px-2 py-1.5 rounded-2xl text-xs font-medium transition-all",
                          mode === m.id
                            ? "bg-primary text-primary-foreground"
                            : "bg-white/[0.04] text-muted-foreground hover:bg-white/[0.07] hover:text-foreground",
                        )}
                      >
                        <span className="text-sm">{m.icon}</span>
                        {m.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Fidelity */}
                <div>
                  <PanelLabel>Fidelity</PanelLabel>
                  <div className="mt-1.5 bg-white/[0.03] rounded-3xl p-1 flex flex-col gap-0.5">
                    {FIDELITY_LEVELS.map((f) => (
                      <button
                        key={f.id}
                        onClick={() => setFidelity(f.id)}
                        className={cn(
                          "flex items-center gap-2.5 px-3 py-1.5 rounded-2xl text-xs transition-all",
                          fidelity === f.id
                            ? "bg-white/[0.08] text-foreground font-medium"
                            : "text-muted-foreground hover:text-foreground hover:bg-white/[0.04]",
                        )}
                      >
                        <span
                          className="h-2 w-2 rounded-full shrink-0"
                          style={{ background: f.color }}
                        />
                        <span className="flex-1 text-left">{f.label}</span>
                        {fidelity === f.id && (
                          <CheckCircle2 className="h-3 w-3 text-primary shrink-0" />
                        )}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Visual Direction */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <PanelLabel>Visual direction</PanelLabel>
                    {selectedDirection && (
                      <button
                        onClick={() => setSelectedDirection(null)}
                        className="text-[10px] text-muted-foreground hover:text-foreground"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                  {selectedDirection ? (
                    (() => {
                      const dir = VISUAL_DIRECTIONS.find(
                        (d) => d.id === selectedDirection,
                      )!;
                      return (
                        <button
                          onClick={() => setShowDirectionPicker(true)}
                          className="w-full flex items-center gap-2.5 p-2.5 rounded-3xl bg-white/[0.04] border border-white/[0.06] hover:border-primary/30 transition-all group"
                        >
                          <div className="flex gap-1">
                            {[dir.bg, dir.fg, dir.accent].map((c) => (
                              <span
                                key={c}
                                className="h-4 w-4 rounded-full ring-1 ring-white/10"
                                style={{ background: c }}
                              />
                            ))}
                          </div>
                          <div className="text-left min-w-0 flex-1">
                            <div className="text-xs font-medium truncate">
                              {dir.name}
                            </div>
                            <div className="text-[10px] text-muted-foreground">
                              {dir.traits[0]} · {dir.traits[1]}
                            </div>
                          </div>
                          <Sparkles className="h-3 w-3 text-muted-foreground group-hover:text-primary shrink-0 transition-colors" />
                        </button>
                      );
                    })()
                  ) : (
                    <button
                      onClick={() => setShowDirectionPicker(true)}
                      className="w-full flex items-center justify-center gap-2 py-2 rounded-3xl border border-dashed border-white/[0.08] text-xs text-muted-foreground hover:border-primary/40 hover:text-primary hover:bg-primary/5 transition-all"
                    >
                      <Sparkles className="h-3.5 w-3.5" />
                      Pick a visual direction
                    </button>
                  )}
                </div>

                {/* Skill */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <PanelLabel>
                      Skill
                      {selectedSkill && (
                        <span className="ml-1 text-primary">
                          · {selectedSkill.name}
                        </span>
                      )}
                    </PanelLabel>
                    {selectedSkill && (
                      <button
                        onClick={() => setSelectedSkill(null)}
                        className="text-[10px] text-muted-foreground hover:text-foreground"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                  <div className="relative mb-1.5">
                    <input
                      type="text"
                      placeholder="Search…"
                      value={skillFilter}
                      onChange={(e) => setSkillFilter(e.target.value)}
                      className="w-full pl-7 pr-2 py-1.5 text-xs bg-white/[0.04] border border-white/[0.06] rounded-2xl outline-none focus:border-primary/40 text-foreground placeholder:text-muted-foreground/50"
                    />
                    <svg
                      className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/40"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                      />
                    </svg>
                  </div>
                  <div className="flex gap-1 flex-wrap mb-1.5">
                    {SCENARIOS.map((sc) => (
                      <button
                        key={sc.id}
                        onClick={() => setScenarioFilter(sc.id)}
                        className={cn(
                          "px-2 py-0.5 rounded-full text-[10px] font-medium transition-all border",
                          scenarioFilter === sc.id
                            ? "bg-primary/20 text-primary border-primary/30"
                            : "bg-white/[0.03] text-muted-foreground border-white/[0.05] hover:text-foreground",
                        )}
                      >
                        {sc.label}
                      </button>
                    ))}
                  </div>
                  <div className="flex flex-col gap-0.5 max-h-44 overflow-y-auto">
                    {filteredSkills.map((sk) => (
                      <button
                        key={sk.id}
                        onClick={() =>
                          setSelectedSkill((p) => (p?.id === sk.id ? null : sk))
                        }
                        className={cn(
                          "w-full text-left px-2.5 py-1.5 rounded-2xl text-xs transition-all",
                          selectedSkill?.id === sk.id
                            ? "bg-primary/15 text-primary font-medium"
                            : "text-muted-foreground hover:text-foreground hover:bg-white/[0.05]",
                        )}
                      >
                        <div className="font-medium truncate">{sk.name}</div>
                        {sk.description && (
                          <div className="text-[10px] opacity-50 line-clamp-1 mt-0.5">
                            {sk.description}
                          </div>
                        )}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Design System */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <PanelLabel>
                      Design system
                      {selectedDs && (
                        <span className="ml-1 text-primary">
                          · {selectedDs.name}
                        </span>
                      )}
                    </PanelLabel>
                    {selectedDs && (
                      <button
                        onClick={() => setSelectedDs(null)}
                        className="text-[10px] text-muted-foreground hover:text-foreground"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                  <div className="relative mb-1.5">
                    <input
                      type="text"
                      placeholder="Search 150 systems…"
                      value={dsFilter}
                      onChange={(e) => setDsFilter(e.target.value)}
                      className="w-full pl-7 pr-2 py-1.5 text-xs bg-white/[0.04] border border-white/[0.06] rounded-2xl outline-none focus:border-primary/40 text-foreground placeholder:text-muted-foreground/50"
                    />
                    <svg
                      className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/40"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                      />
                    </svg>
                  </div>
                  <div className="flex flex-col gap-0.5 max-h-44 overflow-y-auto">
                    {filteredDs.map((ds) => (
                      <button
                        key={ds.id}
                        onClick={() =>
                          setSelectedDs((p) => (p?.id === ds.id ? null : ds))
                        }
                        className={cn(
                          "w-full text-left px-2.5 py-1.5 rounded-2xl text-xs transition-all",
                          selectedDs?.id === ds.id
                            ? "bg-primary/15 text-primary font-medium"
                            : "text-muted-foreground hover:text-foreground hover:bg-white/[0.05]",
                        )}
                      >
                        {ds.name}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Context */}
                <div>
                  <PanelLabel>Context</PanelLabel>
                  <div className="mt-1.5 grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-[10px] text-muted-foreground/60 block mb-1">
                        Audience
                      </label>
                      <select
                        value={audience}
                        onChange={(e) => setAudience(e.target.value)}
                        className="w-full px-2 py-1.5 text-xs bg-white/[0.04] border border-white/[0.06] rounded-2xl outline-none focus:border-primary/40 text-foreground appearance-none"
                      >
                        <option value="">Any</option>
                        {AUDIENCES.map((a) => (
                          <option key={a} value={a}>
                            {a}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="text-[10px] text-muted-foreground/60 block mb-1">
                        Tone
                      </label>
                      <select
                        value={tone}
                        onChange={(e) => setTone(e.target.value)}
                        className="w-full px-2 py-1.5 text-xs bg-white/[0.04] border border-white/[0.06] rounded-2xl outline-none focus:border-primary/40 text-foreground appearance-none"
                      >
                        <option value="">Neutral</option>
                        {TONES.map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>

                {/* Craft Rules */}
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <PanelLabel>
                      Craft rules
                      {activeCraftIds.length > 0 && (
                        <span className="ml-1 text-primary">
                          · {activeCraftIds.length}
                        </span>
                      )}
                    </PanelLabel>
                    {activeCraftIds.length > 0 && (
                      <button
                        onClick={() => setActiveCraftIds([])}
                        className="text-[10px] text-muted-foreground hover:text-foreground"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {craftRules.map((r) => {
                      const on = activeCraftIds.includes(r.id);
                      return (
                        <button
                          key={r.id}
                          title={r.description}
                          onClick={() =>
                            setActiveCraftIds((p) =>
                              on ? p.filter((x) => x !== r.id) : [...p, r.id],
                            )
                          }
                          className={cn(
                            "px-2.5 py-1 rounded-full text-[10px] font-medium border transition-all",
                            on
                              ? "bg-primary/15 border-primary/30 text-primary"
                              : "bg-white/[0.03] border-white/[0.05] text-muted-foreground hover:border-white/[0.1] hover:text-foreground",
                          )}
                        >
                          {r.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </ScrollArea>
          </div>
        )}
      </div>

      {/* ── Main Area ───────────────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Toolbar */}
        <div className="flex items-center gap-1.5 px-3 h-11 border-b border-white/[0.06] shrink-0 bg-transparent/60 backdrop-blur">
          {/* Panel toggle */}
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
            onClick={() => setLeftPanelOpen((v) => !v)}
          >
            <PanelLeft className="h-3.5 w-3.5" />
          </Button>

          <div className="w-px h-4 bg-white/[0.08] mx-0.5 shrink-0" />

          {/* Active config breadcrumbs */}
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground min-w-0 overflow-hidden">
            <span className="font-medium text-foreground shrink-0">
              Design Studio
            </span>
            {mode !== "prototype" && (
              <>
                <span className="opacity-30">/</span>
                <span className="shrink-0">
                  {MODES.find((m) => m.id === mode)?.label}
                </span>
              </>
            )}
            {fidelity !== "high-fi" && (
              <>
                <span className="opacity-30">/</span>
                <span className="flex items-center gap-1 shrink-0">
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{
                      background: FIDELITY_LEVELS.find((f) => f.id === fidelity)
                        ?.color,
                    }}
                  />
                  {FIDELITY_LEVELS.find((f) => f.id === fidelity)?.label}
                </span>
              </>
            )}
            {selectedSkill && (
              <>
                <span className="opacity-30">/</span>
                <span className="truncate max-w-[100px]">
                  {selectedSkill.name}
                </span>
              </>
            )}
            {selectedDirection &&
              (() => {
                const dir = VISUAL_DIRECTIONS.find(
                  (d) => d.id === selectedDirection,
                );
                return dir ? (
                  <>
                    <span className="opacity-30">/</span>
                    <span className="flex items-center gap-1 shrink-0">
                      <span
                        className="h-2 w-2 rounded-full"
                        style={{ background: dir.accent }}
                      />
                      {dir.name}
                    </span>
                  </>
                ) : null;
              })()}
          </div>

          <div className="flex-1" />

          {/* Actions */}
          <div className="flex items-center gap-1 shrink-0">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2.5 text-xs gap-1.5 text-muted-foreground hover:text-foreground"
              onClick={() => setShowPromptGallery(true)}
            >
              <BookOpen className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Gallery</span>
            </Button>

            {currentArtifact && (
              <>
                <div className="w-px h-4 bg-white/[0.08]" />
                <Button
                  variant={commentMode ? "secondary" : "ghost"}
                  size="sm"
                  className="h-7 px-2.5 text-xs gap-1.5"
                  onClick={() => {
                    setCommentMode((v) => !v);
                    setElementClick(null);
                    setCommentInput("");
                  }}
                >
                  <MessageSquare className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">
                    {commentMode ? "Exit" : "Comment"}
                  </span>
                </Button>
                <div className="w-px h-4 bg-white/[0.08]" />
                {/* Frame picker */}
                <div className="flex items-center bg-white/[0.04] rounded-2xl p-0.5">
                  {FRAME_OPTIONS.map(({ id, label, icon: Icon }) => (
                    <button
                      key={id}
                      title={label}
                      onClick={() => setFrame(id)}
                      className={cn(
                        "p-1.5 rounded-3xl transition-all",
                        frame === id
                          ? "bg-white/[0.1] text-foreground"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <Icon className="h-3.5 w-3.5" />
                    </button>
                  ))}
                </div>
                <div className="w-px h-4 bg-white/[0.08]" />
                <ExportDropdown onExport={exportAs} />
              </>
            )}

            <div className="w-px h-4 bg-white/[0.08]" />
            <Button
              size="sm"
              className="h-7 px-2.5 text-xs gap-1.5"
              onClick={newSession}
            >
              <Plus className="h-3.5 w-3.5" />
              New
            </Button>
          </div>
        </div>

        {/* ── Session Tabs ─────────────────────────────────────────────────────── */}
        {sessions.length > 0 && (
          <div
            className="flex items-center gap-0.5 px-2 border-b border-white/[0.06] bg-[#0a0a0f] shrink-0 overflow-x-auto scrollbar-none"
            style={{ minHeight: "36px" }}
          >
            {/* Home tab */}
            <button
              onClick={() => {
                setActiveSessionId(null);
                setMessages([]);
                setCurrentArtifact(null);
                setCritiqueScore(null);
              }}
              className={cn(
                "flex items-center gap-1.5 px-3 h-8 rounded-t-md text-xs whitespace-nowrap shrink-0 border-b-2 transition-all",
                activeSessionId === null
                  ? "text-foreground border-primary bg-white/[0.04]"
                  : "text-muted-foreground border-transparent hover:text-foreground hover:bg-white/[0.03]",
              )}
            >
              <Palette className="h-3 w-3" />
              <span>All Designs</span>
            </button>
            {/* Session tabs */}
            {sessions.map((s) => (
              <button
                key={s.id}
                onClick={() => void loadSession(s.id)}
                className={cn(
                  "group flex items-center gap-1.5 px-3 h-8 rounded-t-md text-xs whitespace-nowrap max-w-[160px] shrink-0 border-b-2 transition-all",
                  s.id === activeSessionId
                    ? "text-foreground border-primary bg-white/[0.04]"
                    : "text-muted-foreground border-transparent hover:text-foreground hover:bg-white/[0.03]",
                )}
              >
                <span className="truncate">{s.title}</span>
                <span
                  role="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteSessionMut.mutate(s.id);
                    if (s.id === activeSessionId) newSession();
                  }}
                  className="h-4 w-4 rounded flex items-center justify-center opacity-0 group-hover:opacity-60 hover:!opacity-100 hover:bg-white/10 shrink-0 transition-all text-muted-foreground hover:text-foreground ml-0.5 text-[10px] leading-none"
                >
                  ×
                </span>
              </button>
            ))}
            {/* New tab button */}
            <button
              onClick={newSession}
              className="flex items-center justify-center h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground hover:bg-white/[0.05] rounded-3xl transition-colors ml-1"
              title="New design"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* Main content */}
        {displayArtifact ? (
          <div className="flex-1 flex flex-col overflow-hidden">
            {/* Preview */}
            <div className="flex-1 min-h-0 p-2 overflow-hidden">
              <div className="h-full rounded-3xl border border-border/50 overflow-hidden relative bg-white dark:bg-zinc-900">
                {isStreaming && (
                  <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-transparent/80 backdrop-blur-sm">
                    <Loader2 className="h-8 w-8 animate-spin text-primary" />
                    <p className="text-sm font-medium text-muted-foreground">
                      Generating design…
                    </p>
                  </div>
                )}
                {commentMode && !elementClick && (
                  <div className="absolute top-2 left-1/2 -translate-x-1/2 z-10 bg-primary text-primary-foreground text-xs px-3 py-1.5 rounded-full shadow-lg flex items-center gap-1.5 pointer-events-none">
                    <MessageSquare className="h-3 w-3" />
                    Click any element to edit it
                  </div>
                )}
                <div
                  className={cn(
                    "h-full mx-auto overflow-hidden transition-all duration-300",
                    frame === "mobile" && "max-w-[390px]",
                    frame === "tablet" && "max-w-[768px]",
                  )}
                >
                  <iframe
                    ref={iframeRef}
                    key={displayArtifact.length + String(commentMode)}
                    srcDoc={displayArtifact}
                    sandbox="allow-scripts allow-same-origin"
                    className="w-full h-full border-none"
                    title="Design preview"
                  />
                </div>
              </div>
            </div>

            {/* Critique score */}
            {(critiqueScore || isRunningCritique) && (
              <div className="px-3 pb-1 shrink-0">
                <CritiqueScoreBar
                  score={critiqueScore}
                  loading={isRunningCritique}
                />
              </div>
            )}

            {/* Chat strip */}
            <div className="h-[200px] shrink-0 border-t border-border/50 flex flex-col">
              <div
                ref={chatScrollRef}
                className="flex-1 overflow-y-auto px-3 py-2 space-y-2"
              >
                {messages.map((m) => (
                  <ChatBubble key={m.id} message={m} />
                ))}
              </div>
              <ChatInput
                value={input}
                onChange={setInput}
                onSend={() => void sendMessage()}
                onStop={() => abortRef.current?.abort()}
                onKeyDown={handleKeyDown}
                isStreaming={isStreaming}
                disabled={!providerReady && !statusLoading}
                inputRef={inputRef}
                compact
                providerSettings={providerSettings}
                onProviderSettingsChange={setProviderSettings}
                claudeAvailable={claudeAvailable}
                lastUsage={lastUsage}
              />
            </div>
          </div>
        ) : (
          <div className="flex-1 flex flex-col overflow-hidden">
            {messages.length === 0 ? (
              <div className="flex-1 overflow-y-auto">
                {sessions.length > 0 ? (
                  /* Session browser — shown when returning to Design Studio */
                  <div className="px-6 py-6 max-w-4xl mx-auto">
                    <div className="flex items-center justify-between mb-4">
                      <div>
                        <h2 className="text-lg font-semibold">Your Designs</h2>
                        <p className="text-sm text-muted-foreground">
                          {sessions.length} saved session
                          {sessions.length !== 1 ? "s" : ""} — click to continue
                        </p>
                      </div>
                      <Button
                        size="sm"
                        className="gap-1.5"
                        onClick={newSession}
                      >
                        <Plus className="h-3.5 w-3.5" />
                        New Design
                      </Button>
                    </div>

                    {!statusLoading && !providerReady && (
                      <div className="flex items-center gap-2 text-sm text-amber-500 bg-amber-500/10 border border-amber-500/20 rounded-2xl px-4 py-2 mb-4">
                        <AlertCircle className="h-4 w-4 shrink-0" />
                        {providerSettings.provider === "embedded-llama" ? (
                          <>
                            No model loaded.{" "}
                            <button
                              onClick={() => navigate({ to: "/inference" })}
                              className="underline font-medium ml-1 hover:text-amber-400"
                            >
                              Open Engine →
                            </button>
                          </>
                        ) : providerSettings.provider === "claude-code" ? (
                          "Claude CLI not found on PATH."
                        ) : (
                          "Provider not configured."
                        )}
                      </div>
                    )}

                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                      {sessions.map((s) => (
                        <SessionCard
                          key={s.id}
                          session={s}
                          relTime={relTime}
                          onClick={() => void loadSession(s.id)}
                          onDelete={() => {
                            deleteSessionMut.mutate(s.id);
                          }}
                        />
                      ))}
                      {/* New session card */}
                      <button
                        onClick={newSession}
                        className="flex flex-col items-center justify-center gap-2 rounded-3xl border-2 border-dashed border-border/50 hover:border-primary/40 hover:bg-primary/5 transition-all p-6 text-muted-foreground hover:text-primary min-h-[140px]"
                      >
                        <Plus className="h-6 w-6" />
                        <span className="text-sm font-medium">New Design</span>
                      </button>
                    </div>
                  </div>
                ) : (
                  /* First-time welcome */
                  <div className="flex flex-col items-center justify-center gap-5 px-6 h-full py-16">
                    <div className="flex flex-col items-center gap-2.5 text-center max-w-[440px]">
                      <div className="h-12 w-12 rounded-2xl bg-primary/10 flex items-center justify-center">
                        <Palette className="h-6 w-6 text-primary" />
                      </div>
                      <h2 className="text-lg font-semibold">Design Studio</h2>
                      <p className="text-sm text-muted-foreground leading-relaxed">
                        Create pixel-perfect designs powered entirely by your
                        local AI engine. Pick a skill, design system, and
                        fidelity from the panel, then describe what to build.
                      </p>
                      {!statusLoading &&
                        !providerReady &&
                        providerSettings.provider === "embedded-llama" && (
                          <div className="flex items-center gap-2 text-sm text-amber-500 bg-amber-500/10 border border-amber-500/20 rounded-2xl px-4 py-2 w-full justify-center">
                            <AlertCircle className="h-4 w-4 shrink-0" />
                            No model loaded.{" "}
                            <button
                              onClick={() => navigate({ to: "/inference" })}
                              className="underline font-medium ml-1 hover:text-amber-400"
                            >
                              Open Engine
                            </button>
                          </div>
                        )}
                      <Button
                        variant="outline"
                        size="sm"
                        className="gap-1.5 mt-1"
                        onClick={() => setShowPromptGallery(true)}
                      >
                        <BookOpen className="h-3.5 w-3.5" />
                        Browse Prompt Gallery
                      </Button>
                      <div className="grid grid-cols-1 gap-1.5 w-full mt-1">
                        {[
                          "Create a modern SaaS landing page with hero, features, and pricing",
                          "Build a dark analytics dashboard with KPI cards and charts",
                          "Design a mobile login flow with polished form states",
                        ].map((p) => (
                          <button
                            key={p}
                            onClick={() => {
                              setInput(p);
                              inputRef.current?.focus();
                            }}
                            className="text-left text-xs px-3 py-2 rounded-2xl border border-border/50 bg-muted/40 hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                          >
                            {p}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ) : isStreaming ? (
              /* Generating state — big visual placeholder so it's obvious what's happening */
              <div className="flex-1 flex flex-col items-center justify-center gap-5 px-6 py-8">
                <div className="w-full max-w-2xl rounded-2xl border border-primary/20 bg-primary/5 overflow-hidden">
                  {/* Fake browser chrome */}
                  <div className="flex items-center gap-1.5 px-4 py-3 bg-muted/40 border-b border-border/40">
                    <span className="h-3 w-3 rounded-full bg-red-400/60" />
                    <span className="h-3 w-3 rounded-full bg-amber-400/60" />
                    <span className="h-3 w-3 rounded-full bg-emerald-400/60" />
                    <div className="flex-1 mx-3 h-5 rounded bg-transparent/60 border border-border/40" />
                  </div>
                  {/* Animated skeleton */}
                  <div className="p-6 space-y-4 min-h-[260px]">
                    <div className="h-8 rounded-2xl bg-muted/60 w-2/3 animate-pulse" />
                    <div
                      className="h-4 rounded bg-muted/40 w-full animate-pulse"
                      style={{ animationDelay: "0.1s" }}
                    />
                    <div
                      className="h-4 rounded bg-muted/40 w-5/6 animate-pulse"
                      style={{ animationDelay: "0.2s" }}
                    />
                    <div className="grid grid-cols-3 gap-3 pt-2">
                      {[0, 1, 2].map((i) => (
                        <div
                          key={i}
                          className="h-20 rounded-3xl bg-muted/40 animate-pulse"
                          style={{ animationDelay: `${0.1 * i}s` }}
                        />
                      ))}
                    </div>
                    <div
                      className="h-10 rounded-2xl bg-primary/20 w-40 animate-pulse"
                      style={{ animationDelay: "0.3s" }}
                    />
                  </div>
                </div>
                <div className="flex items-center gap-3 text-muted-foreground">
                  <Loader2 className="h-5 w-5 animate-spin text-primary" />
                  <div className="text-center">
                    <p className="text-sm font-medium text-foreground">
                      Generating your design…
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      The rendered preview will appear here once complete
                    </p>
                  </div>
                </div>
                {/* Latest prompt bubble */}
                {messages
                  .filter((m) => m.role === "user")
                  .slice(-1)
                  .map((m) => (
                    <div
                      key={m.id}
                      className="max-w-lg text-center text-xs text-muted-foreground bg-muted/40 rounded-3xl px-4 py-2 border border-border/40 italic"
                    >
                      "{m.content.slice(0, 120)}
                      {m.content.length > 120 ? "…" : ""}"
                    </div>
                  ))}
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5 text-destructive border-destructive/30 hover:bg-destructive/10"
                  onClick={() => abortRef.current?.abort()}
                >
                  <Square className="h-3 w-3 fill-current" />
                  Cancel generation
                </Button>
              </div>
            ) : (
              <div
                ref={chatScrollRef}
                className="flex-1 overflow-y-auto px-4 py-4"
              >
                <div className="max-w-2xl mx-auto space-y-4">
                  {messages.map((m) => (
                    <ChatBubble key={m.id} message={m} />
                  ))}
                </div>
              </div>
            )}
            <ChatInput
              value={input}
              onChange={setInput}
              onSend={() => void sendMessage()}
              onStop={() => abortRef.current?.abort()}
              onKeyDown={handleKeyDown}
              isStreaming={isStreaming}
              disabled={!providerReady && !statusLoading}
              inputRef={inputRef}
              providerSettings={providerSettings}
              onProviderSettingsChange={setProviderSettings}
              claudeAvailable={claudeAvailable}
              lastUsage={lastUsage}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// Sub-components
// =============================================================================

function PanelLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/50">
      {children}
    </span>
  );
}

function SessionCard({
  session,
  relTime,
  onClick,
  onDelete,
}: {
  session: DesignSessionSummary;
  relTime: (d: Date) => string;
  onClick: () => void;
  onDelete: () => void;
}) {
  const hasArtifact = !!session.currentArtifact;

  return (
    <button
      type="button"
      className="group w-full text-left rounded-3xl border border-white/[0.08] hover:border-primary/40 overflow-hidden cursor-pointer transition-all hover:shadow-lg hover:shadow-primary/5 bg-white/[0.02] hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      onClick={onClick}
    >
      {/* Thumbnail — full pointer-events-none so clicks reach the button */}
      <div className="h-[130px] bg-white/[0.03] overflow-hidden relative border-b border-white/[0.06]">
        {hasArtifact ? (
          <>
            <iframe
              srcDoc={session.currentArtifact!}
              sandbox=""
              className="w-full h-full border-none pointer-events-none"
              style={{
                transform: "scale(0.5)",
                transformOrigin: "top left",
                width: "200%",
                height: "200%",
              }}
              title="preview"
            />
            {/* Transparent click-capture overlay (iframes don't bubble clicks) */}
            <div className="absolute inset-0" />
          </>
        ) : (
          <div className="h-full flex flex-col items-center justify-center gap-2 text-muted-foreground/30">
            <Palette className="h-7 w-7" />
            <span className="text-[10px]">No preview</span>
          </div>
        )}
        {/* Delete — only shown on group-hover, stops propagation */}
        <div
          className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          <div className="h-6 w-6 flex items-center justify-center rounded-3xl bg-transparent/90 border border-border/60 hover:bg-destructive/10 hover:text-destructive hover:border-destructive/40 transition-colors">
            <Trash2 className="h-3 w-3" />
          </div>
        </div>
      </div>

      {/* Info row */}
      <div className="px-3 py-2.5">
        <div className="text-sm font-medium truncate group-hover:text-primary transition-colors leading-snug">
          {session.title}
        </div>
        <div className="flex items-center gap-1.5 mt-1.5">
          <Clock className="h-3 w-3 text-muted-foreground/50 shrink-0" />
          <span className="text-[11px] text-muted-foreground/60">
            {relTime(session.updatedAt)}
          </span>
          {session.skillId && (
            <span className="ml-auto text-[10px] text-muted-foreground/50 truncate max-w-[80px]">
              {session.skillId.replace(/-/g, " ")}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

function SessionItem({
  session,
  active,
  relTime,
  onClick,
  onDelete,
}: {
  session: DesignSessionSummary;
  active: boolean;
  relTime: (d: Date) => string;
  onClick: () => void;
  onDelete: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group w-full flex items-center gap-1 rounded-2xl px-2 py-1.5 transition-colors text-left",
        active
          ? "bg-primary/15 text-primary"
          : "text-muted-foreground hover:text-foreground hover:bg-white/[0.05]",
      )}
    >
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium truncate">{session.title}</div>
        <div className="text-[10px] opacity-60 flex items-center gap-1 mt-0.5">
          <Clock className="h-2.5 w-2.5" />
          {relTime(session.updatedAt)}
        </div>
      </div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        className="h-5 w-5 flex items-center justify-center rounded opacity-0 group-hover:opacity-100 hover:bg-destructive/10 hover:text-destructive transition-all shrink-0"
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </button>
  );
}

function ChatBubble({ message }: { message: DesignChatMessage }) {
  const isUser = message.role === "user";
  const display = message.content
    .replace(/<artifact[\s\S]*?<\/artifact>/gi, "")
    .replace(/<artifact\b[\s\S]*/gi, "")
    .replace(/```html[\s\S]*?```/gi, "")
    .replace(/\[Required:[\s\S]*$/gi, "")
    .trim();
  return (
    <div className={cn("flex gap-2.5", isUser && "flex-row-reverse")}>
      <div
        className={cn(
          "h-6 w-6 rounded-full flex items-center justify-center shrink-0 mt-0.5",
          isUser ? "bg-primary/15" : "bg-muted",
        )}
      >
        {isUser ? (
          <User className="h-3 w-3 text-primary" />
        ) : (
          <Bot className="h-3 w-3 text-muted-foreground" />
        )}
      </div>
      <div
        className={cn(
          "max-w-[82%] rounded-2xl px-3 py-2 text-sm leading-relaxed",
          isUser
            ? "bg-primary text-primary-foreground rounded-tr-sm"
            : "bg-muted text-foreground rounded-tl-sm",
        )}
      >
        {display || (
          <span className="text-[11px] italic opacity-60 flex items-center gap-1.5">
            {message.artifactHtml ? (
              <>
                <Star className="h-3 w-3" />
                Design generated
              </>
            ) : (
              <>
                <Loader2 className="h-3 w-3 animate-spin" />
                Generating…
              </>
            )}
          </span>
        )}
      </div>
    </div>
  );
}

function ChatInput({
  value,
  onChange,
  onSend,
  onStop,
  onKeyDown,
  isStreaming,
  disabled,
  inputRef,
  compact = false,
  providerSettings,
  onProviderSettingsChange,
  claudeAvailable,
  lastUsage,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  isStreaming: boolean;
  disabled: boolean;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  compact?: boolean;
  providerSettings: ProviderSettings;
  onProviderSettingsChange: (s: ProviderSettings) => void;
  claudeAvailable: boolean | null;
  lastUsage: ClaudeUsage | null;
}) {
  const getPlaceholder = () => {
    if (
      providerSettings.provider === "embedded-llama" &&
      disabled &&
      !isStreaming
    )
      return "Load a model in Engine first…";
    if (
      providerSettings.provider === "claude-code" &&
      claudeAvailable === false
    )
      return "Claude CLI not found — install with: npm install -g @anthropic-ai/claude-code";
    return "Describe what to design… (Enter to send, Shift+Enter for newline)";
  };

  return (
    <div
      className={cn(
        "px-3 shrink-0 border-t border-border/50",
        compact ? "py-1.5" : "py-2",
      )}
    >
      {/* Provider bar */}
      <div className="flex items-center gap-2 mb-1.5">
        <ProviderDropdown
          settings={providerSettings}
          onChange={onProviderSettingsChange}
          claudeAvailable={claudeAvailable}
        />
        {/* Provider status indicator */}
        {providerSettings.provider === "claude-code" && (
          <span
            className={cn(
              "text-[10px] rounded-full px-1.5 py-0.5 border",
              claudeAvailable === true
                ? "text-emerald-400 bg-emerald-400/10 border-emerald-400/20"
                : claudeAvailable === false
                  ? "text-red-400 bg-red-400/10 border-red-400/20"
                  : "text-muted-foreground bg-white/[0.03] border-white/[0.06]",
            )}
          >
            {claudeAvailable === true
              ? (CLAUDE_MODELS.find(
                  (m) => m.id === providerSettings.claudeModel,
                )?.label ?? "Sonnet 4.6")
              : claudeAvailable === false
                ? "Not found"
                : "Checking…"}
          </span>
        )}
        {providerSettings.provider === "ollama" && (
          <span className="text-[10px] text-muted-foreground">
            {providerSettings.ollamaModel || "mistral"} @{" "}
            {providerSettings.ollamaUrl.replace(/^https?:\/\//, "")}
          </span>
        )}
        {providerSettings.provider === "openai-compat" && (
          <span className="text-[10px] text-muted-foreground truncate max-w-[200px]">
            {providerSettings.openAiCompatModel || "gpt-4o"} @{" "}
            {providerSettings.openAiCompatUrl.replace(/^https?:\/\//, "")}
          </span>
        )}
        {/* Usage badge — shown after Claude generations */}
        {lastUsage && providerSettings.provider === "claude-code" && (
          <span className="ml-auto flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <span className="opacity-40">·</span>
            <span
              title={`In: ${lastUsage.inputTokens.toLocaleString()} · Out: ${lastUsage.outputTokens.toLocaleString()} tokens`}
            >
              {lastUsage.inputTokens > 0
                ? `${Math.round((lastUsage.inputTokens + lastUsage.outputTokens) / 1000)}K tok`
                : null}
            </span>
            {lastUsage.costUsd > 0 && (
              <span className="text-amber-400/70 font-medium">
                $
                {lastUsage.costUsd < 0.01
                  ? lastUsage.costUsd.toFixed(4)
                  : lastUsage.costUsd.toFixed(3)}
              </span>
            )}
          </span>
        )}
      </div>

      <div className="flex gap-2 items-end">
        <Textarea
          ref={inputRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={getPlaceholder()}
          disabled={(disabled && !isStreaming) || isStreaming}
          className={cn(
            "flex-1 resize-none text-sm",
            compact
              ? "min-h-[44px] max-h-[100px]"
              : "min-h-[60px] max-h-[140px]",
          )}
          rows={compact ? 1 : 2}
        />
        <Button
          onClick={isStreaming ? onStop : onSend}
          disabled={
            (disabled && !isStreaming) || (!value.trim() && !isStreaming)
          }
          size="icon"
          variant={isStreaming ? "destructive" : "default"}
          className={cn(
            "shrink-0",
            compact ? "h-[44px] w-[44px]" : "h-[60px] w-[60px]",
          )}
        >
          {isStreaming ? (
            <Square className="h-4 w-4 fill-current" />
          ) : (
            <Send className="h-4 w-4" />
          )}
        </Button>
      </div>
    </div>
  );
}

// =============================================================================
// Provider Dropdown
// =============================================================================
function ProviderDropdown({
  settings,
  onChange,
  claudeAvailable,
}: {
  settings: ProviderSettings;
  onChange: (s: ProviderSettings) => void;
  claudeAvailable: boolean | null;
}) {
  const [open, setOpen] = useState(false);
  const [showConfig, setShowConfig] = useState(false);
  const meta = PROVIDER_META[settings.provider];

  const providers: DesignProvider[] = [
    "embedded-llama",
    "claude-code",
    "ollama",
    "openai-compat",
  ];

  const needsConfig =
    settings.provider === "ollama" || settings.provider === "openai-compat";

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex items-center gap-1.5 px-2.5 py-1 rounded-2xl text-[11px] font-medium border transition-all",
          "bg-white/[0.04] border-white/[0.08] hover:border-white/[0.15] hover:bg-white/[0.07]",
          meta.color,
        )}
      >
        {meta.icon}
        <span>{meta.shortLabel}</span>
        <ChevronDown className="h-2.5 w-2.5 text-muted-foreground" />
      </button>

      {open && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => {
              setOpen(false);
              setShowConfig(false);
            }}
          />
          <div className="absolute bottom-full left-0 mb-1.5 z-50 bg-popover border border-border rounded-3xl shadow-xl py-1 w-72">
            {/* Provider list */}
            {!showConfig &&
              providers.map((p) => {
                const m = PROVIDER_META[p];
                const isActive = settings.provider === p;
                const isClaudeUnavailable =
                  p === "claude-code" && claudeAvailable === false;
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() => {
                      onChange({ ...settings, provider: p });
                      if (p === "ollama" || p === "openai-compat") {
                        setShowConfig(true);
                      } else {
                        setOpen(false);
                      }
                    }}
                    className={cn(
                      "w-full flex items-center gap-2.5 px-3 py-2 text-xs transition-colors",
                      isActive ? "bg-white/[0.06]" : "hover:bg-white/[0.04]",
                    )}
                  >
                    <span className={m.color}>{m.icon}</span>
                    <div className="flex-1 text-left">
                      <div className="font-medium">{m.label}</div>
                      <div className="text-[10px] text-muted-foreground">
                        {p === "embedded-llama" && "Your local Llama engine"}
                        {p === "claude-code" &&
                          (isClaudeUnavailable
                            ? "CLI not found on PATH"
                            : "claude CLI auto-detected")}
                        {p === "ollama" && "Ollama local server"}
                        {p === "openai-compat" &&
                          "Custom OpenAI-compatible API"}
                      </div>
                    </div>
                    {isActive && (
                      <CheckCircle2 className="h-3.5 w-3.5 text-primary shrink-0" />
                    )}
                    {isClaudeUnavailable && (
                      <AlertCircle className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                    )}
                    {(p === "ollama" || p === "openai-compat") && !isActive && (
                      <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
                    )}
                  </button>
                );
              })}

            {/* Provider config panel */}
            {showConfig && (
              <div className="px-3 py-2">
                <button
                  type="button"
                  onClick={() => setShowConfig(false)}
                  className="flex items-center gap-1.5 text-[10px] text-muted-foreground hover:text-foreground mb-3 transition-colors"
                >
                  <ChevronDown className="h-3 w-3 rotate-90" />
                  Back
                </button>

                {settings.provider === "ollama" && (
                  <div className="space-y-2">
                    <div className="text-[11px] font-semibold flex items-center gap-1.5 mb-2">
                      <span className={PROVIDER_META.ollama.color}>
                        {PROVIDER_META.ollama.icon}
                      </span>
                      Ollama settings
                    </div>
                    <div>
                      <label className="text-[10px] text-muted-foreground block mb-1">
                        Base URL
                      </label>
                      <input
                        type="text"
                        value={settings.ollamaUrl}
                        onChange={(e) =>
                          onChange({ ...settings, ollamaUrl: e.target.value })
                        }
                        className="w-full px-2 py-1.5 text-xs bg-white/[0.04] border border-white/[0.08] rounded-2xl outline-none focus:border-primary/40"
                        placeholder="http://localhost:11434"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-muted-foreground block mb-1">
                        Model name
                      </label>
                      <input
                        type="text"
                        value={settings.ollamaModel}
                        onChange={(e) =>
                          onChange({ ...settings, ollamaModel: e.target.value })
                        }
                        className="w-full px-2 py-1.5 text-xs bg-white/[0.04] border border-white/[0.08] rounded-2xl outline-none focus:border-primary/40"
                        placeholder="mistral"
                      />
                    </div>
                    <Button
                      size="sm"
                      className="w-full h-7 text-xs mt-1"
                      onClick={() => {
                        setOpen(false);
                        setShowConfig(false);
                      }}
                    >
                      Done
                    </Button>
                  </div>
                )}

                {settings.provider === "openai-compat" && (
                  <div className="space-y-2">
                    <div className="text-[11px] font-semibold flex items-center gap-1.5 mb-2">
                      <span className={PROVIDER_META["openai-compat"].color}>
                        {PROVIDER_META["openai-compat"].icon}
                      </span>
                      OpenAI-compat settings
                    </div>
                    <div>
                      <label className="text-[10px] text-muted-foreground block mb-1">
                        Base URL
                      </label>
                      <input
                        type="text"
                        value={settings.openAiCompatUrl}
                        onChange={(e) =>
                          onChange({
                            ...settings,
                            openAiCompatUrl: e.target.value,
                          })
                        }
                        className="w-full px-2 py-1.5 text-xs bg-white/[0.04] border border-white/[0.08] rounded-2xl outline-none focus:border-primary/40"
                        placeholder="https://api.openai.com"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-muted-foreground block mb-1">
                        Model
                      </label>
                      <input
                        type="text"
                        value={settings.openAiCompatModel}
                        onChange={(e) =>
                          onChange({
                            ...settings,
                            openAiCompatModel: e.target.value,
                          })
                        }
                        className="w-full px-2 py-1.5 text-xs bg-white/[0.04] border border-white/[0.08] rounded-2xl outline-none focus:border-primary/40"
                        placeholder="gpt-4o"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-muted-foreground block mb-1">
                        API Key (optional)
                      </label>
                      <input
                        type="password"
                        value={settings.openAiCompatKey}
                        onChange={(e) =>
                          onChange({
                            ...settings,
                            openAiCompatKey: e.target.value,
                          })
                        }
                        className="w-full px-2 py-1.5 text-xs bg-white/[0.04] border border-white/[0.08] rounded-2xl outline-none focus:border-primary/40"
                        placeholder="sk-..."
                      />
                    </div>
                    <Button
                      size="sm"
                      className="w-full h-7 text-xs mt-1"
                      onClick={() => {
                        setOpen(false);
                        setShowConfig(false);
                      }}
                    >
                      Done
                    </Button>
                  </div>
                )}
              </div>
            )}

            {/* Claude model picker (shown when claude-code is active) */}
            {!showConfig && settings.provider === "claude-code" && (
              <div className="px-3 pt-2 pb-2 border-t border-white/[0.06] mt-1">
                <div className="text-[10px] text-muted-foreground/60 mb-1.5 uppercase tracking-wider font-semibold">
                  Model
                </div>
                <div className="flex flex-col gap-0.5">
                  {CLAUDE_MODELS.map((m) => {
                    const active =
                      (settings.claudeModel || "claude-sonnet-4-6") === m.id;
                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() =>
                          onChange({ ...settings, claudeModel: m.id })
                        }
                        className={cn(
                          "w-full flex items-center justify-between px-2.5 py-1.5 rounded-2xl text-xs transition-all",
                          active
                            ? "bg-amber-400/15 text-amber-300"
                            : "text-muted-foreground hover:text-foreground hover:bg-white/[0.05]",
                        )}
                      >
                        <span className="font-medium">{m.label}</span>
                        <span className="text-[10px] opacity-60">{m.hint}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Config shortcut for currently active configurable provider */}
            {!showConfig && needsConfig && (
              <div className="px-3 pt-1 pb-1.5 border-t border-white/[0.06] mt-1">
                <button
                  type="button"
                  onClick={() => setShowConfig(true)}
                  className="flex items-center gap-1.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors w-full"
                >
                  <Settings2 className="h-3 w-3" />
                  Configure {PROVIDER_META[settings.provider].label}…
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function CritiqueScoreBar({
  score,
  loading,
}: {
  score: CritiqueScore | null;
  loading: boolean;
}) {
  const dims = [
    { key: "philosophy", label: "Philosophy" },
    { key: "hierarchy", label: "Hierarchy" },
    { key: "detail", label: "Detail" },
    { key: "function", label: "Function" },
    { key: "innovation", label: "Innovation" },
  ] as const;
  return (
    <div className="bg-muted/30 rounded-2xl border border-border/40 px-3 py-2">
      <div className="flex items-center gap-2 mb-1.5">
        <Star className="h-3 w-3 text-primary" />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Design Quality
        </span>
        {loading && (
          <Loader2 className="h-3 w-3 animate-spin text-muted-foreground ml-auto" />
        )}
      </div>
      {score ? (
        <>
          <div className="grid grid-cols-5 gap-1.5 mb-1.5">
            {dims.map(({ key, label }) => (
              <div key={key} className="flex flex-col gap-0.5">
                <div className="text-[9px] text-muted-foreground text-center">
                  {label}
                </div>
                <div className="h-1.5 rounded-full bg-border overflow-hidden">
                  <div
                    className="h-full rounded-full bg-primary transition-all duration-500"
                    style={{ width: `${(score[key] / 10) * 100}%` }}
                  />
                </div>
                <div className="text-[9px] text-center font-medium">
                  {score[key]}/10
                </div>
              </div>
            ))}
          </div>
          {score.summary && (
            <p className="text-[10px] text-muted-foreground italic">
              {score.summary}
            </p>
          )}
        </>
      ) : loading ? (
        <p className="text-[10px] text-muted-foreground">
          Evaluating design quality…
        </p>
      ) : null}
    </div>
  );
}

function ExportDropdown({
  onExport,
}: {
  onExport: (f: "html" | "pdf" | "zip") => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="sm"
        className="h-7 text-xs gap-1.5 shrink-0"
        onClick={() => setOpen((v) => !v)}
      >
        <Download className="h-3 w-3" />
        Export
        <ChevronDown className="h-3 w-3" />
      </Button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-8 z-50 bg-popover border border-border rounded-2xl shadow-lg py-1 w-36">
            {[
              { format: "html" as const, label: "HTML File", icon: FileText },
              { format: "pdf" as const, label: "PDF", icon: Archive },
              { format: "zip" as const, label: "ZIP Archive", icon: Archive },
            ].map(({ format, label, icon: Icon }) => (
              <button
                key={format}
                onClick={() => {
                  onExport(format);
                  setOpen(false);
                }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted transition-colors"
              >
                <Icon className="h-3 w-3 text-muted-foreground" />
                {label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function DirectionPickerModal({
  current,
  onSelect,
  onClose,
}: {
  current: DirectionId | null;
  onSelect: (id: DirectionId) => void;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-transparent border border-border rounded-2xl shadow-2xl p-6 w-[680px] max-w-[95vw]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold">Visual Direction</h2>
            <p className="text-sm text-muted-foreground">
              Choose a design language — each has a deterministic palette and
              font stack
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground text-lg leading-none"
          >
            ✕
          </button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {VISUAL_DIRECTIONS.map((dir) => (
            <button
              key={dir.id}
              onClick={() => onSelect(dir.id)}
              className={cn(
                "text-left rounded-3xl border-2 p-3 transition-all hover:scale-[1.01]",
                current === dir.id
                  ? "border-primary"
                  : "border-border/50 hover:border-border",
              )}
            >
              <div className="flex gap-1.5 mb-2">
                {[dir.bg, dir.fg, dir.accent].map((c) => (
                  <span
                    key={c}
                    className="h-4 w-4 rounded-full border border-white/10 shrink-0"
                    style={{ background: c }}
                  />
                ))}
              </div>
              <div className="font-semibold text-sm">{dir.name}</div>
              <div className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                {dir.description}
              </div>
              <div className="flex gap-1 mt-2 flex-wrap">
                {dir.traits.map((t) => (
                  <span
                    key={t}
                    className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground"
                  >
                    {t}
                  </span>
                ))}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function PromptGalleryModal({
  onSelect,
  onClose,
}: {
  onSelect: (p: string) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const [activeCategory, setActiveCategory] = useState("All");
  const totalPrompts = PROMPT_GALLERY.reduce((n, c) => n + c.prompts.length, 0);

  const visiblePrompts = PROMPT_GALLERY.filter(
    (cat) => activeCategory === "All" || cat.category === activeCategory,
  ).flatMap((cat) =>
    cat.prompts
      .filter(
        (p) =>
          !search ||
          p.label.toLowerCase().includes(search.toLowerCase()) ||
          p.prompt.toLowerCase().includes(search.toLowerCase()),
      )
      .map((p) => ({ ...p, category: cat.category, icon: cat.icon })),
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-[#0f0f14] border border-white/[0.08] rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        style={{ width: "min(780px, 95vw)", height: "min(620px, 88vh)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-4 shrink-0 border-b border-white/[0.06]">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-2xl bg-primary/15 flex items-center justify-center">
              <BookOpen className="h-4 w-4 text-primary" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-foreground">
                Prompt Gallery
              </h2>
              <p className="text-[11px] text-muted-foreground">
                {totalPrompts} curated starting points
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="h-7 w-7 flex items-center justify-center rounded-2xl text-muted-foreground hover:text-foreground hover:bg-white/[0.06] transition-all text-sm"
          >
            ✕
          </button>
        </div>

        {/* Search + Category tabs */}
        <div className="px-5 pt-3 pb-3 shrink-0 space-y-2.5 border-b border-white/[0.04]">
          <div className="relative">
            <svg
              className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/50"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search prompts…"
              autoFocus
              className="w-full pl-8 pr-4 py-2 text-sm bg-white/[0.04] border border-white/[0.07] rounded-2xl outline-none focus:border-primary/40 focus:bg-white/[0.06] text-foreground placeholder:text-muted-foreground/50 transition-all"
            />
          </div>
          {/* Category tabs */}
          <div className="flex gap-1.5 overflow-x-auto pb-0.5 scrollbar-none">
            {["All", ...PROMPT_GALLERY.map((c) => c.category)].map((cat) => {
              const meta = PROMPT_GALLERY.find((c) => c.category === cat);
              return (
                <button
                  key={cat}
                  onClick={() => setActiveCategory(cat)}
                  className={cn(
                    "flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-all border shrink-0",
                    activeCategory === cat
                      ? "bg-primary text-primary-foreground border-primary shadow-md"
                      : "bg-white/[0.04] text-muted-foreground border-white/[0.06] hover:text-foreground hover:bg-white/[0.07]",
                  )}
                >
                  {meta?.icon ?? "✦"} {cat}
                </button>
              );
            })}
          </div>
        </div>

        {/* Prompt grid — constrained scroll */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {visiblePrompts.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
              <BookOpen className="h-8 w-8 opacity-30" />
              <p className="text-sm">No prompts match your search</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2.5">
              {visiblePrompts.map((p) => (
                <button
                  key={`${p.category}-${p.label}`}
                  onClick={() => onSelect(p.prompt)}
                  className="group text-left p-4 rounded-3xl bg-white/[0.03] border border-white/[0.07] hover:bg-white/[0.07] hover:border-primary/30 transition-all flex flex-col gap-2"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm leading-none">{p.icon}</span>
                      <span className="text-xs font-semibold text-foreground group-hover:text-primary transition-colors leading-tight">
                        {p.label}
                      </span>
                    </div>
                    <span className="text-[10px] text-muted-foreground/50 shrink-0 pt-0.5">
                      {p.category}
                    </span>
                  </div>
                  <p className="text-[11px] text-muted-foreground leading-relaxed line-clamp-2">
                    {p.prompt}
                  </p>
                  <div className="flex items-center gap-1 text-[10px] text-primary/60 group-hover:text-primary transition-colors mt-auto pt-1 border-t border-white/[0.05]">
                    <Send className="h-2.5 w-2.5" />
                    Use this prompt
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
