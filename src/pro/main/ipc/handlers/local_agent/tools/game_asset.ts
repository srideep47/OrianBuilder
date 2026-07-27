import { z } from "zod";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import log from "electron-log";
import {
  ToolDefinition,
  AgentContext,
  escapeXmlAttr,
  escapeXmlContent,
} from "./types";
import { ORIANBUILDER_MEDIA_DIR_NAME } from "@/ipc/utils/media_path_utils";
import { getOrchestrator } from "@/main/ipc/utils/model_orchestrator";
import { ensureLlmSwapForMedia } from "@/main/ipc/utils/media_llm_guard";
import { initMediaDispatcher } from "@/main/ipc/utils/media_dispatcher";
import { generateImageViaLocalBackend } from "@/main/ipc/utils/local_image_generator";
import { generateAudioViaLocalBackend } from "@/main/ipc/utils/local_audio_generator";
import { backendThreeDGenerator } from "@/main/flow/pipeline_wiring";
import {
  findGodotProject,
  importAsset,
  type GodotAssetKind,
} from "@/main/godot/project";
import { runBlender } from "@/main/blender/run";
import { locateBlender } from "@/main/blender/locate";
import { readSettings } from "@/main/settings";
import { resolveSelection } from "@/shared/orion_media_catalog";

const logger = log.scope("game-asset");

/**
 * `generate_game_asset` — one tool that takes a game asset from a description to
 * a `res://` path inside the Godot project.
 *
 * This exists because the naive path is a nine-call sequence the model gets wrong
 * more often than it gets right: generate → find the output → convert format →
 * decimate → unwrap → normalise scale → fix origin → copy into the project's
 * asset folder → construct the `res://` path. Every one of those steps has a
 * failure mode that silently produces an asset that looks fine in the file
 * listing and is unusable in the engine.
 *
 * So the pipeline is encoded once, here, per asset kind:
 *
 *  - **model** — generate a reference image, reconstruct a mesh from it, then run
 *    the full Blender clean-up (convert → decimate → UVs → scale → origin) before
 *    import. Skipped steps are reported, never silently dropped.
 *  - **texture** — generate at a power-of-two size, because non-PoT textures cost
 *    memory and break mipmapping on some targets.
 *  - **music / sfx / voice** — route to the right model tier for the job rather
 *    than using one audio model for all three.
 *  - **video** — generated then imported as a playable `VideoStreamPlayer` source.
 *  - **ui** — generated as a texture with the transparency and framing a UI
 *    element needs, not a scene-like image.
 */

type AssetKind =
  | "model"
  | "texture"
  | "sprite"
  | "ui"
  | "music"
  | "sfx"
  | "voice"
  | "video";

/** Where each kind lands inside the Godot project. */
const KIND_TO_ASSET_DIR: Record<AssetKind, GodotAssetKind> = {
  model: "models",
  texture: "textures",
  sprite: "textures",
  ui: "ui",
  music: "music",
  sfx: "audio",
  voice: "voice",
  video: "video",
};

/**
 * What the agent should do with each kind once it's imported. Returned in the
 * tool result, because "the file is at res://..." is not actionable on its own —
 * a mesh needs a MeshInstance3D, a sound needs an AudioStreamPlayer, and getting
 * that pairing wrong is the single most common way a generated asset ends up in
 * the project but not in the game.
 */
const KIND_USAGE: Record<AssetKind, string> = {
  model:
    'Create a MeshInstance3D and set its "mesh" to this path, or for something the player collides with create a StaticBody3D with a MeshInstance3D child plus a CollisionShape3D.',
  texture:
    'Assign it to a StandardMaterial3D\'s "albedo_texture", or use blender_apply_material to bake it onto a mesh properly.',
  sprite:
    'Create a Sprite2D (or TextureRect for UI) and set its "texture" to this path.',
  ui: "Create a TextureRect and set its \"texture\", or use it as a Button's icon / a Panel's background.",
  music:
    'Create an AudioStreamPlayer, set "stream" to this path and "autoplay" to true. Set the stream resource\'s loop flag for background music.',
  sfx: 'Create an AudioStreamPlayer (or AudioStreamPlayer3D for positional sound), set "stream", and call play() from your game script at the right moment.',
  voice:
    'Create an AudioStreamPlayer, set "stream", and call play() when the line should be delivered.',
  video:
    'Create a VideoStreamPlayer and set "stream" to this path. Godot plays Ogg Theora natively; other containers need conversion first.',
};

