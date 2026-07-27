import fs from "node:fs/promises";
import path from "node:path";
import log from "electron-log";
import {
  ORION_BRIDGE_AUTOLOAD_NAME,
  ORION_BRIDGE_GD,
  ORION_BRIDGE_SCRIPT_PATH,
  ORION_BRIDGE_VERSION,
} from "./bridge_source";

const logger = log.scope("godot-project");

/** Where Godot's `user://` is pinned for an Orion-managed project. */
export const GODOT_USER_SUBDIR = path.join(".orion", "godot-user");
/** Generated assets land here so imports are predictable for the agent. */
export const GODOT_ASSET_DIRS = {
  models: "assets/models",
  textures: "assets/textures",
  audio: "assets/audio",
  music: "assets/music",
  voice: "assets/voice",
  video: "assets/video",
  ui: "assets/ui",
  animations: "assets/animations",
  materials: "assets/materials",
} as const;

export type GodotAssetKind = keyof typeof GODOT_ASSET_DIRS;

const BRIDGE_VERSION_FILE = path.join(".orion", "godot-bridge-version");

export interface GodotProjectInfo {
  /** Absolute path to the directory holding `project.godot`. */
  dir: string;
  name: string;
  /** `res://` path of the scene Godot boots. */
  mainScene: string | null;
  /** Renderer from `rendering/renderer/rendering_method`. */
  renderer: string | null;
  bridgeInstalled: boolean;
  bridgeVersion: number | null;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** True when `dir` (or a `godot/` child of it) holds a `project.godot`. */
export async function findGodotProject(appDir: string): Promise<string | null> {
  if (await exists(path.join(appDir, "project.godot"))) return appDir;
  for (const nested of ["godot", "game", "client"]) {
    const candidate = path.join(appDir, nested);
    if (await exists(path.join(candidate, "project.godot"))) return candidate;
  }
  return null;
}

/**
 * Reads the bits of `project.godot` we care about.
 *
 * Hand-parsed rather than pulled through an INI library: `project.godot` is
 * Godot's own dialect (bare `key=value` under `[section]`, values quoted only
 * sometimes, `config_version` at the top outside any section) and every INI
 * parser we could reach for mangles at least one of those.
 */
export async function readGodotProject(
  projectDir: string,
): Promise<GodotProjectInfo | null> {
  const file = path.join(projectDir, "project.godot");
  if (!(await exists(file))) return null;
  const text = await fs.readFile(file, "utf8");

  const pick = (key: string): string | null => {
    const match = text.match(
      new RegExp(
        `^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*(.+)$`,
        "m",
      ),
    );
    if (!match) return null;
    return match[1].trim().replace(/^"(.*)"$/, "$1");
  };

  let bridgeVersion: number | null = null;
  try {
    const raw = await fs.readFile(
      path.join(projectDir, BRIDGE_VERSION_FILE),
      "utf8",
    );
    const parsed = Number(raw.trim());
    bridgeVersion = Number.isFinite(parsed) ? parsed : null;
  } catch {
    bridgeVersion = null;
  }

  return {
    dir: projectDir,
    name: pick("config/name") ?? path.basename(projectDir),
    mainScene: pick("run/main_scene"),
    renderer: pick("rendering/renderer/rendering_method"),
    bridgeInstalled:
      bridgeVersion === ORION_BRIDGE_VERSION &&
      (await exists(path.join(projectDir, ORION_BRIDGE_SCRIPT_PATH))),
    bridgeVersion,
  };
}

/**
 * Writes the bridge script and registers it as an autoload.
 *
 * Idempotent, and re-runs itself whenever `ORION_BRIDGE_VERSION` moves, so an
 * updated bridge reaches existing projects without the user doing anything. The
 * autoload line is inserted rather than the whole file rewritten, because the
 * project file is the user's and may carry input maps, layers and renderer
 * choices we must not clobber.
 */
export async function installBridge(projectDir: string): Promise<void> {
  const scriptPath = path.join(projectDir, ORION_BRIDGE_SCRIPT_PATH);
  await fs.mkdir(path.dirname(scriptPath), { recursive: true });
  await fs.writeFile(scriptPath, ORION_BRIDGE_GD, "utf8");

  const projectFile = path.join(projectDir, "project.godot");
  let text = await fs.readFile(projectFile, "utf8");
  const autoloadLine = `${ORION_BRIDGE_AUTOLOAD_NAME}="*res://${ORION_BRIDGE_SCRIPT_PATH}"`;

  if (!text.includes(autoloadLine)) {
    // Strip any stale pointer at a previous location before adding the new one.
    text = text.replace(
      new RegExp(`^${ORION_BRIDGE_AUTOLOAD_NAME}=.*$\\n?`, "m"),
      "",
    );
    if (/^\[autoload\]$/m.test(text)) {
      text = text.replace(/^\[autoload\]$/m, `[autoload]\n\n${autoloadLine}`);
    } else {
      text = `${text.trimEnd()}\n\n[autoload]\n\n${autoloadLine}\n`;
    }
    await fs.writeFile(projectFile, text, "utf8");
  }

  await fs.mkdir(path.join(projectDir, ".orion"), { recursive: true });
  await fs.writeFile(
    path.join(projectDir, BRIDGE_VERSION_FILE),
    String(ORION_BRIDGE_VERSION),
    "utf8",
  );
  logger.info(
    `Installed Orion bridge v${ORION_BRIDGE_VERSION} in ${projectDir}`,
  );
}

/** Ensures the bridge is present and current. Returns true if it wrote anything. */
export async function ensureBridge(projectDir: string): Promise<boolean> {
  const info = await readGodotProject(projectDir);
  if (info?.bridgeInstalled) return false;
  await installBridge(projectDir);
  return true;
}

export type GodotTemplate = "3d" | "2d" | "ui";

/**
 * Creates a Godot project Orion can drive: a `project.godot` with the Forward+
 * renderer, a main scene appropriate to the template, the standard asset
 * folders, and the bridge already installed.
 *
 * The scene files are written as text rather than produced by launching the
 * editor, so project creation is instant and works headless — which matters
 * because the agent creates projects far more often than a human does.
 */
export async function createGodotProject(params: {
  dir: string;
  name: string;
  template?: GodotTemplate;
}): Promise<GodotProjectInfo> {
  const { dir, name, template = "3d" } = params;
  await fs.mkdir(dir, { recursive: true });

  for (const sub of Object.values(GODOT_ASSET_DIRS)) {
    await fs.mkdir(path.join(dir, sub), { recursive: true });
  }
  await fs.mkdir(path.join(dir, "scenes"), { recursive: true });
  await fs.mkdir(path.join(dir, "scripts"), { recursive: true });
  await fs.mkdir(path.join(dir, GODOT_USER_SUBDIR), { recursive: true });

  const mainScene = "res://scenes/main.tscn";
  await fs.writeFile(
    path.join(dir, "project.godot"),
    projectGodot({ name, mainScene, template }),
    "utf8",
  );
  await fs.writeFile(
    path.join(dir, "scenes", "main.tscn"),
    mainSceneFor(template),
    "utf8",
  );
  await fs.writeFile(
    path.join(dir, ".gitignore"),
    [
      "# Godot 4",
      ".godot/",
      "android/",
      "export_presets.cfg",
      "",
      "# Orion",
      ".orion/godot-user/",
      "",
    ].join("\n"),
    "utf8",
  );

  await installBridge(dir);
  const info = await readGodotProject(dir);
  if (!info)
    throw new Error("Project creation wrote no readable project.godot");
  return info;
}

function projectGodot(params: {
  name: string;
  mainScene: string;
  template: GodotTemplate;
}): string {
  const { name, mainScene, template } = params;
  // Mobile renderer for UI-only projects: no point paying for Forward+'s
  // clustered lighting when nothing is lit.
  const renderer = template === "3d" ? "forward_plus" : "mobile";
  return `; Engine configuration file.
; Generated by Orion Builder.

config_version=5

[application]

config/name="${name.replace(/"/g, '\\"')}"
run/main_scene="${mainScene}"
config/features=PackedStringArray("4.2", "GL Compatibility")

[display]

window/size/viewport_width=1280
window/size/viewport_height=720
window/stretch/mode="canvas_items"

[input]

move_left={
"deadzone": 0.5,
"events": [Object(InputEventKey,"resource_local_to_scene":false,"resource_name":"","device":-1,"window_id":0,"alt_pressed":false,"shift_pressed":false,"ctrl_pressed":false,"meta_pressed":false,"pressed":false,"keycode":0,"physical_keycode":65,"key_label":0,"unicode":0,"location":0,"echo":false,"script":null)
]
}
move_right={
"deadzone": 0.5,
"events": [Object(InputEventKey,"resource_local_to_scene":false,"resource_name":"","device":-1,"window_id":0,"alt_pressed":false,"shift_pressed":false,"ctrl_pressed":false,"meta_pressed":false,"pressed":false,"keycode":0,"physical_keycode":68,"key_label":0,"unicode":0,"location":0,"echo":false,"script":null)
]
}
move_forward={
"deadzone": 0.5,
"events": [Object(InputEventKey,"resource_local_to_scene":false,"resource_name":"","device":-1,"window_id":0,"alt_pressed":false,"shift_pressed":false,"ctrl_pressed":false,"meta_pressed":false,"pressed":false,"keycode":0,"physical_keycode":87,"key_label":0,"unicode":0,"location":0,"echo":false,"script":null)
]
}
move_back={
"deadzone": 0.5,
"events": [Object(InputEventKey,"resource_local_to_scene":false,"resource_name":"","device":-1,"window_id":0,"alt_pressed":false,"shift_pressed":false,"ctrl_pressed":false,"meta_pressed":false,"pressed":false,"keycode":0,"physical_keycode":83,"key_label":0,"unicode":0,"location":0,"echo":false,"script":null)
]
}
jump={
"deadzone": 0.5,
"events": [Object(InputEventKey,"resource_local_to_scene":false,"resource_name":"","device":-1,"window_id":0,"alt_pressed":false,"shift_pressed":false,"ctrl_pressed":false,"meta_pressed":false,"pressed":false,"keycode":0,"physical_keycode":32,"key_label":0,"unicode":0,"location":0,"echo":false,"script":null)
]
}
interact={
"deadzone": 0.5,
"events": [Object(InputEventKey,"resource_local_to_scene":false,"resource_name":"","device":-1,"window_id":0,"alt_pressed":false,"shift_pressed":false,"ctrl_pressed":false,"meta_pressed":false,"pressed":false,"keycode":0,"physical_keycode":69,"key_label":0,"unicode":0,"location":0,"echo":false,"script":null)
]
}

[rendering]

renderer/rendering_method="${renderer}"
`;
}

/**
 * Starter scenes. Each is a valid `.tscn` with a stable set of node names the
 * agent's system prompt can reference by path (`/root/Main/Camera3D`), so the
 * first tool call doesn't have to discover the tree from scratch.
 */
function mainSceneFor(template: GodotTemplate): string {
  if (template === "2d") {
    return `[gd_scene load_steps=1 format=3]

[node name="Main" type="Node2D"]

[node name="Camera2D" type="Camera2D" parent="."]
position = Vector2(640, 360)

[node name="World" type="Node2D" parent="."]

[node name="UI" type="CanvasLayer" parent="."]
`;
  }
  if (template === "ui") {
    return `[gd_scene load_steps=1 format=3]

[node name="Main" type="Control"]
layout_mode = 3
anchors_preset = 15
anchor_right = 1.0
anchor_bottom = 1.0

[node name="Root" type="VBoxContainer" parent="."]
layout_mode = 1
anchors_preset = 15
anchor_right = 1.0
anchor_bottom = 1.0
`;
  }
  return `[gd_scene load_steps=3 format=3]

[sub_resource type="Environment" id="Environment_1"]
background_mode = 1
ambient_light_source = 2
ambient_light_color = Color(0.72, 0.74, 0.85, 1)
ambient_light_energy = 0.6

[sub_resource type="PlaneMesh" id="PlaneMesh_1"]
size = Vector2(24, 24)

[node name="Main" type="Node3D"]

[node name="WorldEnvironment" type="WorldEnvironment" parent="."]
environment = SubResource("Environment_1")

[node name="DirectionalLight3D" type="DirectionalLight3D" parent="."]
transform = Transform3D(0.86, -0.32, 0.39, 0, 0.77, 0.63, -0.5, -0.55, 0.67, 0, 6, 0)
shadow_enabled = true

[node name="Camera3D" type="Camera3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 0.92, 0.39, 0, -0.39, 0.92, 0, 4, 9)

[node name="Ground" type="StaticBody3D" parent="."]

[node name="MeshInstance3D" type="MeshInstance3D" parent="Ground"]
mesh = SubResource("PlaneMesh_1")

[node name="World" type="Node3D" parent="."]

[node name="UI" type="CanvasLayer" parent="."]
`;
}

/**
 * Copies a generated asset into the project's asset folder for its kind and
 * returns the `res://` path.
 *
 * Godot imports on next engine start (or immediately, via the editor's
 * filesystem watcher), so nothing else is needed to make the file usable — but
 * the returned `res://` path is what the agent must use in scenes, and building
 * it by hand is the most common place a tool call goes wrong.
 */
export async function importAsset(params: {
  projectDir: string;
  sourcePath: string;
  kind: GodotAssetKind;
  fileName?: string;
}): Promise<{ resPath: string; absolutePath: string }> {
  const { projectDir, sourcePath, kind } = params;
  const targetDir = path.join(projectDir, GODOT_ASSET_DIRS[kind]);
  await fs.mkdir(targetDir, { recursive: true });

  const base = params.fileName ?? path.basename(sourcePath);
  // Never overwrite: a second "rock" texture must not silently replace the
  // first one that scenes already reference.
  let name = base;
  let counter = 1;
  while (await exists(path.join(targetDir, name))) {
    const ext = path.extname(base);
    name = `${path.basename(base, ext)}-${counter}${ext}`;
    counter += 1;
  }

  const absolutePath = path.join(targetDir, name);
  await fs.copyFile(sourcePath, absolutePath);
  return {
    absolutePath,
    resPath: `res://${GODOT_ASSET_DIRS[kind]}/${name}`.replace(/\\/g, "/"),
  };
}

/** Lists the project's imported assets, grouped by kind, for the UI. */
export async function listAssets(
  projectDir: string,
): Promise<Record<GodotAssetKind, string[]>> {
  const out = {} as Record<GodotAssetKind, string[]>;
  for (const [kind, sub] of Object.entries(GODOT_ASSET_DIRS)) {
    try {
      const entries = await fs.readdir(path.join(projectDir, sub), {
        withFileTypes: true,
      });
      out[kind as GodotAssetKind] = entries
        .filter((e) => e.isFile() && !e.name.endsWith(".import"))
        .map((e) => `res://${sub}/${e.name}`.replace(/\\/g, "/"));
    } catch {
      out[kind as GodotAssetKind] = [];
    }
  }
  return out;
}
