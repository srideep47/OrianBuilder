/**
 * Marta herself: one orb, one composer, and a transcript that is only there
 * when there is something to read.
 *
 * The orb is deliberately a single object rather than a row of indicators. It
 * is simultaneously "she is listening", "she is thinking" and "she is
 * speaking", because those are states of one thing and splitting them into
 * separate widgets is how a status bar happens.
 *
 * Docked below the Stage so the assistant never covers the work. The
 * transcript expands upward inside a bounded region while the active surface
 * keeps the rest of the window.
 */

import { useEffect, useRef, useState } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  ChevronDown,
  CornerDownLeft,
  Loader2,
  Mic,
  ShieldAlert,
  Square,
  Trash2,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { ipc } from "@/ipc/types";
import { LButton, material, radius } from "@/components/liquid";
import { OrianBuilderMarkdownParser } from "@/components/chat/OrianBuilderMarkdownParser";
import { martaModelStatusAtom, narrationDetailAtom } from "./presence_state";
import { rewindStageAtom, stageHistoryAtom } from "./stage_state";
import { transcriptExpandedAtom } from "./workspace_state";
import {
  useMartaTurn,
  type LiveMartaStep,
  type PendingDelegationChoice,
  type TranscriptEntry,
} from "./useMartaTurn";
import { useVoiceSession } from "./voice/useVoiceSession";
import { orbStateFor } from "./voice/turn_taking";
import { sanitizeAssistantPresentation } from "./presentation_text";

