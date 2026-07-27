import { z } from "zod";
import {
  defineContract,
  defineEvent,
  createClient,
  createEventClient,
} from "../contracts/core";

// =============================================================================
// Terminal
// =============================================================================

export const TerminalInfoSchema = z.object({
  id: z.string(),
  cwd: z.string(),
  shell: z.string(),
  cols: z.number(),
  rows: z.number(),
  exitCode: z.number().nullable(),
});
export type TerminalInfo = z.infer<typeof TerminalInfoSchema>;

export const terminalContracts = {
  create: defineContract({
    channel: "terminal:create",
    input: z.object({
      appId: z.number().optional(),
      /** Project-relative subdirectory to start in. */
      relativePath: z.string().optional(),
      cols: z.number().optional(),
      rows: z.number().optional(),
    }),
    output: TerminalInfoSchema,
  }),
  write: defineContract({
    channel: "terminal:write",
    input: z.object({ id: z.string(), data: z.string() }),
    output: z.object({ ok: z.boolean() }),
  }),
  resize: defineContract({
    channel: "terminal:resize",
    input: z.object({ id: z.string(), cols: z.number(), rows: z.number() }),
    output: z.object({ ok: z.boolean() }),
  }),
  kill: defineContract({
    channel: "terminal:kill",
    input: z.object({ id: z.string() }),
    output: z.object({ ok: z.boolean() }),
  }),
  list: defineContract({
    channel: "terminal:list",
    input: z.void(),
    output: z.array(TerminalInfoSchema),
  }),
  scrollback: defineContract({
    channel: "terminal:scrollback",
    input: z.object({ id: z.string() }),
    output: z.object({ data: z.string() }),
  }),
  cd: defineContract({
    channel: "terminal:cd",
    input: z.object({ id: z.string(), target: z.string() }),
    output: z.object({ ok: z.boolean() }),
  }),
} as const;

export const terminalClient = createClient(terminalContracts);

export const terminalEvents = {
  data: defineEvent({
    channel: "terminal:data",
    payload: z.object({ id: z.string(), data: z.string() }),
  }),
  exit: defineEvent({
    channel: "terminal:exit",
    payload: z.object({ id: z.string(), exitCode: z.number() }),
  }),
} as const;

export const terminalEventClient = createEventClient(terminalEvents);

// =============================================================================
// File operations
// =============================================================================

export const FileEntrySchema = z.object({
  name: z.string(),
  relativePath: z.string(),
  isDirectory: z.boolean(),
  sizeBytes: z.number(),
  modifiedMs: z.number(),
});
export type WorkspaceFileEntry = z.infer<typeof FileEntrySchema>;

export const EntryPropertiesSchema = z.object({
  name: z.string(),
  relativePath: z.string(),
  absolutePath: z.string(),
  isDirectory: z.boolean(),
  sizeBytes: z.number(),
  itemCount: z.number(),
  modifiedMs: z.number(),
  createdMs: z.number(),
});
export type WorkspaceEntryProperties = z.infer<typeof EntryPropertiesSchema>;

const appScoped = { appId: z.number() };

export const workspaceFilesContracts = {
  list: defineContract({
    channel: "workspace-files:list",
    input: z.object({ ...appScoped, relativePath: z.string().optional() }),
    output: z.array(FileEntrySchema),
  }),
  createFile: defineContract({
    channel: "workspace-files:create-file",
    input: z.object({
      ...appScoped,
      relativePath: z.string(),
      contents: z.string().optional(),
    }),
    output: z.object({ relativePath: z.string() }),
  }),
  createDirectory: defineContract({
    channel: "workspace-files:create-directory",
    input: z.object({ ...appScoped, relativePath: z.string() }),
    output: z.object({ relativePath: z.string() }),
  }),
  rename: defineContract({
    channel: "workspace-files:rename",
    input: z.object({
      ...appScoped,
      relativePath: z.string(),
      newName: z.string(),
    }),
    output: z.object({ relativePath: z.string() }),
  }),
  move: defineContract({
    channel: "workspace-files:move",
    input: z.object({
      ...appScoped,
      relativePath: z.string(),
      destinationDir: z.string(),
    }),
    output: z.object({ relativePath: z.string() }),
  }),
  copy: defineContract({
    channel: "workspace-files:copy",
    input: z.object({
      ...appScoped,
      relativePath: z.string(),
      destinationDir: z.string(),
    }),
    output: z.object({ relativePath: z.string() }),
  }),
  remove: defineContract({
    channel: "workspace-files:remove",
    input: z.object({ ...appScoped, relativePath: z.string() }),
    output: z.object({ ok: z.boolean() }),
  }),
  properties: defineContract({
    channel: "workspace-files:properties",
    input: z.object({ ...appScoped, relativePath: z.string() }),
    output: EntryPropertiesSchema,
  }),
  /** Opens the OS file manager at this entry. */
  revealInFolder: defineContract({
    channel: "workspace-files:reveal",
    input: z.object({ ...appScoped, relativePath: z.string() }),
    output: z.object({ ok: z.boolean() }),
  }),
} as const;

export const workspaceFilesClient = createClient(workspaceFilesContracts);
