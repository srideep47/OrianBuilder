import { z } from "zod";
import path from "node:path";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import {
  ToolDefinition,
  AgentContext,
  escapeXmlAttr,
  escapeXmlContent,
} from "./types";
import { locateBlender, BLENDER_DOWNLOAD_URL } from "@/main/blender/locate";
import { runBlender, type BlenderResult } from "@/main/blender/run";
import { ORIANBUILDER_MEDIA_DIR_NAME } from "@/ipc/utils/media_path_utils";

/**
 * The Blender tool family.
 *
 * Generative models produce meshes that are *nearly* unusable in a game engine:
 * arbitrary scale, no UVs, no rig, 100k+ triangles, origin at the centroid so
 * the model floats when you place it on a floor. Blender is the thing that fixes
 * all of that, and it can be driven entirely headless — so the same pipeline
 * works for a human clicking a button and an agent running unattended.
 *
 * Every tool here is one `blender --background` process. Paths in and paths out;
 * no shared state between calls.
 */

/** Where intermediate 3D work lands, inside the app so it's versioned with it. */
async function workDir(ctx: AgentContext): Promise<string> {
  const dir = path.join(ctx.appPath, ORIANBUILDER_MEDIA_DIR_NAME, "3d");
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function stamp(prefix: string, ext = ".glb"): string {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}${ext}`;
}

/** Resolves a project-relative or absolute path against the app. */
function resolveIn(ctx: AgentContext, p: string): string {
  return path.isAbsolute(p) ? p : path.join(ctx.appPath, p);
}

/** Renders a path back to the model as app-relative — what write_file etc. take. */
function rel(ctx: AgentContext, p: string): string {
  return path.relative(ctx.appPath, p).split(path.sep).join("/");
}

function card(ctx: AgentContext, label: string, detail: string): void {
  ctx.onXmlComplete(
    `<orianbuilder-blender label="${escapeXmlAttr(label)}">${escapeXmlContent(detail)}</orianbuilder-blender>`,
  );
}

/** Formats a harness result for the model, keeping the scene summary compact. */
function report(op: string, res: BlenderResult, ctx: AgentContext): string {
  if (res.ok !== true) {
    const detail = [res.error, res.traceback].filter(Boolean).join("\n");
    return `${op} FAILED: ${detail}\n\nBlender output (tail):\n${String(res.log ?? "").slice(-2500)}`;
  }
  const lines: string[] = [`${op}: ok`];
  if (typeof res.output === "string") {
    lines.push(`Output: ${rel(ctx, res.output)}`);
  }
  if (typeof res.output_image === "string") {
    lines.push(`Image: ${rel(ctx, res.output_image)}`);
  }
  const scene = res.scene as
    | {
        objects?: Array<{
          name: string;
          type: string;
          polygons?: number;
          dimensions?: number[];
          uv_layers?: string[];
        }>;
        actions?: string[];
      }
    | undefined;
  if (scene?.objects?.length) {
    lines.push("Objects:");
    for (const o of scene.objects.slice(0, 20)) {
      const bits = [o.type];
      if (o.polygons != null) bits.push(`${o.polygons} tris`);
      if (o.dimensions) {
        bits.push(`${o.dimensions.map((d) => d.toFixed(2)).join(" × ")} units`);
      }
      if (o.uv_layers) bits.push(o.uv_layers.length ? "has UVs" : "NO UVs");
      lines.push(`  ${o.name} (${bits.join(", ")})`);
    }
  }
  if (scene?.actions?.length) {
    lines.push(`Actions: ${scene.actions.join(", ")}`);
  }
  for (const key of [
    "armature",
    "bones",
    "action",
    "matched_curves",
    "ratio",
    "material",
  ]) {
    if (res[key] !== undefined) {
      lines.push(`${key}: ${JSON.stringify(res[key])}`);
    }
  }
  return lines.join("\n");
}

async function requireBlender(): Promise<string | null> {
  const install = await locateBlender();
  if (!install) {
    return `Blender is not installed on this machine. The user must install it from ${BLENDER_DOWNLOAD_URL} and can point Orion at it on the Game page. Do not retry until they confirm.`;
  }
  if (!install.supported) {
    return `Found ${install.version}, older than the supported 3.3 minimum.`;
  }
  return null;
}

// ── Inspect ─────────────────────────────────────────────────────────────────

const inspectSchema = z.object({
  input: z
    .string()
    .describe("Path to a .glb/.gltf/.fbx/.obj/.blend/.stl/.ply model."),
});

export const blenderInspectTool: ToolDefinition<z.infer<typeof inspectSchema>> =
  {
    name: "blender_inspect",
    description: `Report what is actually inside a 3D model: object names and types, triangle counts, real-world dimensions, whether it has UVs, its materials and any animation actions.

Call this first on any generated or downloaded mesh. It tells you which of the fix-up tools you need — a 180k-triangle mesh with no UVs and a 40-unit height needs decimate, generate_uvs and scale_to_size before it belongs in a game.`,
    inputSchema: inspectSchema,
    defaultConsent: "always",
    modifiesState: false,

    execute: async (args, ctx) => {
      const missing = await requireBlender();
      if (missing) return `blender_inspect FAILED: ${missing}`;
      const res = await runBlender({
        op: "inspect",
        input: resolveIn(ctx, args.input),
      });
      return report("blender_inspect", res, ctx);
    },
  };

// ── Convert / cleanup ───────────────────────────────────────────────────────

const convertSchema = z.object({
  input: z.string().describe("Source model path."),
  format: z
    .enum(["glb", "gltf", "fbx", "obj", "blend"])
    .optional()
    .describe("Target format. Default glb — the format Godot imports best."),
});

export const blenderConvertTool: ToolDefinition<z.infer<typeof convertSchema>> =
  {
    name: "blender_convert",
    description:
      "Convert a model between formats. Default target is GLB, which is what Godot imports with materials, skins and animations intact — always convert FBX/OBJ to GLB before importing into a Godot project.",
    inputSchema: convertSchema,
    defaultConsent: "always",
    modifiesState: true,

    execute: async (args, ctx) => {
      const missing = await requireBlender();
      if (missing) return `blender_convert FAILED: ${missing}`;
      const dir = await workDir(ctx);
      const ext = `.${args.format ?? "glb"}`;
      const output = path.join(dir, stamp("converted", ext));
      const res = await runBlender({
        op: "convert",
        input: resolveIn(ctx, args.input),
        output,
      });
      if (res.ok) card(ctx, "Converted model", rel(ctx, output));
      return report("blender_convert", res, ctx);
    },
  };

const decimateSchema = z.object({
  input: z.string().describe("Source model path."),
  ratio: z
    .number()
    .optional()
    .describe(
      "Fraction of triangles to keep, 0.01–1.0. 0.5 halves the count. Default 0.5.",
    ),
});

export const blenderDecimateTool: ToolDefinition<
  z.infer<typeof decimateSchema>
> = {
  name: "blender_decimate",
  description: `Reduce a mesh's triangle count while preserving its shape.

AI-generated meshes routinely arrive at 100k–500k triangles, which will not hold frame rate with more than a couple on screen. Aim for roughly: props 1k–5k, characters 8k–20k, hero objects 30k. blender_inspect tells you the current count.`,
  inputSchema: decimateSchema,
  defaultConsent: "always",
  modifiesState: true,

  execute: async (args, ctx) => {
    const missing = await requireBlender();
    if (missing) return `blender_decimate FAILED: ${missing}`;
    const dir = await workDir(ctx);
    const output = path.join(dir, stamp("decimated"));
    const res = await runBlender({
      op: "decimate",
      input: resolveIn(ctx, args.input),
      output,
      ratio: args.ratio ?? 0.5,
    });
    if (res.ok) card(ctx, "Decimated mesh", rel(ctx, output));
    return report("blender_decimate", res, ctx);
  },
};

const uvSchema = z.object({
  input: z.string().describe("Source model path."),
  angle_limit: z
    .number()
    .optional()
    .describe("Smart-project angle limit in degrees. Default 66."),
  island_margin: z
    .number()
    .optional()
    .describe("Margin between UV islands. Default 0.02."),
});

export const blenderGenerateUvsTool: ToolDefinition<z.infer<typeof uvSchema>> =
  {
    name: "blender_generate_uvs",
    description: `Unwrap a mesh so textures can be applied to it.

Generated meshes usually have no UV map at all, and without one *no texture will show* — the surface renders as flat colour no matter what image you assign. If blender_inspect says "NO UVs", run this before applying any material.`,
    inputSchema: uvSchema,
    defaultConsent: "always",
    modifiesState: true,

    execute: async (args, ctx) => {
      const missing = await requireBlender();
      if (missing) return `blender_generate_uvs FAILED: ${missing}`;
      const dir = await workDir(ctx);
      const output = path.join(dir, stamp("unwrapped"));
      const res = await runBlender({
        op: "generate_uvs",
        input: resolveIn(ctx, args.input),
        output,
        angle_limit: args.angle_limit ?? 66,
        island_margin: args.island_margin ?? 0.02,
      });
      if (res.ok) card(ctx, "Generated UVs", rel(ctx, output));
      return report("blender_generate_uvs", res, ctx);
    },
  };

const scaleSchema = z.object({
  input: z.string().describe("Source model path."),
  target_size: z
    .number()
    .describe(
      "Desired size in Godot units (metres) along the chosen axis. A human character is ~1.8, a door ~2.1, a crate ~1.0.",
    ),
  axis: z
    .enum(["x", "y", "z"])
    .optional()
    .describe("Axis to measure. Default z (height)."),
});

export const blenderScaleTool: ToolDefinition<z.infer<typeof scaleSchema>> = {
  name: "blender_scale_to_size",
  description: `Normalise a model to a real-world size, baking the scale into the mesh.

Generated meshes come out at arbitrary scale. A character that imports 40 units tall breaks physics, camera framing and every movement-speed constant in the game, and fixing it by scaling the node instead of the mesh makes child colliders wrong. Always normalise before importing.`,
  inputSchema: scaleSchema,
  defaultConsent: "always",
  modifiesState: true,

  execute: async (args, ctx) => {
    const missing = await requireBlender();
    if (missing) return `blender_scale_to_size FAILED: ${missing}`;
    const dir = await workDir(ctx);
    const output = path.join(dir, stamp("scaled"));
    const res = await runBlender({
      op: "scale_to_size",
      input: resolveIn(ctx, args.input),
      output,
      target_size: args.target_size,
      axis: args.axis ?? "z",
    });
    if (res.ok) card(ctx, "Normalised scale", rel(ctx, output));
    return report("blender_scale_to_size", res, ctx);
  },
};

const originSchema = z.object({
  input: z.string().describe("Source model path."),
  mode: z
    .enum(["bottom", "center"])
    .optional()
    .describe(
      "Where to put the origin. Default bottom — right for anything standing on ground.",
    ),
});

export const blenderCenterOriginTool: ToolDefinition<
  z.infer<typeof originSchema>
> = {
  name: "blender_center_origin",
  description:
    "Move a model's origin to the bottom-centre (or centre) of its bounds. Godot positions nodes by origin, so a mesh whose origin is at its centroid sits half-buried when you place it at floor level.",
  inputSchema: originSchema,
  defaultConsent: "always",
  modifiesState: true,

  execute: async (args, ctx) => {
    const missing = await requireBlender();
    if (missing) return `blender_center_origin FAILED: ${missing}`;
    const dir = await workDir(ctx);
    const output = path.join(dir, stamp("origin"));
    const res = await runBlender({
      op: "center_origin",
      input: resolveIn(ctx, args.input),
      output,
      mode: args.mode ?? "bottom",
    });
    if (res.ok) card(ctx, "Origin fixed", rel(ctx, output));
    return report("blender_center_origin", res, ctx);
  },
};

const smoothSchema = z.object({
  input: z.string().describe("Source model path."),
  angle_degrees: z
    .number()
    .optional()
    .describe("Auto-smooth angle. Default 30."),
});

export const blenderSmoothTool: ToolDefinition<z.infer<typeof smoothSchema>> = {
  name: "blender_smooth_shade",
  description:
    "Apply smooth shading with an auto-smooth angle so a mesh stops looking faceted while keeping its hard edges. Cheap visual win on any generated organic shape.",
  inputSchema: smoothSchema,
  defaultConsent: "always",
  modifiesState: true,

  execute: async (args, ctx) => {
    const missing = await requireBlender();
    if (missing) return `blender_smooth_shade FAILED: ${missing}`;
    const dir = await workDir(ctx);
    const output = path.join(dir, stamp("smoothed"));
    const res = await runBlender({
      op: "smooth_shade",
      input: resolveIn(ctx, args.input),
      output,
      angle_degrees: args.angle_degrees ?? 30,
    });
    return report("blender_smooth_shade", res, ctx);
  },
};

// ── Materials ───────────────────────────────────────────────────────────────

const materialSchema = z.object({
  input: z.string().describe("Source model path."),
  material_name: z
    .string()
    .optional()
    .describe("Material name. Default OrionMaterial."),
  base_color: z
    .string()
    .optional()
    .describe("Path to a base-colour/albedo texture."),
  normal: z.string().optional().describe("Path to a normal map."),
  roughness: z.string().optional().describe("Path to a roughness map."),
  metallic: z.string().optional().describe("Path to a metallic map."),
  base_color_rgba: z
    .array(z.number())
    .optional()
    .describe(
      "Flat colour [r,g,b] or [r,g,b,a] in 0..1, used when no texture is given.",
    ),
});

export const blenderApplyMaterialTool: ToolDefinition<
  z.infer<typeof materialSchema>
> = {
  name: "blender_apply_material",
  description: `Build a physically-based material from generated texture maps and assign it to a mesh.

Pair with generate_image: generate an albedo texture, generate a normal map, then wire both here. The mesh must have UVs first — run blender_generate_uvs if blender_inspect reports none, or the textures will not appear.`,
  inputSchema: materialSchema,
  defaultConsent: "always",
  modifiesState: true,

  execute: async (args, ctx) => {
    const missing = await requireBlender();
    if (missing) return `blender_apply_material FAILED: ${missing}`;
    const dir = await workDir(ctx);
    const output = path.join(dir, stamp("textured"));
    const maps: Record<string, string> = {};
    if (args.base_color) maps.base_color = resolveIn(ctx, args.base_color);
    if (args.normal) maps.normal = resolveIn(ctx, args.normal);
    if (args.roughness) maps.roughness = resolveIn(ctx, args.roughness);
    if (args.metallic) maps.metallic = resolveIn(ctx, args.metallic);

    const res = await runBlender({
      op: "apply_material",
      input: resolveIn(ctx, args.input),
      output,
      material_name: args.material_name ?? "OrionMaterial",
      maps,
      ...(args.base_color_rgba
        ? { base_color_rgba: args.base_color_rgba }
        : {}),
    });
    if (res.ok) card(ctx, "Material applied", rel(ctx, output));
    return report("blender_apply_material", res, ctx);
  },
};

const bakeSchema = z.object({
  input: z.string().describe("Source model path."),
  size: z.number().optional().describe("Texture resolution. Default 1024."),
  bake_type: z
    .enum(["DIFFUSE", "NORMAL", "ROUGHNESS", "AO", "COMBINED"])
    .optional()
    .describe("What to bake. Default DIFFUSE."),
  samples: z.number().optional().describe("Cycles samples. Default 32."),
});

export const blenderBakeTool: ToolDefinition<z.infer<typeof bakeSchema>> = {
  name: "blender_bake_textures",
  description: `Bake a mesh's material into a flat image texture.

Needed whenever a model carries procedural shader nodes: Godot cannot evaluate Blender shader graphs, so anything not baked to an image is simply lost on import. Also the way to bake ambient occlusion or a normal map from high-poly detail.`,
  inputSchema: bakeSchema,
  defaultConsent: "always",
  modifiesState: true,

  execute: async (args, ctx) => {
    const missing = await requireBlender();
    if (missing) return `blender_bake_textures FAILED: ${missing}`;
    const dir = await workDir(ctx);
    const outputImage = path.join(dir, stamp("baked", ".png"));
    const output = path.join(dir, stamp("baked"));
    const res = await runBlender(
      {
        op: "bake_textures",
        input: resolveIn(ctx, args.input),
        output,
        output_image: outputImage,
        size: args.size ?? 1024,
        bake_type: args.bake_type ?? "DIFFUSE",
        samples: args.samples ?? 32,
      },
      { timeoutMs: 20 * 60_000 },
    );
    if (res.ok) card(ctx, "Baked texture", rel(ctx, outputImage));
    return report("blender_bake_textures", res, ctx);
  },
};

// ── Rigging and animation ───────────────────────────────────────────────────

const rigSchema = z.object({
  input: z
    .string()
    .describe(
      "Path to a humanoid mesh, ideally already scaled and origin-fixed.",
    ),
});

export const blenderAutoRigTool: ToolDefinition<z.infer<typeof rigSchema>> = {
  name: "blender_auto_rig",
  description: `Fit a humanoid skeleton to a mesh and bind it with automatic weights, so it can be animated.

Produces a clean 19-bone hierarchy (Hips, Spine, Chest, Neck, Head, per-side Shoulder/UpperArm/LowerArm/Hand and UpperLeg/LowerLeg/Foot) with standard human proportions derived from the mesh's own height — deliberately not a Rigify control rig, because Rigify's control bones don't export usefully to glTF and Godot only wants the deform hierarchy.

Run blender_scale_to_size first: the rig is fitted from the mesh's bounds, so a wrongly-scaled mesh gets a wrongly-proportioned skeleton. Then use blender_add_animation to author motion.`,
  inputSchema: rigSchema,
  defaultConsent: "always",
  modifiesState: true,

  execute: async (args, ctx) => {
    const missing = await requireBlender();
    if (missing) return `blender_auto_rig FAILED: ${missing}`;
    const dir = await workDir(ctx);
    const output = path.join(dir, stamp("rigged"));
    const res = await runBlender(
      { op: "auto_rig", input: resolveIn(ctx, args.input), output },
      { timeoutMs: 10 * 60_000 },
    );
    if (res.ok) card(ctx, "Rigged mesh", rel(ctx, output));
    return report("blender_auto_rig", res, ctx);
  },
};