export function Presence() {
  const {
    transcript,
    busy,
    pending,
    delegationChoice,
    liveReply,
    liveSteps,
    send,
    approve,
    clear,
    cancel,
    noteProactiveNarration,
  } = useMartaTurn();
  const narrationDetail = useAtomValue(narrationDetailAtom);

  // Voice drives the same `send` the composer does, so a spoken turn and a
  // typed one are the same turn — one transcript, one approval flow, one place
  // where surfaces get summoned. `send` applies layout and task-control
  // language itself, so there is exactly one interpreter for both inputs.
  const voice = useVoiceSession({
    onUtterance: (text, callbacks) => send(text, [], callbacks),
    onCancelTurn: cancel,
    narrationDetail,
  });

  // Proactive reporting: the task ledger's milestones, spoken and recorded
  // without waiting for the user to ask. `announce` decides whether to speak
  // now, hold it until the user stops talking, or stay silent; the transcript
  // entry is written either way so a muted update is still visible.
  const announceRef = useRef(voice.announce);
  announceRef.current = voice.announce;
  useEffect(
    () =>
      ipc.events.marta.onProactiveNarration((narration) => {
        announceRef.current(narration);
        noteProactiveNarration(narration);
      }),
    [noteProactiveNarration],
  );
  const orb = orbStateFor(voice.phase);
  const model = useAtomValue(martaModelStatusAtom);
  const history = useAtomValue(stageHistoryAtom);
  const rewind = useSetAtom(rewindStageAtom);

  const [value, setValue] = useState("");
  // Work remains the default visual focus. Conversation is one deliberate
  // click away and never claims a third of the Stage merely because a status
  // acknowledgement arrived.
  const [expanded, setExpanded] = useAtom(transcriptExpandedAtom);
  const [dismissedNarrationId, setDismissedNarrationId] = useState<
    string | undefined
  >(undefined);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript, liveReply, liveSteps]);

  /**
   * Open the conversation while a decision is blocking work.
   *
   * The transcript is collapsed by default so it never covers the work — but a
   * pending worker choice or permission request is a question, and the user's
   * reply to it gets answered *in the transcript*. Asking "what are my options?"
   * and having the answer land somewhere invisible is not a restrained UI, it is
   * a broken one. Collapsing again is still one click, or "hide the conversation".
   */
  useEffect(() => {
    if (delegationChoice || pending) setExpanded(true);
  }, [delegationChoice, pending, setExpanded]);

  // ⌘/Ctrl-Enter focuses the composer from anywhere, including from inside a
  // surface that has stolen focus for its own editor.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const submit = () => {
    const text = value;
    setValue("");
    void send(text);
  };

  const hasTranscript = transcript.length > 0;
  // The transcript stays collapsed by default so it never covers the work. That
  // would silently hide proactive reporting, which is the one kind of message
  // the user has not already seen — so the newest one gets a single line here
  // until it is read or dismissed.
  const latestProactive = [...transcript]
    .reverse()
    .find((entry) => entry.proactive);
  const showTicker =
    !expanded &&
    latestProactive !== undefined &&
    latestProactive.narrationId !== dismissedNarrationId;
  const modelLabel = model.running
    ? `Marta · ${model.placement === "cpu" ? "CPU companion" : "GPU companion"}`
    : "Marta · model paused";

  return (
    <div className="pointer-events-none relative z-30 flex shrink-0 justify-center px-3 pb-3">
      <div className="pointer-events-auto flex w-full max-w-[800px] flex-col gap-2">
        {hasTranscript && expanded && (
          <div
            className={cn(
              "flex max-h-[34vh] flex-col gap-2.5 overflow-y-auto p-3",
              radius.md,
              material.rim,
              material.blurThick,
              "bg-[color-mix(in_srgb,var(--cosmos-bg)_78%,transparent)]",
              material.lift,
            )}
          >
            {transcript.map((entry, i) => (
              <Bubble key={i} entry={entry} />
            ))}
            {busy && <LiveBubble content={liveReply} steps={liveSteps} />}
            <div ref={endRef} />
          </div>
        )}

        {showTicker && latestProactive && (
          <button
            type="button"
            data-testid="marta-narration-ticker"
            onClick={() => setExpanded(true)}
            className={cn(
              "flex items-center gap-2.5 px-3 py-2 text-left",
              radius.sm,
              material.rim,
              material.blur,
              "bg-[color-mix(in_srgb,var(--cosmos-bg)_70%,transparent)]",
              "transition-colors hover:bg-[color-mix(in_srgb,var(--cosmos-bg)_82%,transparent)]",
            )}
            aria-label="Show the transcript for this update"
          >
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--cosmos-violet)] shadow-[0_0_8px_var(--cosmos-violet)]"
            />
            <span className="min-w-0 flex-1 truncate text-[11px] leading-[1.45] text-foreground/72">
              {sanitizeAssistantPresentation(latestProactive.content)}
            </span>
            <span
              role="button"
              tabIndex={-1}
              aria-label="Dismiss this update"
              onClick={(event) => {
                event.stopPropagation();
                setDismissedNarrationId(latestProactive.narrationId);
              }}
              className="shrink-0 rounded-full p-0.5 text-muted-foreground hover:text-foreground"
            >
              <ChevronDown className="h-3 w-3 rotate-180" />
            </span>
          </button>
        )}

        {pending && (
          <div
            className={cn(
              "flex items-center gap-3 px-3.5 py-2.5",
              radius.sm,
              "border border-[color-mix(in_srgb,var(--cosmos-amber)_35%,transparent)]",
              "bg-[color-mix(in_srgb,var(--cosmos-amber)_12%,transparent)]",
              material.blur,
            )}
          >
            <ShieldAlert className="h-4 w-4 shrink-0 text-[var(--cosmos-amber)]" />
            <span className="min-w-0 flex-1 text-[12px] leading-[1.45]">
              She needs your say-so to run{" "}
              <code className="font-mono text-[11px]">{pending.actionId}</code>.
            </span>
            <LButton tone="ghost" size="compact" onClick={() => void approve()}>
              Allow once
            </LButton>
          </div>
        )}

        {delegationChoice && (
          <DelegationConversationPrompt request={delegationChoice} />
        )}

        <div className="pointer-events-none -mb-0.5 self-center rounded-full border border-white/[0.10] bg-[color-mix(in_srgb,var(--cosmos-bg)_58%,transparent)] px-2.5 py-1 text-[10px] font-medium tracking-[0.08em] text-foreground/65 shadow-[0_8px_24px_rgba(0,0,0,0.2)] backdrop-blur-xl">
          {modelLabel}
        </div>

        <div
          className={cn(
            "flex items-end gap-2.5 p-2.5",
            radius.md,
            material.rim,
            material.rimStrong,
            material.blurThick,
            material.sheen,
            "bg-[linear-gradient(135deg,color-mix(in_srgb,var(--cosmos-deep)_74%,transparent),color-mix(in_srgb,var(--cosmos-bg)_58%,transparent))]",
            "shadow-[0_22px_70px_rgba(0,0,0,0.5)]",
          )}
        >
          <Orb
            busy={busy || orb.busy}
            listening={orb.listening}
            speaking={orb.speaking}
            running={model.running}
            placement={model.placement}
          />

          <textarea
            ref={inputRef}
            rows={1}
            value={value}
            placeholder={
              delegationChoice
                ? "Tell Marta which model to use, or ask for the options…"
                : model.running
                  ? "Ask Marta for anything…"
                  : "Marta's model is not running — open Settings to start her."
            }
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            className="max-h-32 min-h-[36px] flex-1 resize-none bg-transparent px-1 py-1.5 text-[14px] leading-[1.5] text-foreground outline-none placeholder:text-foreground/50"
          />

          <div className="flex shrink-0 items-center gap-1">
            {history.length > 0 && (
              <IconAction
                label="Back to the previous screen"
                onClick={() => rewind()}
              >
                <ChevronDown className="h-3.5 w-3.5 rotate-90" />
              </IconAction>
            )}
            {hasTranscript && (
              <>
                <IconAction
                  label={
                    expanded ? "Hide the transcript" : "Show the transcript"
                  }
                  onClick={() => setExpanded((v) => !v)}
                >
                  <ChevronDown
                    className={cn(
                      "h-3.5 w-3.5 transition-transform",
                      !expanded && "rotate-180",
                    )}
                  />
                </IconAction>
                <IconAction label="Start over" onClick={() => void clear()}>
                  <Trash2 className="h-3.5 w-3.5" />
                </IconAction>
              </>
            )}
            <IconAction
              label={voice.enabled ? "Stop listening" : "Talk to Marta"}
              onClick={voice.toggle}
              disabled={!model.running}
              active={voice.enabled}
            >
              {voice.enabled ? (
                <Square className="h-3 w-3 fill-current" />
              ) : (
                <Mic className="h-3.5 w-3.5" />
              )}
            </IconAction>
            <IconAction
              label="Send"
              onClick={submit}
              disabled={busy || !value.trim()}
              primary
            >
              <CornerDownLeft className="h-3.5 w-3.5" />
            </IconAction>
          </div>
        </div>

        {(voice.error || voice.modelStatus === "loading" || voice.enabled) && (
          <p className="px-2 text-[11px] text-muted-foreground">
            {voice.error ??
              (voice.modelStatus === "loading"
                ? `Preparing speech recognition… ${voice.modelLoadProgress}%`
                : voice.phase === "capturing"
                  ? "Listening… pause naturally when you are finished."
                  : voice.phase === "transcribing"
                    ? "Transcribing locally…"
                    : voice.phase === "thinking"
                      ? "Marta is thinking — you can interrupt at any time."
                      : voice.phase === "speaking"
                        ? "Marta is speaking — talk over her to interrupt."
                        : "Voice mode is on — speak naturally.")}
          </p>
        )}
      </div>
    </div>
  );
}