function stamp(prefix: string, ext: string): string {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}${ext}`;
}

async function scratchDir(ctx: AgentContext, sub: string): Promise<string> {
  const dir = path.join(ctx.appPath, ORIANBUILDER_MEDIA_DIR_NAME, sub);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function tiers() {
  try {
    return resolveSelection(readSettings().orionMediaModels);
  } catch {
    return {} as Record<string, string | undefined>;
  }
}

/** Rounds to the nearest power of two within a sane range for game textures. */
function powerOfTwo(value: number): number {
  const clamped = Math.max(64, Math.min(4096, value));
  return 2 ** Math.round(Math.log2(clamped));
}

/** Generates an image through the orchestrator, falling back to the backend. */
async function generateImage(
  prompt: string,
  outputPath: string,
  options: Record<string, unknown>,
): Promise<{ success: boolean; error?: string }> {
  const orch = getOrchestrator();
  const llmLoaded = ensureLlmSwapForMedia();
  const tier = tiers().image;
  if (llmLoaded) {
    initMediaDispatcher();
    const res = await orch.runMediaGeneration({
      modelType: "image",
      prompt,
      outputPath,
      modelId: tier,
      options,
    });
    return { success: res.success, error: res.error };
  }
  const local = await generateImageViaLocalBackend(prompt, outputPath, {
    ...options,
    tier,
  } as never);
  return { success: local.success, error: local.error };
}

async function generateAudio(
  kind: "music" | "sfx" | "voice",
  prompt: string,
  outputPath: string,
  options: Record<string, unknown>,
): Promise<{ success: boolean; error?: string }> {
  const orch = getOrchestrator();
  const llmLoaded = ensureLlmSwapForMedia();
  const selected = tiers();
  // Music and sound effects come from a music model; a spoken line comes from a
  // TTS model. Using one for the other produces confidently wrong output —
  // narration from a music model is gibberish, and music from TTS is silence.
  const modelType = kind === "voice" ? "audio" : "music";
  const tier = kind === "voice" ? selected.speech : selected.music;
  if (llmLoaded) {
    initMediaDispatcher();
    const res = await orch.runMediaGeneration({
      modelType,
      prompt,
      outputPath,
      modelId: tier,
      options,
    });
    return { success: res.success, error: res.error };
  }
  if (kind === "voice") {
    const local = await generateAudioViaLocalBackend(prompt, outputPath, {
      tier,
      ...(options as { voice?: string }),
    });
    return { success: local.success, error: local.error };
  }
  return {
    success: false,
    error:
      "Music generation needs the media backend running with a model resident. Start it on the Engine page.",
  };
}

async function generateVideo(
  prompt: string,
  outputPath: string,
  options: Record<string, unknown>,
): Promise<{ success: boolean; error?: string }> {
  const orch = getOrchestrator();
  ensureLlmSwapForMedia();
  initMediaDispatcher();
  const res = await orch.runMediaGeneration({
    modelType: "video",
    prompt,
    outputPath,
    modelId: tiers().video,
    options,
  });
  return { success: res.success, error: res.error };
}

const schema = z.object({
  kind: z
    .enum([
      "model",
      "texture",
      "sprite",
      "ui",
      "music",
      "sfx",
      "voice",
      "video",
    ])
    .describe(
      "What to make. model = a 3D mesh. texture = a surface map. sprite = 2D art. ui = an interface element. music = a soundtrack loop. sfx = a short sound effect. voice = a spoken line. video = a clip.",
    ),
  prompt: z
    .string()
    .describe(
      "What it should be. For a model, describe the object plainly and in isolation ('a weathered wooden crate, single object, plain background') — reconstruction works from one clear view, not a scene. For voice, this is the exact words to speak.",
    ),
  name: z
    .string()
    .optional()
    .describe("Base filename, no extension. Defaults to a slug of the prompt."),
  // Model-specific
  target_size: z
    .number()
    .optional()
    .describe(
      "model only: real-world size in metres along the tallest axis. Character ~1.8, door ~2.1, crate ~1. Strongly recommended — an unnormalised mesh breaks physics and framing.",
    ),
  max_triangles: z
    .number()
    .optional()
    .describe(
      "model only: triangle budget. Props 2000, characters 15000, hero objects 40000. Default 20000.",
    ),
  // Texture-specific
  size: z
    .number()
    .optional()
    .describe(
      "texture/sprite/ui only: pixel size, rounded to a power of two. Default 1024.",
    ),
  tileable: z
    .boolean()
    .optional()
    .describe("texture only: ask for a seamlessly tiling result."),
  transparent: z
    .boolean()
    .optional()
    .describe("sprite/ui only: ask for a transparent background."),
  // Audio/video
  duration_seconds: z
    .number()
    .optional()
    .describe("music/sfx/video only: length in seconds."),
  voice: z.string().optional().describe("voice only: speaker identifier."),
  // Placement
  place_in_scene: z
    .string()
    .optional()
    .describe(
      "Optional live-engine parent node path (e.g. /root/Main/World). When set and Godot is running, the asset is also wired into the scene as the right node type for its kind.",
    ),
});

type Args = z.infer<typeof schema>;

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "asset"
  );
}

export const generateGameAssetTool: ToolDefinition<Args> = {
  name: "generate_game_asset",
  description: `Generate a game asset locally and import it into this app's Godot project, ready to use.

