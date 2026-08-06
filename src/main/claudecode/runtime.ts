import { type ChildProcess, execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
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

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ClaudeCodeAvailability {
  available: boolean;
  version?: string;
  /** Absolute path when we resolved one, for display. */
  executable?: string;
  loggedIn?: boolean;
  email?: string;
  subscriptionType?: string;
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
  /** Context usage reported by Claude Code for the latest completed turn. */
  contextUsedTokens: number;
  contextWindowTokens: number;
}

export interface ClaudeQuotaWindow {
  usedPercentage: number | null;
  resetsAtEpochSeconds: number | null;
}

export interface ClaudeModelQuota extends ClaudeQuotaWindow {
  displayName: string;
}

export interface ClaudeAccountUsage {
  fiveHour: ClaudeQuotaWindow;
  sevenDay: ClaudeQuotaWindow;
  modelScoped: ClaudeModelQuota[];
  fetchedAt: number;
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

/**
 * Find the real Claude Code binary.
 *
 * Two Windows traps, both of which produced "the CLI is not on PATH" on a
 * machine where `claude --version` works perfectly in a terminal:
 *
 *   1. **A shim is not an executable.** The npm bin directory holds `claude`
 *      (a shell script), `claude.cmd` and `claude.ps1`. `execFile` with
 *      `shell: false` calls `CreateProcess`, which can launch none of those —
 *      so falling back to the bare name `"claude"` fails even though the shim
 *      is right there on PATH. The package's own `claude.exe`, one directory
 *      deeper, is the thing that can actually be spawned.
 *   2. **The install location is not npm's user-global one.** Under nvm4w the
 *      global package lives beside the active Node version
 *      (`C:\nvm4w\nodejs\node_modules\...`), not under `%APPDATA%\npm`. Only
 *      checking the latter meant the CLI was invisible on every nvm setup.
 *
 * So: walk PATH and look for the package's real executable next to each entry,
 * before giving up and handing the bare name to the OS.
 */
export function claudeExecutableCandidates(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const executableName = platform === "win32" ? "claude.exe" : "claude";
  const separator = platform === "win32" ? ";" : ":";
  const join = platform === "win32" ? path.win32.join : path.posix.join;
  const packageBin = (root: string): string =>
    join(
      root,
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      "bin",
      executableName,
    );

  const candidates = [
    env.CLAUDE_CODE_EXECUTABLE,
    env.APPDATA ? packageBin(join(env.APPDATA, "npm")) : undefined,
    ...(env.PATH ?? "")
      .split(separator)
      .map((entry) => entry.trim())
      .filter(Boolean)
      // `.../nodejs` holds the shims; `.../nodejs/node_modules/...` holds the
      // binary. Both spellings are cheap to test and each covers a real layout.
      .flatMap((entry) => [packageBin(entry), join(entry, executableName)]),
  ].filter((candidate): candidate is string => Boolean(candidate));

  return [...new Set(candidates)];
}

async function resolveClaudeExecutable(): Promise<string> {
  for (const candidate of claudeExecutableCandidates()) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next candidate; a stale NVM package is common on Windows.
    }
  }
  return "claude";
}

/** Subscription sign-in must not be shadowed by a stale local/gateway key. */
function claudeEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_BASE_URL;
  return env;
}

/** Is the CLI installed and authenticated enough to answer `--version`? */
export async function detectClaudeCode(
  force = false,
): Promise<ClaudeCodeAvailability> {
  if (!force && cachedAvailability) return cachedAvailability;
  try {
    const executable = await resolveClaudeExecutable();
    const { stdout } = await execFileAsync(executable, ["--version"], {
      timeout: 15_000,
      windowsHide: true,
      shell: false,
      env: claudeEnvironment(),
    });
    let loggedIn = false;
    let email: string | undefined;
    let subscriptionType: string | undefined;
    try {
      const { stdout: authOutput } = await execFileAsync(
        executable,
        ["auth", "status"],
        {
          timeout: 15_000,
          windowsHide: true,
          shell: false,
          env: claudeEnvironment(),
        },
      );
      const auth = JSON.parse(authOutput) as Record<string, unknown>;
      loggedIn = auth.loggedIn === true;
      email = typeof auth.email === "string" ? auth.email : undefined;
      subscriptionType =
        typeof auth.subscriptionType === "string"
          ? auth.subscriptionType
          : undefined;
    } catch {
      // An installed CLI with no account is still usable after the user signs in.
    }
    cachedAvailability = {
      available: true,
      version: stdout.trim(),
      executable: executable === "claude" ? undefined : executable,
      loggedIn,
      email,
      subscriptionType,
    };
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

/** Starts Claude Code's native subscription OAuth flow without exposing credentials to Orion. */
export async function beginClaudeCodeLogin(): Promise<{
  ok: boolean;
  error?: string;
}> {
  const executable = await resolveClaudeExecutable();
  try {
    if (process.platform === "win32") {
      // `cmd /k` deliberately keeps the terminal open so a user can read a real
      // CLI error or finish browser/device OAuth before returning to Orion.
      const child = spawn(
        process.env.ComSpec ?? "cmd.exe",
        ["/d", "/k", `"${executable}" auth login --claudeai`],
        {
          detached: true,
          stdio: "ignore",
          windowsHide: false,
          env: claudeEnvironment(),
        },
      );
      child.unref();
    } else {
      const child = spawn(executable, ["auth", "login", "--claudeai"], {
        detached: true,
        stdio: "ignore",
        env: claudeEnvironment(),
      });
      child.unref();
    }
    invalidateClaudeCodeCache();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
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
    contextUsedTokens: 0,
    contextWindowTokens: 0,
  };
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function toPercentage(value: unknown): number | null {
  const parsed = numberValue(value);
  if (parsed == null) return null;
  return parsed >= 0 && parsed <= 1 ? parsed * 100 : parsed;
}

function toEpochSeconds(value: unknown): number | null {
  const numeric = numberValue(value);
  if (numeric != null) return Math.floor(numeric);
  if (typeof value === "string") {
    const milliseconds = Date.parse(value);
    if (Number.isFinite(milliseconds)) return Math.floor(milliseconds / 1_000);
  }
  return null;
}

function quotaWindow(
  value: Record<string, unknown> | undefined,
): ClaudeQuotaWindow {
  return {
    usedPercentage: toPercentage(
      value?.percent ?? value?.utilization ?? value?.used_percentage,
    ),
    resetsAtEpochSeconds: toEpochSeconds(value?.resets_at ?? value?.resetsAt),
  };
}

function findAccessToken(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const token = findAccessToken(item);
      if (token) return token;
    }
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (
        (key === "accessToken" || key === "access_token") &&
        typeof child === "string"
      ) {
        return child;
      }
      const token = findAccessToken(child);
      if (token) return token;
    }
  }
  return undefined;
}