export function DelegationConversationPrompt({
  request,
}: {
  request: PendingDelegationChoice;
}) {
  return (
    <section
      className={cn(
        "flex items-start gap-3 px-3.5 py-3",
        radius.md,
        material.rim,
        material.blur,
        "bg-[linear-gradient(115deg,color-mix(in_srgb,var(--cosmos-violet)_11%,var(--cosmos-bg)),color-mix(in_srgb,var(--cosmos-bg)_88%,transparent))]",
      )}
      aria-label="Waiting for a spoken or typed coding model choice"
    >
      <span className="relative mt-1 flex h-2.5 w-2.5 shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/45" />
        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-primary" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-primary">
            Waiting for your direction
          </p>
          <p className="text-[9px] uppercase tracking-[0.1em] text-foreground/40">
            Voice or text
          </p>
        </div>
        <p className="mt-1 text-[12px] leading-[1.45] text-foreground/78">
          Tell Marta which local or Claude model should do the work. If you are
          unsure, ask “what are my options?”
        </p>
        <p className="mt-1.5 line-clamp-1 text-[10px] text-foreground/45">
          Task: {request.goal}
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5 text-[9px] text-foreground/50">
          <span className="rounded-full border border-white/[0.08] bg-white/[0.03] px-2 py-0.5">
            “Local Qwen 4B”
          </span>
          <span className="rounded-full border border-white/[0.08] bg-white/[0.03] px-2 py-0.5">
            “Claude Haiku, low effort”
          </span>
          <span className="rounded-full border border-white/[0.08] bg-white/[0.03] px-2 py-0.5">
            “Always use local Qwen 4B”
          </span>
        </div>
      </div>
    </section>
  );
}

