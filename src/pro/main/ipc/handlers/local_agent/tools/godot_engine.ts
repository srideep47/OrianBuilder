import { z } from "zod";
import log from "electron-log";
import path from "node:path";
import {
  ToolDefinition,
  AgentContext,
  escapeXmlAttr,
  escapeXmlContent,
} from "./types";
import { getGodotController } from "@/main/godot/process";
import { locateGodot, GODOT_DOWNLOAD_URL } from "@/main/godot/locate";
import {
  createGodotProject,
  findGodotProject,
  readGodotProject,
} from "@/main/godot/project";
import { checkProject, exportProject } from "@/main/godot/export";
import type { BridgeResponse } from "@/main/godot/bridge_client";

const logger = log.scope("godot-tools");

/**
 * The Godot tool family.
 *
 * Ported from OrionAndroid's `agent/GodotAgentTools.kt` and speaking the same
 * bridge protocol, so a prompt that works on the phone works here.
 *
 * Two design rules run through all of them:
 *
 *  1. **Failures come back as text, not exceptions.** A wrong node path or a
 *     bad property name is information the model needs in order to correct
 *     itself; throwing would abort the turn and lose it.
 *  2. **Every result names what to do next.** These tools are used in long
 *     chains (launch → inspect → mutate → screenshot → save), and the biggest
 *     source of wasted turns is the model not knowing which tool follows.
 */

// ── Shared helpers ──────────────────────────────────────────────────────────

/** Renders a bridge response for the model: compact JSON, errors made obvious. */
function render(action: string, res: BridgeResponse): string {
  if (res.ok === true) {
    const { ok: _ok, ...rest } = res;
    const body = JSON.stringify(rest, null, 2);
    return body === "{}" ? `${action}: ok` : `${action}: ok\n${body}`;
  }
  return `${action} FAILED: ${res.error ?? "unknown error"}`;
}

async function withBridge(
  action: string,
  fn: (
    client: NonNullable<
      ReturnType<ReturnType<typeof getGodotController>["client"]>
    >,
  ) => Promise<BridgeResponse>,
): Promise<string> {
  const controller = getGodotController();
  if (!controller.isRunning()) {
    return `${action} FAILED: Godot is not running. Call godot_launch first.`;
  }
  const client = controller.client();
  if (!client) {
    return `${action} FAILED: no project bound to the running engine.`;
  }
  try {
    return render(action, await fn(client));
  } catch (err) {
    return `${action} FAILED: ${(err as Error).message}`;
  }
}