const animateSchema = z.object({
  input: z
    .string()
    .describe("Path to a rigged model (output of blender_auto_rig)."),
  name: z.string().describe("Clip name, e.g. Idle, Walk, Jump, Attack."),
  loop: z
    .boolean()
    .optional()
    .describe("Mark the clip as cyclic. Default true."),
  keyframes: z
    .array(
      z.object({
        frame: z.number().describe("Frame number, 1-based."),
        bone: z.string().describe("Bone name, e.g. UpperArm.L, Hips, Head."),
        location: z
          .array(z.number())
          .optional()
          .describe("[x,y,z] pose offset."),
        rotation_euler: z
          .array(z.number())
          .optional()
          .describe("[x,y,z] rotation in DEGREES."),
        scale: z.array(z.number()).optional().describe("[x,y,z] scale."),
      }),
    )
    .describe(
      "Pose keys. Author at least a start, a middle and an end for a loop.",
    ),
});

export const blenderAddAnimationTool: ToolDefinition<
  z.infer<typeof animateSchema>
> = {
  name: "blender_add_animation",
  description: `Author an animation clip by keyframing bone poses on a rigged model.

You are the animator here — describe the motion as poses over time. Rotations are in degrees, which is what you can reason about.

A believable walk cycle is four keys: frame 1 contact pose, frame 8 passing, frame 16 opposite contact, frame 24 back to the start. An idle is two keys with a few degrees of chest and head sway. Keep loops returning exactly to their opening pose or they visibly pop.

Bone names come from blender_auto_rig: Hips, Spine, Chest, Neck, Head, Shoulder.L/R, UpperArm.L/R, LowerArm.L/R, Hand.L/R, UpperLeg.L/R, LowerLeg.L/R, Foot.L/R.`,
  inputSchema: animateSchema,
  defaultConsent: "always",
  modifiesState: true,

  execute: async (args, ctx) => {
    const missing = await requireBlender();
    if (missing) return `blender_add_animation FAILED: ${missing}`;
    if (args.keyframes.length === 0) {
      return "blender_add_animation FAILED: keyframes is empty — describe at least two poses.";
    }
    const dir = await workDir(ctx);
    const output = path.join(dir, stamp(`anim-${args.name.toLowerCase()}`));
    const res = await runBlender(
      {
        op: "add_animation",
        input: resolveIn(ctx, args.input),
        output,
        name: args.name,
        loop: args.loop ?? true,
        keyframes: args.keyframes,
      },
      { timeoutMs: 10 * 60_000 },
    );
    if (res.ok) card(ctx, `Animation "${args.name}"`, rel(ctx, output));
    return report("blender_add_animation", res, ctx);
  },
};

