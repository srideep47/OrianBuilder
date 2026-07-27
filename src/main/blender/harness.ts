/**
 * The Python harness Blender runs.
 *
 * Every Blender operation Orion performs goes through this one script, invoked as
 * `blender --background --python harness.py -- <json-path>`. That shape is
 * deliberate:
 *
 *  - **one process per operation.** Blender has no server mode, and a long-lived
 *    instance driven over a pipe would have to keep a consistent scene across
 *    unrelated calls. A fresh process per op means an operation that corrupts a
 *    mesh or hangs a modifier can't poison the next one.
 *  - **arguments via a JSON file, not argv.** Prompts and file paths routinely
 *    contain quotes, spaces and non-ASCII; every shell-quoting scheme we could
 *    use across Windows, macOS and Linux has an escape hatch that leaks. A temp
 *    file has none.
 *  - **structured result on a sentinel line.** Blender writes a lot of its own
 *    noise to stdout (splash text, add-on registration, render progress), so the
 *    harness frames its own result between markers the caller greps for.
 */

export const RESULT_BEGIN = "<<<ORION_RESULT_BEGIN>>>";
export const RESULT_END = "<<<ORION_RESULT_END>>>";

/** Operations the harness implements. */
export const BLENDER_OPS = [
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
] as const;

export type BlenderOp = (typeof BLENDER_OPS)[number];

