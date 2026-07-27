import { z } from "zod";
import {
  defineContract,
  defineEvent,
  createClient,
  createEventClient,
} from "../contracts/core";

// =============================================================================
// Godot
// =============================================================================

export const GodotInstallSchema = z.object({
  executable: z.string(),
  version: z.string(),
  major: z.number(),
  minor: z.number(),
  patch: z.number(),
  mono: z.boolean(),
  source: z.enum(["setting", "path", "known-location", "managed"]),
  supported: z.boolean(),
});
export type GodotInstallInfo = z.infer<typeof GodotInstallSchema>;

export const GodotModeSchema = z.enum(["windowed", "headless", "editor"]);
export type GodotMode = z.infer<typeof GodotModeSchema>;

export const GodotStatusSchema = z.object({
  state: z.enum(["idle", "starting", "running", "stopping"]),
  mode: GodotModeSchema.nullable(),
  projectDir: z.string().nullable(),
  projectName: z.string().nullable(),
  bridgeReady: z.boolean(),
  pid: z.number().nullable(),
  install: GodotInstallSchema.nullable(),
  output: z.array(z.string()),
  error: z.string().nullable(),
  startedAt: z.number().nullable(),
});
export type GodotStatus = z.infer<typeof GodotStatusSchema>;

export const GodotProjectSchema = z.object({
  dir: z.string(),
  name: z.string(),
  mainScene: z.string().nullable(),
  renderer: z.string().nullable(),
  bridgeInstalled: z.boolean(),
  bridgeVersion: z.number().nullable(),
});
export type GodotProject = z.infer<typeof GodotProjectSchema>;

export const GodotAssetKindSchema = z.enum([
  "models",
  "textures",
  "audio",
  "music",
  "voice",
  "video",
  "ui",
  "animations",
  "materials",
]);
export type GodotAssetKind = z.infer<typeof GodotAssetKindSchema>;

export const GodotExportTargetSchema = z.enum([
  "windows",
  "linux",
  "macos",
  "web",
  "android",
]);
export type GodotExportTarget = z.infer<typeof GodotExportTargetSchema>;

/** Raw bridge response. Loose by design — ops return heterogeneous payloads and
 *  the renderer renders them generically (tree, inspector, perf readout). */
const BridgeResponseSchema = z.record(z.string(), z.unknown());

export const godotContracts = {
  locate: defineContract({
    channel: "godot:locate",
    input: z.object({ force: z.boolean().optional() }).optional(),
    output: GodotInstallSchema.nullable(),
  }),
  setExecutable: defineContract({
    channel: "godot:set-executable",
    input: z.object({ executable: z.string() }),
    output: GodotInstallSchema.nullable(),
  }),
  status: defineContract({
    channel: "godot:status",
    input: z.void(),
    output: GodotStatusSchema,
  }),
  start: defineContract({
    channel: "godot:start",
    input: z.object({
      appId: z.number().optional(),
      projectDir: z.string().optional(),
      mode: GodotModeSchema.optional(),
      args: z.array(z.string()).optional(),
    }),
    output: GodotStatusSchema,
  }),
  stop: defineContract({
    channel: "godot:stop",
    input: z.void(),
    output: GodotStatusSchema,
  }),
  /** One bridge op. The single entry point the inspector UI and tools share. */
  call: defineContract({
    channel: "godot:call",
    input: z.object({
      action: z.string(),
      params: z.record(z.string(), z.unknown()).optional(),
      timeoutMs: z.number().optional(),
    }),
    output: BridgeResponseSchema,
  }),
  /** Screenshot as a data URL, so the renderer can show a live viewport. */
  viewport: defineContract({
    channel: "godot:viewport",
    input: z.void(),
    output: z.object({
      ok: z.boolean(),
      dataUrl: z.string().nullable(),
      width: z.number().nullable(),
      height: z.number().nullable(),
      error: z.string().nullable(),
    }),
  }),
  findProject: defineContract({
    channel: "godot:find-project",
    input: z.object({ appId: z.number() }),
    output: GodotProjectSchema.nullable(),
  }),
  createProject: defineContract({
    channel: "godot:create-project",
    input: z.object({
      appId: z.number(),
      name: z.string().optional(),
      template: z.enum(["3d", "2d", "ui"]).optional(),
      /** Subdirectory inside the app. Defaults to the app root. */
      subdir: z.string().optional(),
    }),
    output: GodotProjectSchema,
  }),
  listAssets: defineContract({
    channel: "godot:list-assets",
    input: z.object({ projectDir: z.string() }),
    output: z.record(GodotAssetKindSchema, z.array(z.string())),
  }),
  importAsset: defineContract({
    channel: "godot:import-asset",
    input: z.object({
      projectDir: z.string(),
      sourcePath: z.string(),
      kind: GodotAssetKindSchema,
      fileName: z.string().optional(),
    }),
    output: z.object({ resPath: z.string(), absolutePath: z.string() }),
  }),
  checkProject: defineContract({
    channel: "godot:check-project",
    input: z.object({ projectDir: z.string() }),
    output: z.object({ ok: z.boolean(), output: z.string() }),
  }),
  exportProject: defineContract({
    channel: "godot:export-project",
    input: z.object({
      projectDir: z.string(),
      target: GodotExportTargetSchema,
      outputPath: z.string().optional(),
      debug: z.boolean().optional(),
    }),
    output: z.object({
      ok: z.boolean(),
      target: GodotExportTargetSchema,
      outputPath: z.string().optional(),
      log: z.string(),
      error: z.string().optional(),
    }),
  }),
} as const;

export const godotClient = createClient(godotContracts);

export const godotEvents = {
  statusChanged: defineEvent({
    channel: "godot:status-changed",
    payload: GodotStatusSchema,
  }),
} as const;

export const godotEventClient = createEventClient(godotEvents);

// =============================================================================
// Blender
// =============================================================================

export const BlenderInstallSchema = z.object({
  executable: z.string(),
  version: z.string(),
  major: z.number(),
  minor: z.number(),
  patch: z.number(),
  source: z.enum(["setting", "path", "known-location"]),
  supported: z.boolean(),
});
export type BlenderInstallInfo = z.infer<typeof BlenderInstallSchema>;

export const BlenderOpSchema = z.enum([
  "info",
  "import_model",
  "export_model",
  "convert",
  "inspect",
  "decimate",
  "smooth_shade",
  "generate_uvs",
  "apply_material",
  "bake_textures",
  "auto_rig",
  "add_animation",
  "retarget_animation",
  "create_primitive",
  "combine_meshes",
  "scale_to_size",
  "center_origin",
  "render_preview",
  "run_script",
]);
export type BlenderOpName = z.infer<typeof BlenderOpSchema>;

export const blenderContracts = {
  locate: defineContract({
    channel: "blender:locate",
    input: z.object({ force: z.boolean().optional() }).optional(),
    output: BlenderInstallSchema.nullable(),
  }),
  setExecutable: defineContract({
    channel: "blender:set-executable",
    input: z.object({ executable: z.string() }),
    output: BlenderInstallSchema,
  }),
  run: defineContract({
    channel: "blender:run",
    input: z.object({
      op: BlenderOpSchema,
      params: z.record(z.string(), z.unknown()).optional(),
      timeoutMs: z.number().optional(),
    }),
    output: z.record(z.string(), z.unknown()),
  }),
} as const;

export const blenderClient = createClient(blenderContracts);