const retargetSchema = z.object({
  input: z.string().describe("Target rigged model to receive the animation."),
  source: z
    .string()
    .describe("A .blend file whose armature carries the action to copy."),
});

export const blenderRetargetTool: ToolDefinition<
  z.infer<typeof retargetSchema>
> = {
  name: "blender_retarget_animation",
  description:
    "Copy an animation from one rigged model onto another by matching bone names. Works reliably when both rigs came from blender_auto_rig; it fails loudly rather than producing subtly broken motion when the skeletons don't match.",
  inputSchema: retargetSchema,
  defaultConsent: "always",
  modifiesState: true,

  execute: async (args, ctx) => {
    const missing = await requireBlender();
    if (missing) return `blender_retarget_animation FAILED: ${missing}`;
    const dir = await workDir(ctx);
    const output = path.join(dir, stamp("retargeted"));
    const res = await runBlender(
      {
        op: "retarget_animation",
        input: resolveIn(ctx, args.input),
        source: resolveIn(ctx, args.source),
        output,
      },
      { timeoutMs: 10 * 60_000 },
    );
    return report("blender_retarget_animation", res, ctx);
  },
};

// ── Authoring from scratch ──────────────────────────────────────────────────

const primitiveSchema = z.object({
  kind: z
    .enum(["cube", "sphere", "cylinder", "cone", "torus", "plane", "monkey"])
    .describe("Primitive to build."),
  size: z.number().optional().describe("Size in metres. Default 1."),
});