export const BLENDER_HARNESS_PY = String.raw`# Orion Builder — Blender automation harness.
# Invoked as: blender --background --python harness.py -- <request.json>
# Writes a JSON result between sentinel markers on stdout.

import bpy
import bmesh
import json
import math
import os
import sys
import traceback

RESULT_BEGIN = "${RESULT_BEGIN}"
RESULT_END = "${RESULT_END}"


def emit(payload):
    print(RESULT_BEGIN)
    print(json.dumps(payload))
    print(RESULT_END)
    sys.stdout.flush()


def read_request():
    argv = sys.argv
    if "--" not in argv:
        raise RuntimeError("no request file passed after --")
    request_path = argv[argv.index("--") + 1]
    with open(request_path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def reset_scene():
    """Empty the file completely.

    "bpy.ops.wm.read_factory_settings" leaves the startup cube behind, and
    deleting only "MESH" objects leaves orphaned meshes, materials and actions
    that later show up in an export. Purging orphans is what makes a converted
    glTF contain exactly what was imported.
    """
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for block in (
        bpy.data.meshes,
        bpy.data.materials,
        bpy.data.images,
        bpy.data.actions,
        bpy.data.armatures,
    ):
        for item in list(block):
            if item.users == 0:
                block.remove(item)


def import_any(path):
    """Import by extension. Returns the list of imported objects."""
    before = set(bpy.data.objects)
    ext = os.path.splitext(path)[1].lower()
    if ext in (".glb", ".gltf"):
        bpy.ops.import_scene.gltf(filepath=path)
    elif ext == ".fbx":
        bpy.ops.import_scene.fbx(filepath=path)
    elif ext == ".obj":
        # Blender 4.x renamed the OBJ operator; support both.
        if hasattr(bpy.ops.wm, "obj_import"):
            bpy.ops.wm.obj_import(filepath=path)
        else:
            bpy.ops.import_scene.obj(filepath=path)
    elif ext == ".dae":
        bpy.ops.wm.collada_import(filepath=path)
    elif ext == ".stl":
        if hasattr(bpy.ops.wm, "stl_import"):
            bpy.ops.wm.stl_import(filepath=path)
        else:
            bpy.ops.import_mesh.stl(filepath=path)
    elif ext == ".ply":
        if hasattr(bpy.ops.wm, "ply_import"):
            bpy.ops.wm.ply_import(filepath=path)
        else:
            bpy.ops.import_mesh.ply(filepath=path)
    elif ext == ".blend":
        bpy.ops.wm.open_mainfile(filepath=path)
        return list(bpy.data.objects)
    elif ext == ".usdz" or ext == ".usd" or ext == ".usdc":
        bpy.ops.wm.usd_import(filepath=path)
    else:
        raise RuntimeError("unsupported import format: %s" % ext)
    return [o for o in bpy.data.objects if o not in before]


def export_any(path, selected_only=False, apply_modifiers=True):
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    ext = os.path.splitext(path)[1].lower()
    if ext in (".glb", ".gltf"):
        bpy.ops.export_scene.gltf(
            filepath=path,
            export_format="GLB" if ext == ".glb" else "GLTF_SEPARATE",
            use_selection=selected_only,
            export_apply=apply_modifiers,
            # Godot reads glTF tangents directly; without them normal maps are
            # lit wrong on imported meshes.
            export_tangents=True,
            export_animations=True,
            export_skins=True,
            export_morph=True,
        )
    elif ext == ".fbx":
        bpy.ops.export_scene.fbx(
            filepath=path, use_selection=selected_only, apply_unit_scale=True
        )
    elif ext == ".obj":
        if hasattr(bpy.ops.wm, "obj_export"):
            bpy.ops.wm.obj_export(filepath=path, export_selected_objects=selected_only)
        else:
            bpy.ops.export_scene.obj(filepath=path, use_selection=selected_only)
    elif ext == ".blend":
        bpy.ops.wm.save_as_mainfile(filepath=path)
    else:
        raise RuntimeError("unsupported export format: %s" % ext)
    return path


def mesh_objects():
    return [o for o in bpy.data.objects if o.type == "MESH"]


def select_only(objects):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objects:
        o.select_set(True)
    if objects:
        bpy.context.view_layer.objects.active = objects[0]


def describe_scene():
    objects = []
    for o in bpy.data.objects:
        entry = {
            "name": o.name,
            "type": o.type,
            "location": list(o.location),
            "rotation_euler": list(o.rotation_euler),
            "scale": list(o.scale),
        }
        if o.type == "MESH":
            entry["vertices"] = len(o.data.vertices)
            entry["polygons"] = len(o.data.polygons)
            entry["materials"] = [m.name for m in o.data.materials if m]
            entry["uv_layers"] = [uv.name for uv in o.data.uv_layers]
            bb = [list(corner) for corner in o.bound_box]
            entry["bound_box"] = bb
            xs = [c[0] for c in bb]
            ys = [c[1] for c in bb]
            zs = [c[2] for c in bb]
            entry["dimensions"] = [
                (max(xs) - min(xs)) * o.scale.x,
                (max(ys) - min(ys)) * o.scale.y,
                (max(zs) - min(zs)) * o.scale.z,
            ]
        if o.type == "ARMATURE":
            entry["bones"] = [b.name for b in o.data.bones]
        objects.append(entry)
    return {
        "objects": objects,
        "materials": [m.name for m in bpy.data.materials],
        "actions": [a.name for a in bpy.data.actions],
        "frame_start": bpy.context.scene.frame_start,
        "frame_end": bpy.context.scene.frame_end,
    }


# ── Operations ──────────────────────────────────────────────────────────────


def op_info(req):
    return {
        "version": list(bpy.app.version),
        "version_string": bpy.app.version_string,
        "binary": bpy.app.binary_path,
    }


def op_import_model(req):
    reset_scene()
    imported = import_any(req["input"])
    return {"imported": [o.name for o in imported], "scene": describe_scene()}


def op_inspect(req):
    reset_scene()
    import_any(req["input"])
    return {"scene": describe_scene()}


def op_convert(req):
    reset_scene()
    import_any(req["input"])
    out = export_any(req["output"], apply_modifiers=req.get("apply_modifiers", True))
    return {"output": out, "scene": describe_scene()}


def op_export_model(req):
    # Operates on whatever a preceding op left in the file — only meaningful
    # inside run_script chains, so it re-imports when given an input.
    if req.get("input"):
        reset_scene()
        import_any(req["input"])
    out = export_any(req["output"])
    return {"output": out}


def op_decimate(req):
    """Reduce triangle count. Generated meshes routinely arrive at 100k+ tris,
    which tanks frame rate on anything but a workstation GPU."""
    reset_scene()
    import_any(req["input"])
    ratio = float(req.get("ratio", 0.5))
    targets = mesh_objects()
    for obj in targets:
        select_only([obj])
        mod = obj.modifiers.new(name="OrionDecimate", type="DECIMATE")
        mod.ratio = max(0.01, min(1.0, ratio))
        bpy.ops.object.modifier_apply(modifier=mod.name)
    out = export_any(req["output"])
    return {"output": out, "ratio": ratio, "scene": describe_scene()}


def op_smooth_shade(req):
    reset_scene()
    import_any(req["input"])
    angle = math.radians(float(req.get("angle_degrees", 30.0)))
    for obj in mesh_objects():
        select_only([obj])
        bpy.ops.object.shade_smooth()
        # Blender 4.1 replaced use_auto_smooth with a modifier; support both.
        if hasattr(obj.data, "use_auto_smooth"):
            obj.data.use_auto_smooth = True
            obj.data.auto_smooth_angle = angle
        else:
            bpy.ops.object.shade_auto_smooth(angle=angle)
    out = export_any(req["output"])
    return {"output": out}


def op_generate_uvs(req):
    """Smart-project UVs. AI-generated meshes usually have none, and without UVs
    no texture can be applied at all."""
    reset_scene()
    import_any(req["input"])
    for obj in mesh_objects():
        select_only([obj])
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.uv.smart_project(
            angle_limit=math.radians(float(req.get("angle_limit", 66.0))),
            island_margin=float(req.get("island_margin", 0.02)),
        )
        bpy.ops.object.mode_set(mode="OBJECT")
    out = export_any(req["output"])
    return {"output": out, "scene": describe_scene()}


def op_apply_material(req):
    """Build a principled BSDF from generated texture maps and assign it."""
    reset_scene()
    import_any(req["input"])

    mat = bpy.data.materials.new(name=req.get("material_name", "OrionMaterial"))
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    bsdf = nodes.get("Principled BSDF")

    def hook(image_path, socket, non_color=False):
        if not image_path or not os.path.exists(image_path):
            return
        tex = nodes.new("ShaderNodeTexImage")
        tex.image = bpy.data.images.load(image_path)
        if non_color:
            tex.image.colorspace_settings.name = "Non-Color"
        links.new(tex.outputs["Color"], bsdf.inputs[socket])

    maps = req.get("maps", {})
    hook(maps.get("base_color"), "Base Color")
    hook(maps.get("roughness"), "Roughness", non_color=True)
    hook(maps.get("metallic"), "Metallic", non_color=True)

    normal_path = maps.get("normal")
    if normal_path and os.path.exists(normal_path):
        tex = nodes.new("ShaderNodeTexImage")
        tex.image = bpy.data.images.load(normal_path)
        tex.image.colorspace_settings.name = "Non-Color"
        nrm = nodes.new("ShaderNodeNormalMap")
        links.new(tex.outputs["Color"], nrm.inputs["Color"])
        links.new(nrm.outputs["Normal"], bsdf.inputs["Normal"])

    if "base_color_rgba" in req:
        rgba = req["base_color_rgba"]
        bsdf.inputs["Base Color"].default_value = (
            rgba[0], rgba[1], rgba[2], rgba[3] if len(rgba) > 3 else 1.0
        )

    for obj in mesh_objects():
        obj.data.materials.clear()
        obj.data.materials.append(mat)

    out = export_any(req["output"])
    return {"output": out, "material": mat.name}


def op_bake_textures(req):
    """Bake the current material into a flat image.

    Needed when a mesh carries procedural nodes: Godot can't evaluate Blender
    shader graphs, so anything not baked to an image is lost on import.
    """
    reset_scene()
    import_any(req["input"])
    size = int(req.get("size", 1024))
    bake_type = req.get("bake_type", "DIFFUSE")

    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = int(req.get("samples", 32))
    scene.cycles.device = "CPU"

    image = bpy.data.images.new("OrionBake", width=size, height=size)
    baked = []
    for obj in mesh_objects():
        if not obj.data.uv_layers:
            select_only([obj])
            bpy.ops.object.mode_set(mode="EDIT")
            bpy.ops.mesh.select_all(action="SELECT")
            bpy.ops.uv.smart_project(angle_limit=math.radians(66.0))
            bpy.ops.object.mode_set(mode="OBJECT")
        for mat in obj.data.materials:
            if not mat or not mat.use_nodes:
                continue
            tex = mat.node_tree.nodes.new("ShaderNodeTexImage")
            tex.image = image
            mat.node_tree.nodes.active = tex
        select_only([obj])
        bpy.ops.object.bake(type=bake_type, use_clear=True, margin=int(req.get("margin", 8)))
        baked.append(obj.name)

    out_image = req["output_image"]
    os.makedirs(os.path.dirname(out_image) or ".", exist_ok=True)
    image.filepath_raw = out_image
    image.file_format = "PNG"
    image.save()
    result = {"baked": baked, "output_image": out_image}
    if req.get("output"):
        result["output"] = export_any(req["output"])
    return result


def op_auto_rig(req):
    """Fit a simple humanoid armature and bind the mesh with automatic weights.

    Deliberately a *simple* rig, not a Rigify control rig: Godot's animation
    system wants a clean bone hierarchy with skin weights, and Rigify's control
    bones don't export usefully to glTF.
    """
    reset_scene()
    import_any(req["input"])
    meshes = mesh_objects()
    if not meshes:
        raise RuntimeError("no mesh to rig")

    target = meshes[0]
    dims = target.dimensions
    height = max(dims.z, 0.001)
    base_z = target.location.z - height / 2.0

    bpy.ops.object.armature_add(enter_editmode=False, location=(target.location.x, target.location.y, base_z))
    arm = bpy.context.active_object
    arm.name = "OrionRig"
    bpy.ops.object.mode_set(mode="EDIT")
    edit_bones = arm.data.edit_bones
    for b in list(edit_bones):
        edit_bones.remove(b)

    # Proportions as fractions of total height — standard human ratios, so the
    # rig lands roughly right on any humanoid mesh regardless of its scale.
    spec = [
        ("Hips", 0.50, 0.60, None),
        ("Spine", 0.60, 0.72, "Hips"),
        ("Chest", 0.72, 0.84, "Spine"),
        ("Neck", 0.84, 0.90, "Chest"),
        ("Head", 0.90, 1.00, "Neck"),
        ("UpperLeg.L", 0.50, 0.28, "Hips"),
        ("LowerLeg.L", 0.28, 0.06, "UpperLeg.L"),
        ("Foot.L", 0.06, 0.00, "LowerLeg.L"),
        ("UpperLeg.R", 0.50, 0.28, "Hips"),
        ("LowerLeg.R", 0.28, 0.06, "UpperLeg.R"),
        ("Foot.R", 0.06, 0.00, "LowerLeg.R"),
    ]
    made = {}
    for name, z0, z1, parent in spec:
        bone = edit_bones.new(name)
        x = 0.0
        if name.endswith(".L"):
            x = height * 0.09
        elif name.endswith(".R"):
            x = -height * 0.09
        bone.head = (x, 0.0, height * z0)
        bone.tail = (x, 0.0, height * z1)
        if parent and parent in made:
            bone.parent = made[parent]
            bone.use_connect = False
        made[name] = bone

    # Arms run along X, so they need their own head/tail rather than the
    # vertical spec above.
    for side, sign in (("L", 1.0), ("R", -1.0)):
        shoulder = edit_bones.new("Shoulder.%s" % side)
        shoulder.head = (0.0, 0.0, height * 0.82)
        shoulder.tail = (sign * height * 0.10, 0.0, height * 0.82)
        shoulder.parent = made["Chest"]
        upper = edit_bones.new("UpperArm.%s" % side)
        upper.head = shoulder.tail
        upper.tail = (sign * height * 0.24, 0.0, height * 0.80)
        upper.parent = shoulder
        lower = edit_bones.new("LowerArm.%s" % side)
        lower.head = upper.tail
        lower.tail = (sign * height * 0.36, 0.0, height * 0.76)
        lower.parent = upper
        hand = edit_bones.new("Hand.%s" % side)
        hand.head = lower.tail
        hand.tail = (sign * height * 0.42, 0.0, height * 0.74)
        hand.parent = lower

    bpy.ops.object.mode_set(mode="OBJECT")

    for mesh in meshes:
        select_only([mesh, arm])
        bpy.context.view_layer.objects.active = arm
        bpy.ops.object.parent_set(type="ARMATURE_AUTO")

    out = export_any(req["output"])
    return {
        "output": out,
        "armature": arm.name,
        "bones": [b.name for b in arm.data.bones],
        "scene": describe_scene(),
    }


def op_add_animation(req):
    """Keyframe a named clip onto an existing armature.

    Clips are described as a list of {frame, bone, location?, rotation_euler?}
    so the agent can author motion without needing a motion-capture source.
    """
    reset_scene()
    import_any(req["input"])
    arms = [o for o in bpy.data.objects if o.type == "ARMATURE"]
    if not arms:
        raise RuntimeError("no armature; run auto_rig first")
    arm = arms[0]

    scene = bpy.context.scene
    name = req.get("name", "OrionClip")
    frames = req.get("keyframes", [])
    if not frames:
        raise RuntimeError("keyframes is empty")

    action = bpy.data.actions.new(name=name)
    if arm.animation_data is None:
        arm.animation_data_create()
    arm.animation_data.action = action

    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="POSE")

    last = 1
    for key in frames:
        frame = int(key.get("frame", 1))
        last = max(last, frame)
        bone_name = key.get("bone")
        if bone_name not in arm.pose.bones:
            continue
        pb = arm.pose.bones[bone_name]
        scene.frame_set(frame)
        if "location" in key:
            pb.location = key["location"]
            pb.keyframe_insert(data_path="location", frame=frame)
        if "rotation_euler" in key:
            pb.rotation_mode = "XYZ"
            pb.rotation_euler = [math.radians(v) for v in key["rotation_euler"]]
            pb.keyframe_insert(data_path="rotation_euler", frame=frame)
        if "scale" in key:
            pb.scale = key["scale"]
            pb.keyframe_insert(data_path="scale", frame=frame)

    bpy.ops.object.mode_set(mode="OBJECT")
    scene.frame_start = 1
    scene.frame_end = last

    if req.get("loop", True):
        action.use_cyclic = True

    out = export_any(req["output"])
    return {"output": out, "action": action.name, "frame_end": last}


def op_retarget_animation(req):
    """Copy an action from a source file's armature onto this one by bone name.

    Name-matched rather than skeleton-solved: it works when both rigs came from
    op_auto_rig (the common case, since Orion made both), and it fails loudly
    rather than producing subtly broken motion when they didn't.
    """
    reset_scene()
    import_any(req["input"])
    target_arms = [o for o in bpy.data.objects if o.type == "ARMATURE"]
    if not target_arms:
        raise RuntimeError("target has no armature")
    target = target_arms[0]
    target_bones = {b.name for b in target.data.bones}

    with bpy.data.libraries.load(req["source"], link=False) as (src, dst):
        dst.actions = [a for a in src.actions]
    if not bpy.data.actions:
        raise RuntimeError("source file has no actions")
    action = bpy.data.actions[-1]

    matched = 0
    unmatched = []
    for fcurve in list(action.fcurves):
        path = fcurve.data_path
        if not path.startswith('pose.bones["'):
            continue
        bone = path.split('"')[1]
        if bone in target_bones:
            matched += 1
        else:
            unmatched.append(bone)
            action.fcurves.remove(fcurve)

    if matched == 0:
        raise RuntimeError(
            "no bone names matched between source and target (source bones: %s)"
            % ", ".join(sorted(set(unmatched))[:12]
        ))

    if target.animation_data is None:
        target.animation_data_create()
    target.animation_data.action = action

    out = export_any(req["output"])
    return {
        "output": out,
        "action": action.name,
        "matched_curves": matched,
        "dropped_bones": sorted(set(unmatched)),
    }


def op_create_primitive(req):
    """Build geometry from scratch. Faster and cleaner than generating a mesh
    with a diffusion model when the shape is a box, sphere, stair or platform."""
    reset_scene()
    kind = req.get("kind", "cube")
    size = float(req.get("size", 1.0))
    loc = req.get("location", [0, 0, 0])
    if kind == "cube":
        bpy.ops.mesh.primitive_cube_add(size=size, location=loc)
    elif kind == "sphere":
        bpy.ops.mesh.primitive_uv_sphere_add(radius=size / 2, location=loc)
    elif kind == "cylinder":
        bpy.ops.mesh.primitive_cylinder_add(radius=size / 2, depth=size, location=loc)
    elif kind == "cone":
        bpy.ops.mesh.primitive_cone_add(radius1=size / 2, depth=size, location=loc)
    elif kind == "torus":
        bpy.ops.mesh.primitive_torus_add(major_radius=size / 2, minor_radius=size / 6, location=loc)
    elif kind == "plane":
        bpy.ops.mesh.primitive_plane_add(size=size, location=loc)
    elif kind == "monkey":
        bpy.ops.mesh.primitive_monkey_add(size=size, location=loc)
    else:
        raise RuntimeError("unknown primitive: %s" % kind)
    out = export_any(req["output"])
    return {"output": out, "scene": describe_scene()}


def op_combine_meshes(req):
    reset_scene()
    for path in req["inputs"]:
        import_any(path)
    meshes = mesh_objects()
    if len(meshes) > 1:
        select_only(meshes)
        bpy.ops.object.join()
    out = export_any(req["output"])
    return {"output": out, "scene": describe_scene()}


def op_scale_to_size(req):
    """Normalise a mesh to a real-world size.

    Generated meshes come out at arbitrary scale, and a character that imports at
    40 units tall breaks physics, camera framing and every hand-tuned speed
    constant in the game.
    """
    reset_scene()
    import_any(req["input"])
    target = float(req.get("target_size", 2.0))
    axis = req.get("axis", "z")
    for obj in mesh_objects():
        dims = obj.dimensions
        current = {"x": dims.x, "y": dims.y, "z": dims.z}[axis]
        if current <= 0:
            continue
        factor = target / current
        obj.scale = [s * factor for s in obj.scale]
        select_only([obj])
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    out = export_any(req["output"])
    return {"output": out, "scene": describe_scene()}


def op_center_origin(req):
    """Move each object's origin to the bottom-centre of its bounds.

    Godot places nodes by origin, so a mesh whose origin sits at its centre
    floats half-buried when you set its Y to the floor height.
    """
    reset_scene()
    import_any(req["input"])
    mode = req.get("mode", "bottom")
    for obj in mesh_objects():
        select_only([obj])
        bpy.ops.object.origin_set(type="ORIGIN_GEOMETRY", center="BOUNDS")
        if mode == "bottom":
            half = obj.dimensions.z / 2.0
            bpy.context.scene.cursor.location = (
                obj.location.x, obj.location.y, obj.location.z - half
            )
            bpy.ops.object.origin_set(type="ORIGIN_CURSOR")
            bpy.context.scene.cursor.location = (0, 0, 0)
        obj.location = (0, 0, 0)
    out = export_any(req["output"])
    return {"output": out, "scene": describe_scene()}


def op_render_preview(req):
    """Render a turntable-lit preview so the agent (and the user) can actually
    see what a generated mesh looks like before it goes into a scene."""
    reset_scene()
    import_any(req["input"])
    meshes = mesh_objects()
    if not meshes:
        raise RuntimeError("nothing to render")

    select_only(meshes)
    bpy.ops.object.select_all(action="SELECT")
    max_dim = max((max(o.dimensions) for o in meshes), default=1.0) or 1.0

    bpy.ops.object.camera_add(location=(max_dim * 2.0, -max_dim * 2.4, max_dim * 1.6))
    cam = bpy.context.active_object
    cam.rotation_euler = (math.radians(64), 0, math.radians(40))
    bpy.context.scene.camera = cam

    bpy.ops.object.light_add(type="AREA", location=(max_dim * 2, -max_dim * 2, max_dim * 3))
    key = bpy.context.active_object
    key.data.energy = 800 * max_dim
    key.data.size = max_dim * 3
    bpy.ops.object.light_add(type="AREA", location=(-max_dim * 2, max_dim * 1.5, max_dim * 1.5))
    fill = bpy.context.active_object
    fill.data.energy = 220 * max_dim
    fill.data.size = max_dim * 4

    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE_NEXT" if "BLENDER_EEVEE_NEXT" in [
        e.bl_idname for e in bpy.types.RenderEngine.__subclasses__()
    ] else "BLENDER_EEVEE"
    scene.render.resolution_x = int(req.get("width", 768))
    scene.render.resolution_y = int(req.get("height", 768))
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = "PNG"
    out_image = req["output_image"]
    os.makedirs(os.path.dirname(out_image) or ".", exist_ok=True)
    scene.render.filepath = out_image
    bpy.ops.render.render(write_still=True)
    return {"output_image": out_image}


def op_run_script(req):
    """Escape hatch: execute agent-authored Python against the loaded scene.

    Everything above is a typed, reviewed operation. This exists because Blender's
    surface is enormous and no fixed op list covers a real modelling request. The
    script runs with "bpy" in scope and must set "ORION_RESULT" to a
    JSON-serialisable value.
    """
    reset_scene()
    if req.get("input"):
        import_any(req["input"])
    namespace = {
        "bpy": bpy,
        "bmesh": bmesh,
        "math": math,
        "os": os,
        "ORION_RESULT": None,
        "describe_scene": describe_scene,
        "mesh_objects": mesh_objects,
        "select_only": select_only,
    }
    exec(req["script"], namespace)  # noqa: S102 — explicit, user-authorised
    result = {"result": namespace.get("ORION_RESULT")}
    if req.get("output"):
        result["output"] = export_any(req["output"])
    result["scene"] = describe_scene()
    return result


OPS = {
    "info": op_info,
    "import_model": op_import_model,
    "inspect": op_inspect,
    "convert": op_convert,
    "export_model": op_export_model,
    "decimate": op_decimate,
    "smooth_shade": op_smooth_shade,
    "generate_uvs": op_generate_uvs,
    "apply_material": op_apply_material,
    "bake_textures": op_bake_textures,
    "auto_rig": op_auto_rig,
    "add_animation": op_add_animation,
    "retarget_animation": op_retarget_animation,
    "create_primitive": op_create_primitive,
    "combine_meshes": op_combine_meshes,
    "scale_to_size": op_scale_to_size,
    "center_origin": op_center_origin,
    "render_preview": op_render_preview,
    "run_script": op_run_script,
}


def main():
    try:
        request = read_request()
        op = request.get("op")
        handler = OPS.get(op)
        if handler is None:
            emit({"ok": False, "error": "unknown op '%s'" % op})
            return
        payload = handler(request)
        payload["ok"] = True
        emit(payload)
    except Exception as exc:  # noqa: BLE001 — the harness must never crash silently
        emit({
            "ok": False,
            "error": str(exc),
            "traceback": traceback.format_exc(limit=8),
        })


main()
`;