/**
 * Mic state, thinking indicator and speaking waveform in one object.
 *
 * Currently it has three states — stopped, idle, thinking. The voice bus adds
 * listening and speaking to the same object rather than beside it.
 */
function Orb({
  busy,
  listening,
  speaking,
  running,
  placement,
}: {
  busy: boolean;
  listening: boolean;
  speaking: boolean;
  running: boolean;
  placement: "gpu" | "cpu" | null;
}) {
  const title = !running
    ? "Marta's model is not running"
    : speaking
      ? "Speaking — start talking to interrupt"
      : listening
        ? "Listening"
        : `Marta is running on ${placement?.toUpperCase() ?? "?"}`;

  return (
    <div
      className="relative grid h-10 w-10 shrink-0 place-items-center"
      title={title}
    >
      <span
        className={cn(
          "absolute inset-0 rounded-full transition-opacity duration-500",
          running
            ? "bg-[radial-gradient(circle_at_35%_30%,var(--cosmos-violet-3),var(--cosmos-violet-2)_36%,transparent_72%)]"
            : "bg-white/[0.06]",
          busy ? "animate-pulse opacity-100" : "opacity-90",
        )}
      />
      {/* Listening and speaking are rings on the same object rather than
          separate indicators: they are states of one thing, and a row of
          lights is how a status bar starts. */}
      {(listening || speaking) && (
        <span
          className={cn(
            "absolute inset-0 rounded-full border-2",
            speaking
              ? "animate-[ping_1.4s_ease-out_infinite] border-primary/70"
              : "border-[var(--cosmos-green)]/70",
          )}
        />
      )}
      <span
        className={cn(
          "relative h-2.5 w-2.5 rounded-full transition-colors",
          !running
            ? "bg-muted-foreground/40"
            : placement === "cpu"
              ? "bg-[var(--cosmos-amber)]"
              : "bg-white",
        )}
      />
      {busy && (
        <Loader2 className="absolute h-10 w-10 animate-spin text-primary/55" />
      )}
    </div>
  );
}