export const blenderPrimitiveTool: ToolDefinition<
  z.infer<typeof primitiveSchema>
> = {
  name: "blender_create_primitive",
  description: `Build clean geometry directly.

Prefer this over generating a mesh with a diffusion model whenever the shape is simple — a crate, a platform, a pillar, a ball. It is instant, exact, low-poly, correctly scaled and already has UVs, where a generated mesh would be none of those.`,
  inputSchema: primitiveSchema,
  defaultConsent: "always",
  modifiesState: true,

  execute: async (args, ctx) => {
    const missing = await requireBlender();
    if (missing) return `blender_create_primitive FAILED: ${missing}`;
    const dir = await workDir(ctx);
    const output = path.join(dir, stamp(args.kind));
    const res = await runBlender({
      op: "create_primitive",
      kind: args.kind,
      size: args.size ?? 1,
      output,
    });
    if (res.ok) card(ctx, `Created ${args.kind}`, rel(ctx, output));
    return report("blender_create_primitive", res, ctx);
  },
};

const combineSchema = z.object({
  inputs: z
    .array(z.string())
    .min(2)
    .describe("Model paths to merge into one mesh."),
});

export const blenderCombineTool: ToolDefinition<z.infer<typeof combineSchema>> =
  {
    name: "blender_combine_meshes",
    description:
      "Join several models into a single mesh. Use it to build a compound prop from primitives, or to merge a multi-part generated mesh so it can be rigged as one.",
    inputSchema: combineSchema,
    defaultConsent: "always",
    modifiesState: true,

    execute: async (args, ctx) => {
      const missing = await requireBlender();
      if (missing) return `blender_combine_meshes FAILED: ${missing}`;
      const dir = await workDir(ctx);
      const output = path.join(dir, stamp("combined"));
      const res = await runBlender({
        op: "combine_meshes",
        inputs: args.inputs.map((p) => resolveIn(ctx, p)),
        output,
      });
      return report("blender_combine_meshes", res, ctx);
    },
  };