/**
 * Reads only the OAuth access token from Claude Code's own credential file in
 * the main process, then returns its quota response without ever exposing that
 * token to the renderer, logs, or a child-process argument.
 */
export async function fetchClaudeAccountUsage(): Promise<ClaudeAccountUsage> {
  const credentialsPath = path.join(
    os.homedir(),
    ".claude",
    ".credentials.json",
  );
  const credentials = JSON.parse(
    await fs.readFile(credentialsPath, "utf8"),
  ) as unknown;
  const token = findAccessToken(credentials);
  if (!token)
    throw new Error(
      "Claude Code OAuth credentials are unavailable. Sign in again first.",
    );

  const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": "orian-builder-desktop",
    },
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok)
    throw new Error(`Claude usage refresh failed (${response.status}).`);
  const payload = (await response.json()) as Record<string, unknown>;
  const limits = Array.isArray(payload.limits)
    ? payload.limits.filter(
        (item): item is Record<string, unknown> =>
          !!item && typeof item === "object",
      )
    : [];
  const findLimit = (kind: string) =>
    limits.find((limit) => limit.kind === kind);
  const modelScoped = limits
    .filter((limit) => limit.kind === "weekly_scoped")
    .map((limit) => {
      const scope = limit.scope as Record<string, unknown> | undefined;
      const model = scope?.model as Record<string, unknown> | undefined;
      const displayName =
        typeof model?.display_name === "string"
          ? model.display_name
          : undefined;
      return displayName ? { displayName, ...quotaWindow(limit) } : undefined;
    })
    .filter((quota): quota is ClaudeModelQuota => quota != null);

  return {
    fiveHour: quotaWindow(
      findLimit("session") ??
        (payload.five_hour as Record<string, unknown> | undefined),
    ),
    sevenDay: quotaWindow(
      findLimit("weekly_all") ??
        (payload.seven_day as Record<string, unknown> | undefined),
    ),
    modelScoped,
    fetchedAt: Date.now(),
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
      contextUsedTokens:
        Number(usageRaw.input_tokens ?? 0) +
          Number(usageRaw.output_tokens ?? 0) +
          Number(usageRaw.cache_read_input_tokens ?? 0) +
          Number(usageRaw.cache_creation_input_tokens ?? 0) || 0,
      contextWindowTokens: Math.max(
        0,
        ...Object.values(
          (raw.modelUsage as Record<string, unknown> | undefined) ?? {},
        ).map(
          (entry) =>
            numberValue((entry as Record<string, unknown>)?.contextWindow) ?? 0,
        ),
      ),
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
      contextUsedTokens: turn.contextUsedTokens,
      contextWindowTokens: turn.contextWindowTokens,
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
    // Orion is a headless agent host.  Its tool cards are observational; they
    // cannot answer the CLI's interactive permission prompt, so the supported
    // default is the CLI's unattended full-tool mode.
    options.permissionMode ?? "bypassPermissions",
  ];
  // Omit the flag for "Account default", just like the Claude Code terminal.
  // The clean environment above prevents API/gateway variables from diverting
  // that selection to a local provider.
  if (options.model) args.push("--model", options.model);
  if (options.effort) args.push("--effort", options.effort);
  if (resumeId) args.push("--resume", resumeId);
  if (options.appendSystemPrompt) {
    args.push("--append-system-prompt", options.appendSystemPrompt);
  }

  logger.info(
    `claude turn in ${projectDir}${resumeId ? ` (resume ${resumeId})` : ""}`,
  );

  const executable = await resolveClaudeExecutable();
  const child = spawn(executable, args, {
    cwd: projectDir,
    shell: false,
    env: claudeEnvironment(),
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
      // Claude's stream-json SDK accepts content blocks, not a bare string.
      // The previous shape was rejected before any event was emitted, which
      // left Orion's command surface apparently idle.
      message: {
        role: "user",
        content: [{ type: "text", text: options.prompt }],
      },
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