/** Emits a compact tool card so the user can see engine activity in the chat. */
function card(ctx: AgentContext, label: string, detail?: string): void {
  ctx.onXmlComplete(
    `<orianbuilder-godot label="${escapeXmlAttr(label)}">${escapeXmlContent(detail ?? label)}</orianbuilder-godot>`,
  );
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

const launchSchema = z.object({
  mode: z
    .enum(["windowed", "headless"])
    .optional()
    .describe(
      "windowed shows the game so the user can watch and play it (default). headless runs with no window — still fully inspectable and screenshot-able, use it for automated build-and-verify loops.",
    ),
  create_if_missing: z
    .boolean()
    .optional()
    .describe(
      "If this app has no Godot project yet, scaffold one before launching. Default true.",
    ),
  template: z
    .enum(["3d", "2d", "ui"])
    .optional()
    .describe("Template used only when scaffolding. Default 3d."),
});

export const godotLaunchTool: ToolDefinition<z.infer<typeof launchSchema>> = {
  name: "godot_launch",
  description: `Start the Godot engine on this app's game project and wait until the Orion control bridge is answering.

Everything else in the godot_* family needs the engine running. Launching also installs/updates the control bridge into the project automatically.

### Modes
- **windowed** (default) — a real game window. Use when the user wants to see or play it.
- **headless** — no window. The bridge, the scene tree and godot_screenshot all still work, so you can build and visually verify a game without a window appearing. Prefer this while iterating.

### Next steps
godot_scene_tree to see what exists, godot_create_node / godot_set_property to build, godot_screenshot to check your work, godot_save_scene to persist it.`,
  inputSchema: launchSchema,
  defaultConsent: "always",
  modifiesState: true,

  getConsentPreview: (args) => `Launch Godot (${args.mode ?? "windowed"})`,

  execute: async (args, ctx) => {
    const install = await locateGodot();
    if (!install) {
      return `godot_launch FAILED: no Godot engine found on this machine. The user must install Godot 4 from ${GODOT_DOWNLOAD_URL} and point Orion at it on the Game page. Do not retry until they confirm.`;
    }
    if (!install.supported) {
      return `godot_launch FAILED: found ${install.version}, which is older than the supported 4.2 minimum.`;
    }

    let projectDir = await findGodotProject(ctx.appPath);
    if (!projectDir) {
      if (args.create_if_missing === false) {
        return `godot_launch FAILED: no project.godot under ${ctx.appPath}. Call godot_create_project first, or pass create_if_missing.`;
      }
      const created = await createGodotProject({
        dir: ctx.appPath,
        name: ctx.appName ?? path.basename(ctx.appPath),
        template: args.template ?? "3d",
      });
      projectDir = created.dir;
      logger.info(`Scaffolded Godot project at ${projectDir}`);
    }

    try {
      const status = await getGodotController().start({
        projectDir,
        mode: args.mode ?? "windowed",
      });
      card(ctx, "Godot running", `${status.projectName} · ${status.mode}`);
      if (!status.bridgeReady) {
        return [
          `Godot started (pid ${status.pid}) but the control bridge did not answer.`,
          status.error ?? "",
          "Engine output:",
          status.output.slice(-25).join("\n"),
        ]
          .filter(Boolean)
          .join("\n");
      }
      return [
        `Godot ${install.version} running on "${status.projectName}" in ${status.mode} mode. Control bridge ready.`,
        `Project: ${projectDir}`,
        "Call godot_scene_tree to see the live scene.",
      ].join("\n");
    } catch (err) {
      return `godot_launch FAILED: ${(err as Error).message}`;
    }
  },
};

export const godotStopTool: ToolDefinition<Record<string, never>> = {
  name: "godot_stop",
  description:
    "Stop the Godot engine. This is a real process kill — Godot cannot safely reinitialise in-process, so stopping is also how you switch projects or change mode. Idle cost after stopping is zero.",
  inputSchema: z.object({}),
  defaultConsent: "always",
  modifiesState: true,

  execute: async (_args, ctx) => {
    const status = await getGodotController().stop();
    card(ctx, "Godot stopped");
    return `Godot stopped. State: ${status.state}.`;
  },
};

export const godotStatusTool: ToolDefinition<Record<string, never>> = {
  name: "godot_status",
  description:
    "Check whether Godot is installed, whether it is running, which project it has open, and whether the control bridge is responding. Cheap — call it before assuming the engine state.",
  inputSchema: z.object({}),
  defaultConsent: "always",
  modifiesState: false,

  execute: async () => {
    const install = await locateGodot();
    const status = await getGodotController().reconcile();
    return JSON.stringify(
      {
        installed: install
          ? {
              version: install.version,
              path: install.executable,
              supported: install.supported,
            }
          : null,
        state: status.state,
        mode: status.mode,
        project: status.projectName,
        projectDir: status.projectDir,
        bridgeReady: status.bridgeReady,
        error: status.error,
      },
      null,
      2,
    );
  },
};

// ── Inspection ──────────────────────────────────────────────────────────────

const sceneTreeSchema = z.object({
  path: z
    .string()
    .optional()
    .describe(
      "Node to start from, e.g. /root/Main/World. Omit for the scene root.",
    ),
  depth: z
    .number()
    .optional()
    .describe(
      "How many levels to include. Default 8. Use a small value on huge scenes.",
    ),
});

export const godotSceneTreeTool: ToolDefinition<
  z.infer<typeof sceneTreeSchema>
> = {
  name: "godot_scene_tree",
  description:
    "Read the live scene tree: node names, classes, attached scripts, visibility and transforms. This is how you discover what exists before changing anything. Node paths from here are what every other godot_* tool takes.",
  inputSchema: sceneTreeSchema,
  defaultConsent: "always",
  modifiesState: false,
  execute: async (args) =>
    withBridge("godot_scene_tree", (c) =>
      c.sceneTree(args.path, args.depth ?? 8),
    ),
};

export const godotPerfTool: ToolDefinition<Record<string, never>> = {
  name: "godot_perf",
  description:
    "Snapshot live performance: FPS, frame and physics time, draw calls, primitives, node and object counts, video memory. Use it to verify a scene actually runs at a playable frame rate rather than assuming.",
  inputSchema: z.object({}),
  defaultConsent: "always",
  modifiesState: false,
  execute: async () => withBridge("godot_perf", (c) => c.perfSnapshot()),
};

const screenshotSchema = z.object({
  note: z
    .string()
    .optional()
    .describe(
      "Short label for what you expect to see — shown to the user with the image.",
    ),
});

export const godotScreenshotTool: ToolDefinition<
  z.infer<typeof screenshotSchema>
> = {
  name: "godot_screenshot",
  description: `Capture the running game's viewport as a PNG and attach it to the conversation so you can actually look at it.

This is the visual verification step. After building or changing a scene, screenshot it and check: is the camera pointed at the subject, is anything lit, are meshes intersecting the floor, is the UI on screen and readable. Works in headless mode too.`,
  inputSchema: screenshotSchema,
  defaultConsent: "always",
  modifiesState: false,

  execute: async (args, ctx) => {
    const controller = getGodotController();
    if (!controller.isRunning()) {
      return "godot_screenshot FAILED: Godot is not running. Call godot_launch first.";
    }
    const client = controller.client();
    if (!client) return "godot_screenshot FAILED: no project bound.";
    try {
      const res = await client.screenshot();
      if (res.ok !== true || typeof res.path !== "string") {
        return `godot_screenshot FAILED: ${res.error ?? "no image produced"}`;
      }
      // Attached as a follow-up user message: tool results can't carry images,
      // and the whole point of this tool is that the model sees the frame.
      ctx.appendUserMessage([
        {
          type: "text",
          text: `Godot viewport${args.note ? ` — ${args.note}` : ""} (${res.width}×${res.height}):`,
        },
        { type: "image-url", url: `file://${res.path}` },
      ]);
      card(ctx, "Viewport captured", args.note ?? `${res.width}×${res.height}`);
      return `Screenshot captured (${res.width}×${res.height}) and attached below. Look at it and judge whether the scene matches the intent before continuing.`;
    } catch (err) {
      return `godot_screenshot FAILED: ${(err as Error).message}`;
    }
  },
};

const nodePathSchema = z.object({
  path: z.string().describe("Node path, e.g. /root/Main/Player"),
});

export const godotListPropertiesTool: ToolDefinition<
  z.infer<typeof nodePathSchema>
> = {
  name: "godot_list_properties",
  description:
    "List a live node's editable properties with their current values and types. Call this before godot_set_property when you are unsure of the exact property name or the shape a value takes.",
  inputSchema: nodePathSchema,
  defaultConsent: "always",
  modifiesState: false,
  execute: async (args) =>
    withBridge("godot_list_properties", (c) => c.listProperties(args.path)),
};

export const godotListMethodsTool: ToolDefinition<
  z.infer<typeof nodePathSchema>
> = {
  name: "godot_list_methods",
  description:
    "List a live node's callable methods with argument names and types. Call this before godot_call_method.",
  inputSchema: nodePathSchema,
  defaultConsent: "always",
  modifiesState: false,
  execute: async (args) =>
    withBridge("godot_list_methods", (c) => c.listMethods(args.path)),
};

const classDbSchema = z.object({
  class: z
    .string()
    .optional()
    .describe("Class to describe, e.g. CharacterBody3D. Omit to list classes."),
  filter: z
    .string()
    .optional()
    .describe("Substring filter when listing, e.g. 'Body3D'."),
});

export const godotClassDbTool: ToolDefinition<z.infer<typeof classDbSchema>> = {
  name: "godot_classdb",
  description:
    "Query the engine's own class database: which classes exist, what a class inherits from, and its properties, methods and signals. Use it to pick the right node type instead of guessing — the engine is the authority on its own API, not your training data.",
  inputSchema: classDbSchema,
  defaultConsent: "always",
  modifiesState: false,
  execute: async (args) =>
    withBridge("godot_classdb", (c) =>
      c.classDb({ class: args.class, filter: args.filter }),
    ),
};

// ── Mutation ────────────────────────────────────────────────────────────────

const getPropertySchema = z.object({
  path: z.string().describe("Node path."),
  property: z.string().describe("Property name, e.g. position, visible, text."),
});

export const godotGetPropertyTool: ToolDefinition<
  z.infer<typeof getPropertySchema>
> = {
  name: "godot_get_property",
  description:
    "Read one property off a live node. Vectors and colours come back as objects ({x,y,z} / {r,g,b,a}).",
  inputSchema: getPropertySchema,
  defaultConsent: "always",
  modifiesState: false,
  execute: async (args) =>
    withBridge("godot_get_property", (c) =>
      c.getProperty(args.path, args.property),
    ),
};

const setPropertySchema = z.object({
  path: z.string().describe("Node path."),
  property: z.string().describe("Property name."),
  value: z
    .unknown()
    .describe(
      "New value. Vectors as {x,y,z}, colours as {r,g,b,a} or '#rrggbb', resources as a res:// path string, node references as a node path string. The bridge coerces to the property's actual type.",
    ),
});

export const godotSetPropertyTool: ToolDefinition<
  z.infer<typeof setPropertySchema>
> = {
  name: "godot_set_property",
  description:
    "Write one property on a live node — move it, resize it, recolour it, set its text, swap its mesh or texture. Takes effect immediately in the running game. Changes are in memory only until godot_save_scene.",
  inputSchema: setPropertySchema,
  defaultConsent: "always",
  modifiesState: true,
  getConsentPreview: (args) => `Set ${args.path}.${args.property}`,
  execute: async (args) =>
    withBridge("godot_set_property", (c) =>
      c.setProperty(args.path, args.property, args.value),
    ),
};

const callMethodSchema = z.object({
  path: z.string().describe("Node path."),
  method: z.string().describe("Method name."),
  args: z.array(z.unknown()).optional().describe("Positional arguments."),
});

export const godotCallMethodTool: ToolDefinition<
  z.infer<typeof callMethodSchema>
> = {
  name: "godot_call_method",
  description:
    "Call a method on a live node — play an animation, apply an impulse, emit a particle burst, trigger a state change. Use godot_list_methods first if you are unsure of the signature.",
  inputSchema: callMethodSchema,
  defaultConsent: "always",
  modifiesState: true,
  getConsentPreview: (args) => `Call ${args.path}.${args.method}()`,
  execute: async (args) =>
    withBridge("godot_call_method", (c) =>
      c.callMethod(args.path, args.method, args.args ?? []),
    ),
};

const createNodeSchema = z.object({
  parent: z.string().describe("Parent node path, e.g. /root/Main/World."),
  class: z
    .string()
    .describe(
      "Engine class to instantiate, e.g. MeshInstance3D, CharacterBody3D, Label.",
    ),
  name: z
    .string()
    .optional()
    .describe("Node name. Defaults to the class name."),
  properties: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Properties to set immediately after creation."),
});

export const godotCreateNodeTool: ToolDefinition<
  z.infer<typeof createNodeSchema>
> = {
  name: "godot_create_node",
  description: `Add a node to the live scene. The new node is given scene ownership, so it survives godot_save_scene.

To place a generated 3D asset, create a MeshInstance3D and set its "mesh" — or better, use generate_game_asset which imports the file and wires it up for you.`,
  inputSchema: createNodeSchema,
  defaultConsent: "always",
  modifiesState: true,
  getConsentPreview: (args) => `Create ${args.class} under ${args.parent}`,
  execute: async (args) =>
    withBridge("godot_create_node", (c) =>
      c.createNode({
        parent: args.parent,
        class: args.class,
        name: args.name,
        properties: args.properties,
      }),
    ),
};

export const godotDeleteNodeTool: ToolDefinition<
  z.infer<typeof nodePathSchema>
> = {
  name: "godot_delete_node",
  description:
    "Remove a node and its children from the live scene. Refuses to delete the scene root.",
  inputSchema: nodePathSchema,
  defaultConsent: "ask",
  modifiesState: true,
  getConsentPreview: (args) => `Delete node ${args.path}`,
  execute: async (args) =>
    withBridge("godot_delete_node", (c) => c.deleteNode(args.path)),
};

const reparentSchema = z.object({
  path: z.string().describe("Node to move."),
  parent: z.string().describe("New parent node path."),
  keep_transform: z
    .boolean()
    .optional()
    .describe("Preserve world transform. Default true."),
});

export const godotReparentNodeTool: ToolDefinition<
  z.infer<typeof reparentSchema>
> = {
  name: "godot_reparent_node",
  description:
    "Move a node to a different parent, keeping its world transform by default. Use it to group loose nodes under a container once a scene grows.",
  inputSchema: reparentSchema,
  defaultConsent: "always",
  modifiesState: true,
  execute: async (args) =>
    withBridge("godot_reparent_node", (c) =>
      c.reparentNode(args.path, args.parent, args.keep_transform ?? true),
    ),
};

// ── Runtime control ─────────────────────────────────────────────────────────

const pausedSchema = z.object({
  paused: z.boolean().describe("True to pause, false to resume."),
});

export const godotSetPausedTool: ToolDefinition<z.infer<typeof pausedSchema>> =
  {
    name: "godot_set_paused",
    description:
      "Pause or resume the running game. Pause before inspecting a moving scene so positions don't change under you, and before godot_step.",
    inputSchema: pausedSchema,
    defaultConsent: "always",
    modifiesState: true,
    execute: async (args) =>
      withBridge("godot_set_paused", (c) => c.setPaused(args.paused)),
  };

const stepSchema = z.object({
  frames: z.number().optional().describe("Frames to advance. Default 1."),
});

export const godotStepTool: ToolDefinition<z.infer<typeof stepSchema>> = {
  name: "godot_step",
  description:
    "Advance a paused game by N frames, then pause again. Use it to watch physics or an animation evolve one frame at a time — the only way to debug motion deterministically.",
  inputSchema: stepSchema,
  defaultConsent: "always",
  modifiesState: true,
  execute: async (args) =>
    withBridge("godot_step", (c) => c.step(args.frames ?? 1)),
};

const inputSchema = z.object({
  type: z
    .enum(["action", "key", "mouse_button", "mouse_motion"])
    .describe("Kind of input to synthesise."),
  action: z
    .string()
    .optional()
    .describe("InputMap action name, for type=action."),
  pressed: z.boolean().optional().describe("Press (true) or release (false)."),
  strength: z
    .number()
    .optional()
    .describe("Analog strength 0..1, for type=action."),
  keycode: z.number().optional().describe("Physical keycode, for type=key."),
  button: z
    .number()
    .optional()
    .describe("Mouse button index, for type=mouse_button."),
  position: z
    .object({ x: z.number(), y: z.number() })
    .optional()
    .describe("Screen position for mouse events."),
  relative: z
    .object({ x: z.number(), y: z.number() })
    .optional()
    .describe("Delta for mouse_motion."),
});

export const godotSimulateInputTool: ToolDefinition<
  z.infer<typeof inputSchema>
> = {
  name: "godot_simulate_input",
  description: `Feed synthetic input into the running game so you can actually play it and verify the result.

The real verification loop for gameplay: simulate_input(jump, pressed) → godot_step a few frames → godot_screenshot → check the character actually left the ground. Call godot_input_actions first to see which action names exist.`,
  inputSchema: inputSchema,
  defaultConsent: "always",
  modifiesState: true,
  execute: async (args) =>
    withBridge("godot_simulate_input", (c) =>
      c.simulateInput(args as unknown as Record<string, unknown>),
    ),
};

export const godotInputActionsTool: ToolDefinition<Record<string, never>> = {
  name: "godot_input_actions",
  description:
    "List every InputMap action defined in the project. Call before godot_simulate_input so you use real action names. Orion's scaffold defines move_left/right/forward/back, jump and interact.",
  inputSchema: z.object({}),
  defaultConsent: "always",
  modifiesState: false,
  execute: async () =>
    withBridge("godot_input_actions", (c) => c.inputActions()),
};

// ── Persistence ─────────────────────────────────────────────────────────────

const saveSceneSchema = z.object({
  path: z
    .string()
    .optional()
    .describe("res:// path to write. Omit to overwrite the scene's own file."),
});

export const godotSaveSceneTool: ToolDefinition<
  z.infer<typeof saveSceneSchema>
> = {
  name: "godot_save_scene",
  description: `Persist the live scene tree to disk.

Everything godot_create_node / godot_set_property does lives only in the running engine's memory. Without this, closing the engine loses all of it. Save after each coherent chunk of work, not just at the end.`,
  inputSchema: saveSceneSchema,
  defaultConsent: "always",
  modifiesState: true,
  execute: async (args) =>
    withBridge("godot_save_scene", (c) => c.saveScene(args.path)),
};

const changeSceneSchema = z.object({
  path: z.string().describe("res:// path of the scene to load."),
});

export const godotChangeSceneTool: ToolDefinition<
  z.infer<typeof changeSceneSchema>
> = {
  name: "godot_change_scene",
  description:
    "Load a different scene into the running game. Save the current one first if it has unsaved changes — this discards them.",
  inputSchema: changeSceneSchema,
  defaultConsent: "always",
  modifiesState: true,
  execute: async (args) =>
    withBridge("godot_change_scene", (c) => c.changeScene(args.path)),
};

const projectSettingSchema = z.object({
  key: z
    .string()
    .describe(
      "Setting path, e.g. application/run/main_scene, physics/3d/default_gravity.",
    ),
  value: z
    .unknown()
    .optional()
    .describe(
      "New value. Omit to read. Setting a value persists project.godot.",
    ),
});

export const godotProjectSettingTool: ToolDefinition<
  z.infer<typeof projectSettingSchema>
> = {
  name: "godot_project_setting",
  description:
    "Read or write one ProjectSettings value, persisted to project.godot. Use it to set the main scene, gravity, window size, rendering method or input map defaults.",
  inputSchema: projectSettingSchema,
  defaultConsent: "always",
  modifiesState: true,
  execute: async (args) =>
    withBridge("godot_project_setting", (c) =>
      args.value === undefined
        ? c.projectSetting(args.key)
        : c.projectSetting(args.key, args.value),
    ),
};

const reloadScriptSchema = z.object({
  script: z.string().describe("res:// path of the GDScript to reload."),
  path: z
    .string()
    .optional()
    .describe("Node to reattach the fresh script to, if any."),
});

export const godotReloadScriptTool: ToolDefinition<
  z.infer<typeof reloadScriptSchema>
> = {
  name: "godot_reload_script",
  description:
    "Re-read a GDScript from disk into the running engine after you edited it with write_file, optionally reattaching it to a node. Lets you iterate on gameplay code without restarting the engine.",
  inputSchema: reloadScriptSchema,
  defaultConsent: "always",
  modifiesState: true,
  execute: async (args) =>
    withBridge("godot_reload_script", (c) =>
      c.reloadScript(args.script, args.path),
    ),
};

// ── Project-level (no running engine needed) ─────────────────────────────────

const createProjectSchema = z.object({
  name: z
    .string()
    .optional()
    .describe("Project name. Defaults to the app name."),
  template: z
    .enum(["3d", "2d", "ui"])
    .optional()
    .describe(
      "3d gives a lit scene with a camera, ground plane, World and UI layers. 2d gives a Node2D world with a camera. ui gives a full-rect Control. Default 3d.",
    ),
  subdir: z
    .string()
    .optional()
    .describe(
      "Create inside this subdirectory of the app instead of at its root.",
    ),
});

export const godotCreateProjectTool: ToolDefinition<
  z.infer<typeof createProjectSchema>
> = {
  name: "godot_create_project",
  description: `Scaffold a Godot 4 project in this app: project.godot with a sane renderer and input map, a starter main scene, asset folders (models, textures, audio, music, voice, video, ui, animations, materials), and the Orion control bridge pre-installed.

The starter scene has stable node paths you can rely on immediately: /root/Main, /root/Main/Camera3D, /root/Main/World, /root/Main/UI.`,
  inputSchema: createProjectSchema,
  defaultConsent: "always",
  modifiesState: true,

  execute: async (args, ctx) => {
    const existing = await findGodotProject(ctx.appPath);
    if (existing && !args.subdir) {
      const info = await readGodotProject(existing);
      return `A Godot project already exists at ${existing} (name: ${info?.name}). Use it rather than creating another, or pass subdir to make a second one.`;
    }
    const dir = args.subdir ? path.join(ctx.appPath, args.subdir) : ctx.appPath;
    const info = await createGodotProject({
      dir,
      name: args.name ?? ctx.appName ?? path.basename(ctx.appPath),
      template: args.template ?? "3d",
    });
    card(ctx, "Godot project created", info.name);
    return [
      `Created Godot project "${info.name}" at ${info.dir}.`,
      `Main scene: ${info.mainScene}. Renderer: ${info.renderer}.`,
      "Control bridge installed. Call godot_launch to start it.",
    ].join("\n");
  },
};

export const godotCheckProjectTool: ToolDefinition<Record<string, never>> = {
  name: "godot_check_project",
  description: `Parse every script in the project with the engine's own parser, headless, without launching a game.

The cheapest gate on GDScript you just wrote — it catches syntax and load errors in seconds instead of after a 30-second engine start. Run it after editing scripts and before godot_launch.`,
  inputSchema: z.object({}),
  defaultConsent: "always",
  modifiesState: false,

  execute: async (_args, ctx) => {
    const projectDir = await findGodotProject(ctx.appPath);
    if (!projectDir) {
      return "godot_check_project FAILED: no Godot project in this app.";
    }
    const res = await checkProject(projectDir);
    return res.ok
      ? `Scripts parsed clean.\n${res.output.slice(-1500)}`
      : `godot_check_project FAILED — the engine reported script errors:\n${res.output.slice(-4000)}`;
  },
};

const exportSchema = z.object({
  target: z
    .enum(["windows", "linux", "macos", "web", "android"])
    .describe("Platform to export for."),
  debug: z
    .boolean()
    .optional()
    .describe("Export a debug build (keeps the console and the debugger)."),
});

export const godotExportTool: ToolDefinition<z.infer<typeof exportSchema>> = {
  name: "godot_export",
  description: `Export a real playable build using the engine's own headless export.

Requires Godot's export templates for the installed engine version. If they're missing the export produces no artifact and this tool says so — the fix is for the user to install them from the editor's Editor → Manage Export Templates.`,
  inputSchema: exportSchema,
  defaultConsent: "ask",
  modifiesState: true,
  getConsentPreview: (args) => `Export a ${args.target} build`,

  execute: async (args, ctx) => {
    const projectDir = await findGodotProject(ctx.appPath);
    if (!projectDir)
      return "godot_export FAILED: no Godot project in this app.";
    ctx.emitProgress?.({
      id: "godot_export",
      label: `Exporting ${args.target} build`,
      status: "in-progress",
    });
    const res = await exportProject({
      projectDir,
      target: args.target,
      debug: args.debug,
    });
    ctx.emitProgress?.({
      id: "godot_export",
      label: `Export ${args.target}`,
      status: res.ok ? "completed" : "failed",
    });
    if (!res.ok) {
      return `godot_export FAILED: ${res.error}\n\nEngine output:\n${res.log.slice(-3000)}`;
    }
    card(ctx, `Exported ${args.target}`, res.outputPath);
    return `Exported ${args.target} build to ${res.outputPath}`;
  },
};

/** Everything in the family, for registration. */
export const GODOT_TOOLS: readonly ToolDefinition[] = [
  godotStatusTool,
  godotCreateProjectTool,
  godotLaunchTool,
  godotStopTool,
  godotSceneTreeTool,
  godotPerfTool,
  godotScreenshotTool,
  godotListPropertiesTool,
  godotListMethodsTool,
  godotClassDbTool,
  godotGetPropertyTool,
  godotSetPropertyTool,
  godotCallMethodTool,
  godotCreateNodeTool,
  godotDeleteNodeTool,
  godotReparentNodeTool,
  godotSetPausedTool,
  godotStepTool,
  godotSimulateInputTool,
  godotInputActionsTool,
  godotSaveSceneTool,
  godotChangeSceneTool,
  godotProjectSettingTool,
  godotReloadScriptTool,
  godotCheckProjectTool,
  godotExportTool,
];