const previewSchema = z.object({
  input: z.string().describe("Model to render."),
  width: z.number().optional().describe("Default 768."),
  height: z.number().optional().describe("Default 768."),
});

export const blenderPreviewTool: ToolDefinition<z.infer<typeof previewSchema>> =
  {
    name: "blender_render_preview",
    description: `Render a lit three-quarter view of a model and attach it to the conversation so you can see what it actually looks like.

Use it before importing an asset into a scene: a generated mesh can be geometrically valid and still be unrecognisable, and this is how you catch that without launching the engine.`,
    inputSchema: previewSchema,
    defaultConsent: "always",
    modifiesState: false,

    execute: async (args, ctx) => {
      const missing = await requireBlender();
      if (missing) return `blender_render_preview FAILED: ${missing}`;
      const dir = await workDir(ctx);
      const outputImage = path.join(dir, stamp("preview", ".png"));
      const res = await runBlender(
        {
          op: "render_preview",
          input: resolveIn(ctx, args.input),
          output_image: outputImage,
          width: args.width ?? 768,
          height: args.height ?? 768,
        },
        { timeoutMs: 10 * 60_000 },
      );
      if (res.ok !== true) return report("blender_render_preview", res, ctx);
      ctx.appendUserMessage([
        {
          type: "text",
          text: `Blender preview of ${path.basename(args.input)}:`,
        },
        { type: "image-url", url: `file://${outputImage}` },
      ]);
      card(ctx, "Rendered preview", rel(ctx, outputImage));
      return `Preview rendered and attached below. Look at it: is the model recognisable, correctly oriented, and the right proportions?`;
    },
  };

