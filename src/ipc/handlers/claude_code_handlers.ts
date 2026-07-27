import { app as electronApp, BrowserWindow } from "electron";
import log from "electron-log";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { apps } from "@/db/schema";
import { getOrianBuilderAppPath } from "@/paths/paths";
import { claudeCodeContracts, claudeCodeEvents } from "../types/claude_code";
import { createTypedHandler } from "./base";
import {
  cancelTurn,
  detectClaudeCode,
  invalidateClaudeCodeCache,
  killAll,
  resetSession,
  runTurn,
  sessionUsage,
  storedSessionId,
  type ClaudeEvent,
} from "@/main/claudecode/runtime";

const logger = log.scope("claude-code-handlers");

/** Which project directory a turn runs in. */
async function resolveDir(input: {
  appId?: number;
  projectDir?: string;
}): Promise<string> {
  if (input.projectDir) return input.projectDir;
  if (input.appId == null) {
    throw new Error("Claude Code needs either an appId or a projectDir");
  }
  const row = await db.query.apps.findFirst({
    where: eq(apps.id, input.appId),
  });
  if (!row) throw new Error(`No app with id ${input.appId}`);
  return getOrianBuilderAppPath(row.path);
}

/** Directory per in-flight turn, so cancel and permission answers can find it. */
const activeTurns = new Map<string, string>();

function emit(turnId: string, event: ClaudeEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send(claudeCodeEvents.event.channel, { turnId, event });
  }
}

export function registerClaudeCodeHandlers(): void {
  electronApp.on("will-quit", () => killAll());

  createTypedHandler(claudeCodeContracts.detect, async (_event, input) => {
    if (input?.force) invalidateClaudeCodeCache();
    return detectClaudeCode(input?.force);
  });

  createTypedHandler(claudeCodeContracts.startTurn, async (_event, input) => {
    let projectDir: string;
    try {
      projectDir = await resolveDir(input);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    activeTurns.set(input.turnId, projectDir);

    // Fire-and-forget: the handler returns as soon as the turn is accepted and
    // the renderer follows the event stream. Awaiting the whole turn here would
    // block the IPC reply for however long Claude works — minutes, routinely.
    void (async () => {
      try {
        for await (const event of runTurn({
          projectDir,
          prompt: input.prompt,
          model: input.model,
          effort: input.effort,
          permissionMode: input.permissionMode,
          fresh: input.fresh,
          appendSystemPrompt: input.appendSystemPrompt,
        })) {
          emit(input.turnId, event);
        }
      } catch (err) {
        logger.error("Claude Code turn threw:", err);
        emit(input.turnId, {
          kind: "done",
          ok: false,
          error: (err as Error).message,
        });
      } finally {
        activeTurns.delete(input.turnId);
      }
    })();

    return { ok: true };
  });

  createTypedHandler(claudeCodeContracts.cancelTurn, async (_event, input) => {
    const dir = activeTurns.get(input.turnId);
    if (!dir) return { ok: false };
    return { ok: cancelTurn(dir) };
  });

  createTypedHandler(
    claudeCodeContracts.resetSession,
    async (_event, input) => {
      await resetSession(await resolveDir(input));
      return { ok: true };
    },
  );

  createTypedHandler(claudeCodeContracts.sessionInfo, async (_event, input) => {
    const dir = await resolveDir(input);
    return {
      sessionId: await storedSessionId(dir),
      usage: sessionUsage(dir),
    };
  });

  createTypedHandler(
    claudeCodeContracts.respondToPermission,
    async (_event, input) => {
      // Permission answers are only reachable in `default` mode, which requires
      // writing a control_response back on the CLI's stdin. The runtime closes
      // stdin after the prompt (one turn, one message), so `default` is not yet
      // wired end to end — the mode selector documents that and the other three
      // modes are the supported set. Denying is honest here: silently claiming
      // success would leave the user waiting on a turn that never resumes.
      logger.warn(
        `Permission response for ${input.requestId} ignored: interactive permission mode is not wired yet.`,
      );
      return { ok: false };
    },
  );
}
