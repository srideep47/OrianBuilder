import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { composeImportedModels, createGodotProject } from "./project";

describe("composeImportedModels", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots
        .splice(0)
        .map((root) => fs.rm(root, { recursive: true, force: true })),
    );
  });

  it("instances imported models and makes the starter scene interactive", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "orion-godot-scene-"));
    roots.push(root);
    await createGodotProject({ dir: root, name: "Harmony test" });
    const scenePath = path.join(root, "scenes", "main.tscn");
    const model = "res://assets/models/cube.glb";

    await composeImportedModels({
      projectDir: root,
      scenePath,
      modelResPaths: [model, model],
    });
    await composeImportedModels({
      projectDir: root,
      scenePath,
      modelResPaths: [model, "res://assets/models/sphere.glb"],
    });

    const scene = await fs.readFile(scenePath, "utf8");
    const controller = await fs.readFile(
      path.join(root, "scripts", "orion_showcase_controller.gd"),
      "utf8",
    );
    expect(scene).toContain(`path="${model}"`);
    expect(scene).toContain(
      'parent="World" instance=ExtResource("orion_model_1")',
    );
    expect(scene).toContain(
      'script = ExtResource("orion_showcase_controller")',
    );
    expect(scene).toContain("A/D rotate · W/S move · Space reset");
    expect(scene).toContain('id="OrionGroundMaterial"');
    expect(scene).toContain("fov = 52.0");
    expect(scene).toContain("size = Vector2(12, 12)");
    expect(scene.match(new RegExp(model, "g"))).toHaveLength(1);
    expect(scene).toContain('id="orion_model_2"');
    expect(scene.indexOf("[ext_resource")).toBeLessThan(
      scene.indexOf("[sub_resource"),
    );
    expect(controller).toContain('Input.get_axis("move_left", "move_right")');
  });
});
