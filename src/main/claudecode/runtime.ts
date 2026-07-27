import { type ChildProcess, execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { app } from "electron";
import log from "electron-log";

const execFileAsync = promisify(execFile);
const logger = log.scope("claude-code");

/**
 * The Claude Code CLI as a first-class Orion runtime.
 *
 * Ported from OrionAndroid's `claudecode/ClaudeCodeProcess.kt`, minus the proot
 * sandbox — on desktop `claude` runs natively against the real project directory,
 * so its own Read/Write/Edit/Bash tools operate on the files the user can see.
 *
 * Deliberately **not** wrapped as a `LanguageModelV3` provider. Claude Code is an
 * agent that carries its own tool loop; exposing it through the AI-SDK model path
 * would mean intercepting and re-implementing those tools, which is exactly what
 * the Android handoff notes as the thing to avoid. It is a *mode* alongside the
 * model picker, not an entry in it.
 *
 * One persistent process per project, keyed by directory. The session id the CLI
 * returns is stored per project and replayed as `--resume`, so a conversation
 * survives an app restart the same way it does on the phone.
 */

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan";

export type Effort = "low" | "medium" | "high";

export interface ClaudeCodeAvailability {
  available: boolean;
  version?: string;
  /** Absolute path when we resolved one, for display. */
  executable?: string;
  error?: string;
}

/** Cumulative and last-turn cost/usage, parsed off the terminal `result` event. */
export interface TurnUsage {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  numTurns: number;
  durationMs: number;
}

/** One event from a turn, already normalised for the renderer. */
export type ClaudeEvent =
  | { kind: "session"; sessionId: string; model?: string }
  | { kind: "text"; delta: string }
  | { kind: "thinking"; delta: string }
  | {
      kind: "tool-start";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | { kind: "tool-end"; id: string; ok: boolean; output: string }
  | {
      kind: "permission";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | { kind: "usage"; usage: TurnUsage }
  | { kind: "done"; ok: boolean; error?: string };

const SESSION_FILE = "claude-code-sessions.json";

/** Per-project session ids, so `--resume` survives a restart. */
async function sessionStorePath(): Promise<string> {
  return path.join(app.getPath("userData"), SESSION_FILE);
}

async function readSessions(): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(await sessionStorePath(), "utf8");
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

async function writeSession(
  projectDir: string,
  sessionId: string,
): Promise<void> {
  const all = await readSessions();
  all[projectDir] = sessionId;
  await fs.writeFile(
    await sessionStorePath(),
    JSON.stringify(all, null, 2),
    "utf8",
  );
}

async function clearSession(projectDir: string): Promise<void> {
  const all = await readSessions();
  delete all[projectDir];
  await fs.writeFile(
    await sessionStorePath(),
    JSON.stringify(all, null, 2),
    "utf8",
  );
}

let cachedAvailability: ClaudeCodeAvailability | null = null;

/** Is the CLI installed and authenticated enough to answer `--version`? */
export async function detectClaudeCode(
  force = false,
): Promise<ClaudeCodeAvailability> {
  if (!force && cachedAvailability) return cachedAvailability;
  try {
    const { stdout } = await execFileAsync("claude", ["--version"], {
      timeout: 15_000,
      windowsHide: true,
      shell: process.platform === "win32",
    });
    cachedAvailability = { available: true, version: stdout.trim() };
  } catch (err) {
    cachedAvailability = {
      available: false,
      error:
        "The Claude Code CLI is not on PATH. Install it, then run `claude` once to sign in with your subscription.",
    };
    logger.info(`claude not available: ${(err as Error).message}`);
  }
  return cachedAvailability;
}

export function invalidateClaudeCodeCache(): void {
  cachedAvailability = null;
}

interface Session {
  projectDir: string;
  child: ChildProcess;
  /** Resolves when the current turn's terminal `result` event arrives. */
  turnLock: Promise<void> | null;
  sessionId: string | null;
  model?: string;
  stdoutBuffer: string;
  /** Cumulative across the session, for the stats strip. */
  totals: TurnUsage;
}

const sessions = new Map<string, Session>();

function emptyUsage(): TurnUsage {
  return {
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    numTurns: 0,
    durationMs: 0,
  };
}

/**
 * `stream-json` has no published schema — this mapping is empirical, carried over
 * from Android's `StreamJsonEventMapper`. Every field read here defaults rather
 * than throwing, so one renamed key in a future CLI release degrades a single
 * event instead of killing the turn.
 */
function mapEvent(
  raw: Record<string, unknown>,
  session: Session,
): ClaudeEvent[] {
  const out: ClaudeEvent[] = [];
  const type = String(raw.type ?? "");

  if (type === "system" && raw.subtype === "init") {
    const sessionId =
      typeof raw.session_id === "string" ? raw.session_id : null;
    if (sessionId) {
      session.sessionId = sessionId;
      void writeSession(session.projectDir, sessionId);
    }
    const model = typeof raw.model === "string" ? raw.model : undefined;
    if (model) session.model = model;
    if (sessionId) out.push({ kind: "session", sessionId, model });
    return out;
  }

  // Token-by-token deltas, enabled by --include-partial-messages.
  if (type === "stream_event") {
    const event = raw.event as Record<string, unknown> | undefined;
    if (event?.type === "content_block_delta") {
      const delta = event.delta as Record<string, unknown> | undefined;
      if (typeof delta?.text === "string") {
        out.push({ kind: "text", delta: delta.text });
      } else if (typeof delta?.thinking === "string") {
        out.push({ kind: "thinking", delta: delta.thinking });
      }
    }
    return out;
  }

  if (type === "assistant") {
    const message = raw.message as Record<string, unknown> | undefined;
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const part of content as Array<Record<string, unknown>>) {
      if (part.type === "tool_use") {
        out.push({
          kind: "tool-start",
          id: String(part.id ?? ""),
          name: String(part.name ?? "tool"),
          input: (part.input as Record<string, unknown>) ?? {},
        });
      }
    }
    return out;
  }

  if (type === "user") {
    const message = raw.message as Record<string, unknown> | undefined;
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const part of content as Array<Record<string, unknown>>) {
      if (part.type === "tool_result") {
        const body = part.content;
        out.push({
          kind: "tool-end",
          id: String(part.tool_use_id ?? ""),
          ok: part.is_error !== true,
          output:
            typeof body === "string"
              ? body
              : JSON.stringify(body ?? "", null, 2),
        });
      }
    }
    return out;
  }

  // The CLI asks for permission out-of-band when --permission-mode is `default`.
  if (type === "control_request") {
    const request = raw.request as Record<string, unknown> | undefined;
    if (request?.subtype === "can_use_tool") {
      out.push({
        kind: "permission",
        id: String(raw.request_id ?? ""),
        name: String(request.tool_name ?? "tool"),
        input: (request.input as Record<string, unknown>) ?? {},
      });
    }
    return out;
  }

  if (type === "result") {
    const usageRaw = (raw.usage as Record<string, unknown>) ?? {};
    const turn: TurnUsage = {
      costUsd: Number(raw.total_cost_usd ?? 0) || 0,
      inputTokens: Number(usageRaw.input_tokens ?? 0) || 0,
      outputTokens: Number(usageRaw.output_tokens ?? 0) || 0,
      cacheReadTokens: Number(usageRaw.cache_read_input_tokens ?? 0) || 0,
      cacheCreationTokens:
        Number(usageRaw.cache_creation_input_tokens ?? 0) || 0,
      numTurns: Number(raw.num_turns ?? 0) || 0,
      durationMs: Number(raw.duration_ms ?? 0) || 0,
    };
    // Cost is reported cumulatively for the session; tokens are per turn.
    session.totals = {
      costUsd: Math.max(session.totals.costUsd, turn.costUsd),
      inputTokens: turn.inputTokens,
      outputTokens: turn.outputTokens,
      cacheReadTokens: turn.cacheReadTokens,
      cacheCreationTokens: turn.cacheCreationTokens,
      numTurns: turn.numTurns,
      durationMs: turn.durationMs,
    };
    out.push({ kind: "usage", usage: session.totals });
    out.push({
      kind: "done",
      ok: raw.is_error !== true && raw.subtype !== "error",
      error: typeof raw.error === "string" ? raw.error : undefined,
    });
    return out;
  }

  return out;
}

export interface TurnOptions {
  projectDir: string;
  prompt: string;
  model?: string;
  effort?: Effort;
  permissionMode?: PermissionMode;
  /** Start a new conversation instead of resuming the stored session. */
  fresh?: boolean;
  /** Extra system-prompt text appended to the CLI's own. */
  appendSystemPrompt?: string;
}

/**
 * Runs one turn, yielding normalised events.
 *
 * A fresh process per turn rather than one long-lived process fed many turns.
 * Android keeps a persistent process and documents the consequence as an
 * unresolved bug: its `readLine()` has no timeout, so a hung CLI holds the turn
 * lock forever and deadlocks every later turn. Per-turn spawn plus `--resume`
 * gives the same conversation continuity with none of that exposure — a wedged
 * process dies with its turn, and the next turn starts clean.
 */
export async function* runTurn(
  options: TurnOptions,
): AsyncGenerator<ClaudeEvent> {
  const availability = await detectClaudeCode();
  if (!availability.available) {
    yield { kind: "done", ok: false, error: availability.error };
    return;
  }

  const projectDir = path.resolve(options.projectDir);
  const stored = await readSessions();
  const resumeId = options.fresh ? undefined : stored[projectDir];

  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--permission-mode",
    options.permissionMode ?? "acceptEdits",
  ];
  if (options.model) args.push("--model", options.model);
  if (options.effort) args.push("--effort", options.effort);
  if (resumeId) args.push("--resume", resumeId);
  if (options.appendSystemPrompt) {
    args.push("--append-system-prompt", options.appendSystemPrompt);
  }

  logger.info(
    `claude turn in ${projectDir}${resumeId ? ` (resume ${resumeId})` : ""}`,
  );

  const child = spawn("claude", args, {
    cwd: projectDir,
    shell: process.platform === "win32",
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const session: Session = {
    projectDir,
    child,
    turnLock: null,
    sessionId: resumeId ?? null,
    stdoutBuffer: "",
    totals: sessions.get(projectDir)?.totals ?? emptyUsage(),
  };
  sessions.set(projectDir, session);

  // EPIPE: the CLI can exit before reading stdin (bad auth, unknown model). The
  // stderr/exit path reports the real reason, so this write error is noise.
  child.stdin?.on("error", () => undefined);
  child.stdin?.write(
    `${JSON.stringify({
      type: "user",
      message: { role: "user", content: options.prompt },
    })}\n`,
  );
  child.stdin?.end();

  const queue: ClaudeEvent[] = [];
  let finished = false;
  let stderrText = "";
  let notify: (() => void) | null = null;
  const wake = () => {
    notify?.();
    notify = null;
  };

  child.stdout?.on("data", (buf: Buffer) => {
    session.stdoutBuffer += buf.toString("utf8");
    let newline = session.stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = session.stdoutBuffer.slice(0, newline).trim();
      session.stdoutBuffer = session.stdoutBuffer.slice(newline + 1);
      if (line) {
        try {
          queue.push(
            ...mapEvent(JSON.parse(line) as Record<string, unknown>, session),
          );
        } catch {
          // A non-JSON line is the CLI printing something conversational; the
          // structured events are what we consume, so ignore it.
        }
      }
      newline = session.stdoutBuffer.indexOf("\n");
    }
    wake();
  });

  child.stderr?.on("data", (buf: Buffer) => {
    stderrText += buf.toString("utf8");
  });

  child.on("exit", (code) => {
    // A clean turn already queued its own `done` from the result event. This
    // covers the crash case, where nothing else would ever terminate the stream.
    if (!queue.some((e) => e.kind === "done")) {
      queue.push({
        kind: "done",
        ok: code === 0,
        error:
          stderrText.trim() ||
          (code === 0 ? undefined : `claude exited with code ${code}`),
      });
    }
    finished = true;
    wake();
  });

  // A turn that produces nothing for this long is wedged. Android has no such
  // guard and documents the resulting deadlock as a known bug.
  const IDLE_TIMEOUT_MS = 10 * 60_000;
  let lastActivity = Date.now();

  while (true) {
    while (queue.length > 0) {
      lastActivity = Date.now();
      const event = queue.shift()!;
      yield event;
      if (event.kind === "done") {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        return;
      }
    }
    if (finished) return;
    if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      yield {
        kind: "done",
        ok: false,
        error: `No output from the Claude Code CLI for ${IDLE_TIMEOUT_MS / 60_000} minutes; the turn was cancelled.`,
      };
      return;
    }
    await new Promise<void>((resolve) => {
      notify = resolve;
      setTimeout(resolve, 500);
    });
  }
}

/** Kills the in-flight turn for a project, if any. */
export function cancelTurn(projectDir: string): boolean {
  const session = sessions.get(path.resolve(projectDir));
  if (!session) return false;
  try {
    session.child.kill();
  } catch {
    return false;
  }
  return true;
}

/** Forgets the stored session so the next turn starts a new conversation. */
export async function resetSession(projectDir: string): Promise<void> {
  const resolved = path.resolve(projectDir);
  cancelTurn(resolved);
  sessions.delete(resolved);
  await clearSession(resolved);
}

/** Cumulative cost/usage for a project's session, for the stats strip. */
export function sessionUsage(projectDir: string): TurnUsage | null {
  return sessions.get(path.resolve(projectDir))?.totals ?? null;
}

/** The stored resume id, so the UI can show whether a session will continue. */
export async function storedSessionId(
  projectDir: string,
): Promise<string | null> {
  const all = await readSessions();
  return all[path.resolve(projectDir)] ?? null;
}

/** Kills every session. Called on quit so no CLI outlives the window. */
export function killAll(): void {
  for (const session of sessions.values()) {
    try {
      session.child.kill();
    } catch {
      /* already gone */
    }
  }
  sessions.clear();
}