function IconAction({
  children,
  label,
  onClick,
  disabled,
  primary,
  active,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "grid h-8 w-8 place-items-center rounded-full transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-35",
        primary
          ? "bg-primary/20 text-primary hover:bg-primary/30"
          : active
            ? "bg-[color-mix(in_srgb,var(--cosmos-green)_18%,transparent)] text-[var(--cosmos-green)]"
            : "text-muted-foreground hover:bg-white/[0.07] hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function Bubble({ entry }: { entry: TranscriptEntry }) {
  if (entry.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] whitespace-pre-wrap rounded-[16px] rounded-br-[5px] border border-white/25 bg-gradient-to-b from-[var(--cosmos-violet)] to-[var(--cosmos-violet-2)] px-3.5 py-2 text-[13px] leading-[1.5] text-white">
          {entry.content}
        </div>
      </div>
    );
  }

  const safeContent = sanitizeAssistantPresentation(entry.content);

  if (entry.proactive) {
    // Visually distinct from an answer, because it is not one: nobody asked.
    // Reading it as a reply to the message above would be actively confusing
    // when it lands mid-conversation about something else.
    return (
      <div
        data-testid="marta-proactive-update"
        className="flex items-start gap-2 rounded-[12px] border border-white/[0.07] bg-white/[0.028] px-3 py-2"
      >
        <span
          aria-hidden="true"
          className="mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--cosmos-violet)] shadow-[0_0_8px_var(--cosmos-violet)]"
        />
        <span className="min-w-0 flex-1">
          <span className="block text-[8px] font-semibold uppercase tracking-[0.13em] text-primary/60">
            Live update
          </span>
          <span className="mt-0.5 block text-[12px] leading-[1.5] text-foreground/78">
            {safeContent}
          </span>
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      {entry.steps && entry.steps.length > 0 && (
        // What she did, not how she reasoned. One line per tool so a wrong
        // choice is visible without opening anything — the whole point of the
        // orchestrator is that you can see it working.
        <div className="flex flex-wrap gap-1">
          {entry.steps.map((step, i) => (
            <span
              key={i}
              title={step.detail}
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[10px]",
                step.ok
                  ? "bg-[color-mix(in_srgb,var(--cosmos-green)_14%,transparent)] text-[var(--cosmos-green)]"
                  : "bg-[color-mix(in_srgb,var(--cosmos-red)_14%,transparent)] text-[var(--cosmos-red)]",
              )}
            >
              {step.label}
            </span>
          ))}
        </div>
      )}
      <div className="prose prose-sm dark:prose-invert max-w-[86%] text-[13px] leading-[1.55] text-foreground prose-p:my-1 prose-pre:my-2">
        <OrianBuilderMarkdownParser
          content={safeContent}
          chatId={null}
          isStreaming={false}
        />
      </div>
    </div>
  );
}

function LiveBubble({
  content,
  steps,
}: {
  content: string;
  steps: LiveMartaStep[];
}) {
  const safeContent = sanitizeAssistantPresentation(content);
  return (
    <div className="flex flex-col gap-2 rounded-[14px] border border-primary/10 bg-primary/[0.035] p-2.5">
      <div className="flex items-center gap-2 text-[9px] font-semibold uppercase tracking-[0.12em] text-primary/75">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary shadow-[0_0_10px_var(--cosmos-violet)]" />
        Marta is working
      </div>
      {steps.length > 0 && (
        <div className="flex flex-col gap-1">
          {steps.map((step) => (
            <div
              key={step.id}
              title={step.detail}
              className="flex items-center gap-2 text-[10px]"
            >
              <span
                className={cn(
                  "h-1.5 w-1.5 shrink-0 rounded-full",
                  step.status === "running"
                    ? "animate-pulse bg-primary"
                    : step.status === "success"
                      ? "bg-[var(--cosmos-green)]"
                      : "bg-[var(--cosmos-red)]",
                )}
              />
              <span className="truncate text-foreground/70">{step.label}</span>
              <span className="ml-auto font-mono text-[8px] uppercase text-muted-foreground">
                {step.status}
              </span>
            </div>
          ))}
        </div>
      )}
      {safeContent ? (
        <div className="prose prose-sm dark:prose-invert max-w-[92%] text-[13px] leading-[1.55] text-foreground">
          <OrianBuilderMarkdownParser
            content={safeContent}
            chatId={null}
            isStreaming
          />
        </div>
      ) : (
        <div className="flex gap-1 py-1" aria-label="Marta is thinking">
          {[0, 1, 2].map((index) => (
            <span
              key={index}
              className="h-1.5 w-1.5 animate-pulse rounded-full bg-foreground/35"
              style={{ animationDelay: `${index * 140}ms` }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