const scriptSchema = z.object({
  script: z
    .string()
    .describe(
      "Python executed inside Blender with bpy in scope. Set ORION_RESULT to anything JSON-serialisable to return it. Helpers available: describe_scene(), mesh_objects(), select_only(objects).",
    ),
  input: z
    .string()
    .optional()
    .describe("Model to load before running the script."),
  output: z
    .string()
    .optional()
    .describe(
      "App-relative path to export to afterwards, e.g. .orianbuilder/media/3d/out.glb.",
    ),
});

export const blenderRunScriptTool: ToolDefinition<
  z.infer<typeof scriptSchema>
> = {
  name: "blender_run_script",
  description: `Execute Python inside Blender against a loaded model.

The escape hatch for anything the typed tools don't cover — boolean operations, arrays and mirrors, procedural geometry, curve-based modelling, custom modifier stacks, shape keys, physics bakes. Blender's API surface is enormous and no fixed tool list covers a real modelling request.

Prefer the typed tools when one fits: they validate their inputs and their failures are readable. Reach for this when none does.`,
  inputSchema: scriptSchema,
  defaultConsent: "ask",
  modifiesState: true,
  getConsentPreview: (args) =>
    `Run Blender Python (${args.script.split("\n").length} lines)`,

  execute: async (args, ctx) => {
    const missing = await requireBlender();
    if (missing) return `blender_run_script FAILED: ${missing}`;
    const res = await runBlender(
      {
        op: "run_script",
        script: args.script,
        ...(args.input ? { input: resolveIn(ctx, args.input) } : {}),
        ...(args.output ? { output: resolveIn(ctx, args.output) } : {}),
      },
      { timeoutMs: 15 * 60_000 },
    );
    return report("blender_run_script", res, ctx);
  },
};

export const BLENDER_TOOLS: readonly ToolDefinition[] = [
  blenderInspectTool,
  blenderConvertTool,
  blenderDecimateTool,
  blenderGenerateUvsTool,
  blenderScaleTool,
  blenderCenterOriginTool,
  blenderSmoothTool,
  blenderApplyMaterialTool,
  blenderBakeTool,
  blenderAutoRigTool,
  blenderAddAnimationTool,
  blenderRetargetTool,
  blenderPrimitiveTool,
  blenderCombineTool,
  blenderPreviewTool,
  blenderRunScriptTool,
];
