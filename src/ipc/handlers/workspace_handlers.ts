import path from "node:path";
import { app as electronApp, shell } from "electron";
import log from "electron-log";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { apps } from "@/db/schema";
import { getOrianBuilderAppPath } from "@/paths/paths";
import { terminalContracts, workspaceFilesContracts } from "../types/workspace";
import { createTypedHandler } from "./base";
import {
  changeDirectory,
  createTerminal,
  killAllTerminals,
  killTerminal,
  listTerminals,
  resizeTerminal,
  resolveStartDir,
  terminalScrollback,
  writeTerminal,
} from "@/main/terminal/session";
import {
  copyEntry,
  createDirectory,
  createFile,
  deleteEntry,
  entryProperties,
  listDirectory,
  moveEntry,
  renameEntry,
} from "@/main/workspace/file_ops";

const logger = log.scope("workspace-handlers");

async function appPathFor(appId: number): Promise<string> {
  const row = await db.query.apps.findFirst({ where: eq(apps.id, appId) });
  if (!row) throw new Error(`No app with id ${appId}`);
  return getOrianBuilderAppPath(row.path);
}

export function registerWorkspaceHandlers(): void {
  // No shell should outlive the window that opened it.
  electronApp.on("will-quit", () => killAllTerminals());

  // ── Terminal ─────────────────────────────────────────────────────────────

  createTypedHandler(terminalContracts.create, async (_event, input) => {
    const cwd =
      input.appId != null
        ? resolveStartDir(await appPathFor(input.appId), input.relativePath)
        : undefined;
    return createTerminal({ cwd, cols: input.cols, rows: input.rows });
  });

  createTypedHandler(terminalContracts.write, async (_event, input) => ({
    ok: writeTerminal(input.id, input.data),
  }));

  createTypedHandler(terminalContracts.resize, async (_event, input) => ({
    ok: resizeTerminal(input.id, input.cols, input.rows),
  }));

  createTypedHandler(terminalContracts.kill, async (_event, input) => ({
    ok: killTerminal(input.id),
  }));

  createTypedHandler(terminalContracts.list, async () => listTerminals());

  createTypedHandler(terminalContracts.scrollback, async (_event, input) => ({
    data: terminalScrollback(input.id),
  }));

  createTypedHandler(terminalContracts.cd, async (_event, input) => ({
    ok: changeDirectory(input.id, input.target),
  }));

  // ── Files ────────────────────────────────────────────────────────────────

  createTypedHandler(workspaceFilesContracts.list, async (_event, input) =>
    listDirectory(await appPathFor(input.appId), input.relativePath ?? ""),
  );

  createTypedHandler(
    workspaceFilesContracts.createFile,
    async (_event, input) => ({
      relativePath: await createFile(
        await appPathFor(input.appId),
        input.relativePath,
        input.contents ?? "",
      ),
    }),
  );

  createTypedHandler(
    workspaceFilesContracts.createDirectory,
    async (_event, input) => ({
      relativePath: await createDirectory(
        await appPathFor(input.appId),
        input.relativePath,
      ),
    }),
  );

  createTypedHandler(workspaceFilesContracts.rename, async (_event, input) => ({
    relativePath: await renameEntry(
      await appPathFor(input.appId),
      input.relativePath,
      input.newName,
    ),
  }));

  createTypedHandler(workspaceFilesContracts.move, async (_event, input) => ({
    relativePath: await moveEntry(
      await appPathFor(input.appId),
      input.relativePath,
      input.destinationDir,
    ),
  }));

  createTypedHandler(workspaceFilesContracts.copy, async (_event, input) => ({
    relativePath: await copyEntry(
      await appPathFor(input.appId),
      input.relativePath,
      input.destinationDir,
    ),
  }));

  createTypedHandler(workspaceFilesContracts.remove, async (_event, input) => {
    await deleteEntry(await appPathFor(input.appId), input.relativePath);
    return { ok: true };
  });

  createTypedHandler(
    workspaceFilesContracts.properties,
    async (_event, input) =>
      entryProperties(await appPathFor(input.appId), input.relativePath),
  );

  createTypedHandler(
    workspaceFilesContracts.revealInFolder,
    async (_event, input) => {
      // Resolved through entryProperties rather than joined directly, so the
      // same containment check that guards deletes also guards what we hand to
      // the OS file manager.
      const props = await entryProperties(
        await appPathFor(input.appId),
        input.relativePath,
      );
      shell.showItemInFolder(props.absolutePath);
      logger.debug(`Revealed ${props.absolutePath}`);
      return { ok: true };
    },
  );
}

/** Re-exported so the preload bridge can whitelist the streaming channels. */
export const WORKSPACE_EVENT_CHANNELS = [
  "terminal:data",
  "terminal:exit",
] as const;

export { path };