Handles the whole pipeline per kind, including the clean-up steps a raw generated asset always needs:

- **model** — generates a reference image, reconstructs a mesh, then converts to GLB, decimates to your triangle budget, unwraps UVs, normalises to a real-world size and moves the origin to the base. Without those a generated mesh imports untextur­able, at the wrong scale, and half-buried in the floor.
- **texture / sprite / ui** — generated at a power-of-two size, with tiling or transparency when asked.
- **music / sfx / voice** — routed to a music model or a speech model as appropriate, not one model for all three.
- **video** — generated and imported as a VideoStreamPlayer source.

Returns the res:// path plus exactly which node type to use it with. Pass place_in_scene to have it wired into the running scene for you.

Prefer blender_create_primitive for simple geometry (crates, platforms, pillars) — it is instant and exact where generation is slow and approximate.`,
  inputSchema: schema,
  defaultConsent: "always",
  modifiesState: true,

  getConsentPreview: (args) =>
    `Generate ${args.kind}: "${args.prompt.slice(0, 70)}${args.prompt.length > 70 ? "…" : ""}"`,

  buildXml: (args, isComplete) => {
    if (!args.prompt || isComplete) return undefined;
    return `<orianbuilder-game-asset kind="${escapeXmlAttr(args.kind ?? "asset")}" prompt="${escapeXmlAttr(args.prompt)}">`;
  },

  execute: async (args, ctx) => {
    const kind = args.kind as AssetKind;
    const base = args.name ? slug(args.name) : slug(args.prompt);
    const steps: string[] = [];

    const projectDir = await findGodotProject(ctx.appPath);
    if (!projectDir) {
      return "generate_game_asset FAILED: this app has no Godot project. Call godot_create_project first.";
    }

    ctx.onXmlStream(
      `<orianbuilder-game-asset kind="${escapeXmlAttr(kind)}" prompt="${escapeXmlAttr(args.prompt)}">`,
    );
    const finish = (detail: string) =>
      ctx.onXmlComplete(
        `<orianbuilder-game-asset kind="${escapeXmlAttr(kind)}" prompt="${escapeXmlAttr(args.prompt)}">${escapeXmlContent(detail)}</orianbuilder-game-asset>`,
      );

    try {
      let producedPath: string;

      // ── Generate ───────────────────────────────────────────────────────────
      if (kind === "model") {
        const dir = await scratchDir(ctx, "3d");
        const refImage = path.join(dir, stamp(`${base}-ref`, ".png"));

        ctx.emitProgress?.({
          id: "game_asset",
          label: "Generating reference image",
          step: 1,
          totalSteps: 4,
          status: "in-progress",
        });
        const img = await generateImage(
          // Reconstruction wants one object, evenly lit, on a plain background.
          // Left to its own devices the image model produces a scene, and the
          // mesh comes back as a fused blob of foreground and background.
          `${args.prompt}, single isolated object, centered, plain neutral background, even studio lighting, full object visible, product photo`,
          refImage,
          { width: 768, height: 768 },
        );
        if (!img.success) {
          finish("reference image failed");
          return `generate_game_asset FAILED at the reference-image step: ${img.error ?? "unknown error"}`;
        }
        steps.push(`reference image → ${path.basename(refImage)}`);

        ctx.emitProgress?.({
          id: "game_asset",
          label: "Reconstructing mesh",
          step: 2,
          totalSteps: 4,
          status: "in-progress",
        });
        const rawMesh = path.join(dir, stamp(`${base}-raw`, ".glb"));
        const mesh = await backendThreeDGenerator({
          refImagePath: refImage,
          outputPath: rawMesh,
          settings: { mesh_resolution: 256, foreground_ratio: 0.85 },
        } as never);
        if (!mesh.success) {
          finish("mesh reconstruction failed");
          return [
            `generate_game_asset FAILED at the mesh step: ${mesh.error ?? "unknown error"}`,
            "The 3D runtime may not be installed — the user can install it from the Create → Studio page.",
            `The reference image did generate, at ${path.relative(ctx.appPath, refImage)}, so you can retry the mesh alone or use it as a texture instead.`,
          ].join("\n");
        }
        steps.push(`mesh → ${path.basename(rawMesh)}`);

        // ── Blender clean-up ────────────────────────────────────────────────
        ctx.emitProgress?.({
          id: "game_asset",
          label: "Cleaning up mesh",
          step: 3,
          totalSteps: 4,
          status: "in-progress",
        });
        producedPath = rawMesh;
        const blender = await locateBlender();
        if (!blender) {
          steps.push(
            "clean-up SKIPPED — Blender is not installed, so the mesh keeps its raw triangle count, has no UV map, and is at an arbitrary scale with a centroid origin. Install Blender to get this automatically, or fix it by hand before relying on the asset.",
          );
        } else {
          const budget = args.max_triangles ?? 20_000;
          const inspected = await runBlender({
            op: "inspect",
            input: producedPath,
          });
          const polygons =
            (
              inspected.scene as
                | { objects?: Array<{ polygons?: number }> }
                | undefined
            )?.objects?.reduce((sum, o) => sum + (o.polygons ?? 0), 0) ?? 0;

          if (polygons > budget && polygons > 0) {
            const decimated = path.join(dir, stamp(`${base}-dec`, ".glb"));
            const res = await runBlender({
              op: "decimate",
              input: producedPath,
              output: decimated,
              ratio: Math.max(0.02, budget / polygons),
            });
            if (res.ok) {
              producedPath = decimated;
              steps.push(`decimated ${polygons} → ~${budget} triangles`);
            } else {
              steps.push(`decimate failed: ${res.error}`);
            }
          } else if (polygons > 0) {
            steps.push(`${polygons} triangles — already within budget`);
          }

          const unwrapped = path.join(dir, stamp(`${base}-uv`, ".glb"));
          const uvRes = await runBlender({
            op: "generate_uvs",
            input: producedPath,
            output: unwrapped,
          });
          if (uvRes.ok) {
            producedPath = unwrapped;
            steps.push("unwrapped UVs");
          } else {
            steps.push(`UV unwrap failed: ${uvRes.error}`);
          }

          if (args.target_size) {
            const scaled = path.join(dir, stamp(`${base}-scaled`, ".glb"));
            const scaleRes = await runBlender({
              op: "scale_to_size",
              input: producedPath,
              output: scaled,
              target_size: args.target_size,
              axis: "z",
            });
            if (scaleRes.ok) {
              producedPath = scaled;
              steps.push(`normalised to ${args.target_size} m tall`);
            } else {
              steps.push(`scale failed: ${scaleRes.error}`);
            }
          } else {
            steps.push(
              "scale NOT normalised — no target_size given. Pass one next time; an arbitrary-scale mesh breaks physics and camera framing.",
            );
          }

          const originFixed = path.join(dir, stamp(`${base}-final`, ".glb"));
          const originRes = await runBlender({
            op: "center_origin",
            input: producedPath,
            output: originFixed,
            mode: "bottom",
          });
          if (originRes.ok) {
            producedPath = originFixed;
            steps.push("origin moved to base");
          } else {
            steps.push(`origin fix failed: ${originRes.error}`);
          }
        }
      } else if (kind === "texture" || kind === "sprite" || kind === "ui") {
        const dir = await scratchDir(ctx, "textures");
        producedPath = path.join(dir, stamp(base, ".png"));
        const size = powerOfTwo(args.size ?? 1024);
        const modifiers: string[] = [];
        if (kind === "texture") {
          modifiers.push(
            "seamless tileable texture, flat orthographic view, no perspective, no shadows",
          );
          if (args.tileable === false) modifiers.pop();
        }
        if (args.transparent)
          modifiers.push("isolated on a transparent background, clean edges");
        if (kind === "ui")
          modifiers.push(
            "clean flat UI element, crisp edges, centered, no text",
          );
        if (kind === "sprite")
          modifiers.push("game sprite, side view, clean silhouette");

        ctx.emitProgress?.({
          id: "game_asset",
          label: `Generating ${size}×${size} ${kind}`,
          status: "in-progress",
        });
        const img = await generateImage(
          [args.prompt, ...modifiers].join(", "),
          producedPath,
          { width: size, height: size },
        );
        if (!img.success) {
          finish("generation failed");
          return `generate_game_asset FAILED: ${img.error ?? "unknown error"}`;
        }
        steps.push(`generated ${size}×${size}`);
      } else if (kind === "music" || kind === "sfx" || kind === "voice") {
        const dir = await scratchDir(ctx, "audio");
        producedPath = path.join(dir, stamp(base, ".wav"));
        const prompt =
          kind === "sfx"
            ? `${args.prompt}, short game sound effect, dry, no music`
            : kind === "music"
              ? `${args.prompt}, seamless loop, game background music`
              : args.prompt;
        ctx.emitProgress?.({
          id: "game_asset",
          label: `Generating ${kind}`,
          status: "in-progress",
        });
        const audio = await generateAudio(kind, prompt, producedPath, {
          ...(args.duration_seconds ? { duration: args.duration_seconds } : {}),
          ...(args.voice ? { voice: args.voice } : {}),
        });
        if (!audio.success) {
          finish("generation failed");
          return `generate_game_asset FAILED: ${audio.error ?? "unknown error"}`;
        }
        steps.push(`generated ${kind}`);
      } else {
        const dir = await scratchDir(ctx, "video");
        producedPath = path.join(dir, stamp(base, ".mp4"));
        ctx.emitProgress?.({
          id: "game_asset",
          label: "Generating video",
          status: "in-progress",
        });
        const video = await generateVideo(
          args.prompt,
          producedPath,
          args.duration_seconds ? { duration: args.duration_seconds } : {},
        );
        if (!video.success) {
          finish("generation failed");
          return `generate_game_asset FAILED: ${video.error ?? "unknown error"}`;
        }
        steps.push("generated video");
      }

      // ── Import into the project ────────────────────────────────────────────
      ctx.emitProgress?.({
        id: "game_asset",
        label: "Importing into the Godot project",
        step: 4,
        totalSteps: 4,
        status: "in-progress",
      });
      const imported = await importAsset({
        projectDir,
        sourcePath: producedPath,
        kind: KIND_TO_ASSET_DIR[kind],
        fileName: `${base}${path.extname(producedPath)}`,
      });
      steps.push(`imported → ${imported.resPath}`);
      ctx.emitProgress?.({
        id: "game_asset",
        label: `${kind} ready`,
        status: "completed",
      });

      // ── Optional scene placement ──────────────────────────────────────────
      let placement = "";
      if (args.place_in_scene) {
        placement = await placeInScene({
          kind,
          parent: args.place_in_scene,
          resPath: imported.resPath,
          name: base,
        });
        steps.push(placement);
      }

      finish(imported.resPath);
      logger.info(`Game asset ready: ${imported.resPath}`);

      return [
        `${kind} ready at ${imported.resPath}`,
        "",
        "Pipeline:",
        ...steps.map((s) => `  · ${s}`),
        "",
        `How to use it: ${KIND_USAGE[kind]}`,
        args.place_in_scene
          ? "Already placed in the running scene — call godot_screenshot to look at it, then godot_save_scene to persist."
          : "Godot imports it on next engine start. If the engine is already running, restart it or use godot_create_node with this path.",
      ].join("\n");
    } catch (err) {
      finish("failed");
      return `generate_game_asset FAILED: ${(err as Error).message}`;
    }
  },
};

/**
 * Wires an imported asset into the live scene as the correct node type.
 *
 * The mapping matters: a mesh set on a Sprite2D shows nothing, an AudioStream on
 * a MeshInstance3D shows nothing, and both fail silently. Encoding it here means
 * the agent can't get it wrong.
 */
async function placeInScene(params: {
  kind: AssetKind;
  parent: string;
  resPath: string;
  name: string;
}): Promise<string> {
  const { getGodotController } = await import("@/main/godot/process");
  const controller = getGodotController();
  if (!controller.isRunning()) {
    return "not placed — Godot is not running (launch it, then use godot_create_node)";
  }
  const client = controller.client();
  if (!client) return "not placed — no project bound to the engine";

  const plan: Record<AssetKind, { class: string; property: string }> = {
    model: { class: "MeshInstance3D", property: "mesh" },
    texture: { class: "Sprite2D", property: "texture" },
    sprite: { class: "Sprite2D", property: "texture" },
    ui: { class: "TextureRect", property: "texture" },
    music: { class: "AudioStreamPlayer", property: "stream" },
    sfx: { class: "AudioStreamPlayer", property: "stream" },
    voice: { class: "AudioStreamPlayer", property: "stream" },
    video: { class: "VideoStreamPlayer", property: "stream" },
  };
  const { class: nodeClass, property } = plan[params.kind];

  try {
    const created = await client.createNode({
      parent: params.parent,
      class: nodeClass,
      name: params.name,
      properties: { [property]: params.resPath },
    });
    if (created.ok !== true) {
      return `not placed — ${created.error}`;
    }
    return `placed as ${nodeClass} at ${created.path}`;
  } catch (err) {
    return `not placed — ${(err as Error).message}`;
  }
}
