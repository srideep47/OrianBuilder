/**
 * When Marta is allowed to speak without being spoken to.
 *
 * The main process already decides *what* is worth saying
 * (`src/main/marta/task_narrator.ts` coalesces the task event stream into
 * milestones). This module decides *whether and when* the renderer says it out
 * loud, which is a different question and belongs next to the audio pipeline:
 * only the renderer knows whether the user is mid-sentence.
 *
 * Pure on purpose. Getting this wrong is the difference between an assistant
 * that keeps you informed and one that talks over you, and that is not a
 * behaviour you want to discover by listening to it.
 */

import type { NarrationPriority } from "./runtime";
import type { VoicePhase } from "./turn_taking";

/** How much the user wants to hear. Persisted as a Marta preference. */
export type NarrationDetail = "quiet" | "normal" | "detailed";

/** The main-process narration payload, mirrored from `martaEvents.proactiveNarration`. */
export interface ProactiveNarrationInput {
  id: string;
  timestamp: number;
  priority: "quiet" | "normal" | "critical";
  text: string;
  taskIds: string[];
  speak: boolean;
}

export interface NarrationDecision {
  /** Always true for a real update: the transcript is the durable record. */
  record: boolean;
  /** Speak it now. */
  speak: boolean;
  /**
   * Hold it until the user stops talking, then speak.
   *
   * Distinct from `speak: false`: a deferred milestone is still worth hearing a
   * second later, whereas a dropped one never mattered.
   */
  defer: boolean;
  queuePriority: NarrationPriority;
  /** Cut off a lower-priority announcement that is already playing. */
  interruptLowerPriority: boolean;
}

/** The phases in which speaking over the user would be rude or self-defeating. */
function userHasTheFloor(phase: VoicePhase): boolean {
  // `capturing` is the user actually talking. `transcribing` is the ~300ms
  // afterwards where the mic is closed but the turn is theirs; announcing into
  // that gap reliably lands on top of their next sentence.
  return phase === "capturing" || phase === "transcribing";
}

/**
 * `quiet` detail still speaks critical failures.
 *
 * "Quiet" is a request for less chatter, not a request to be left uninformed
 * about a build that just died. Muting audio entirely is what the mic toggle is
 * for.
 */
export function decideNarration(
  narration: ProactiveNarrationInput,
  context: {
    detail: NarrationDetail;
    phase: VoicePhase;
    voiceEnabled: boolean;
  },
): NarrationDecision {
  const critical = narration.priority === "critical";
  const silent: NarrationDecision = {
    record: true,
    speak: false,
    defer: false,
    queuePriority: "background",
    interruptLowerPriority: false,
  };

  if (!context.voiceEnabled) return silent;

  const wanted =
    context.detail === "detailed"
      ? true
      : context.detail === "normal"
        ? narration.speak || critical
        : critical;
  if (!wanted) return silent;

  const queuePriority: NarrationPriority = critical ? "critical" : "status";

  // A critical update interrupts. Anything else waits: the user's own turn is
  // always more important than a status line.
  if (userHasTheFloor(context.phase) && !critical) {
    return {
      record: true,
      speak: false,
      defer: true,
      queuePriority,
      interruptLowerPriority: false,
    };
  }

  return {
    record: true,
    speak: true,
    defer: false,
    queuePriority,
    interruptLowerPriority: critical,
  };
}

/**
 * Collapse a backlog that built up while the user was speaking.
 *
 * Playing five held sentences in a row is worse than saying nothing: by the
 * time the third one plays it is describing the past. Only the newest update
 * per task survives, plus every critical one, because a failure that was
 * superseded by a later success still explains what happened.
 */
export function collapseDeferred(
  held: ReadonlyArray<ProactiveNarrationInput>,
): ProactiveNarrationInput[] {
  const newestByTask = new Map<string, ProactiveNarrationInput>();
  const critical: ProactiveNarrationInput[] = [];

  for (const narration of held) {
    if (narration.priority === "critical") {
      critical.push(narration);
      continue;
    }
    // Multi-task updates are keyed as a set so an aggregate does not shadow the
    // individual tasks it mentions, or vice versa.
    const key = [...narration.taskIds].sort().join("|") || narration.id;
    const previous = newestByTask.get(key);
    if (!previous || previous.timestamp <= narration.timestamp) {
      newestByTask.set(key, narration);
    }
  }

  return [...critical, ...newestByTask.values()].sort(
    (left, right) => left.timestamp - right.timestamp,
  );
}
