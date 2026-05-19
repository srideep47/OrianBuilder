import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createGreenfieldProject,
  getCliScaffoldCommand,
} from "@/ipc/utils/project_factory";
import { detectProjectStack } from "@/ipc/utils/project_stack_detector";

let tempRoot: string;

describe("greenfield project factory", () => {
  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "orianbuilder-factory-"),
    );
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("creates a Vite React TypeScript project that the stack detector recognizes", async () => {
    const result = await createGreenfieldProject({
      rootPath: tempRoot,
      projectName: "Customer Portal",
      stack: "vite-react-ts",
      packageManager: "pnpm",
    });

    expect(result.created).toBe(true);
    expect(result.files).toContain("package.json");
    expect(result.files).toContain("AI_RULES.md");
    expect(result.commands).toMatchObject({
      install: "pnpm install",
      dev: "pnpm dev",
      build: "pnpm build",
      typecheck: "pnpm typecheck",
    });
    expect(result.nextSteps).toEqual([
      "Run pnpm install",
      "Run pnpm typecheck",
      "Run pnpm build",
      "Run start_dev_server, then inspect console output and visual artifacts.",
    ]);

    const packageJson = JSON.parse(
      await fs.readFile(path.join(tempRoot, "package.json"), "utf8"),
    );
    expect(packageJson.name).toBe("customer-portal");

    const detection = await detectProjectStack(tempRoot);
    expect(detection).toMatchObject({
      packageManager: "pnpm",
      framework: "vite",
      kind: "frontend",
      language: "typescript",
      commands: {
        dev: "pnpm dev",
        build: "pnpm build",
        typecheck: "pnpm typecheck",
      },
    });
  });

  it("does not write into a non-empty project unless force is enabled", async () => {
    await fs.writeFile(path.join(tempRoot, "README.md"), "existing");

    const result = await createGreenfieldProject({
      rootPath: tempRoot,
      projectName: "Existing Project",
      stack: "nextjs-ts",
      packageManager: "npm",
    });

    expect(result.created).toBe(false);
    expect(result.reason).toContain("Project directory is not empty");
    await expect(
      fs.access(path.join(tempRoot, "package.json")),
    ).rejects.toThrow();
  });

  it("can create a blank custom foundation", async () => {
    const result = await createGreenfieldProject({
      rootPath: tempRoot,
      projectName: "Experimental Tool",
      stack: "blank",
      packageManager: "bun",
    });

    expect(result.created).toBe(true);
    expect(result.files).toEqual(["package.json", "AI_RULES.md", ".gitignore"]);
    expect(result.commands).toMatchObject({
      install: "bun install",
      dev: null,
      build: null,
      typecheck: null,
    });
    expect(
      await fs.readFile(path.join(tempRoot, "AI_RULES.md"), "utf8"),
    ).toContain("Stack: blank");
  });

  it("provides non-interactive CLI scaffold recipes when requested", async () => {
    expect(
      getCliScaffoldCommand({
        stack: "vite-react-ts",
        packageManager: "npm",
      }),
    ).toBe("npm create vite@latest . -- --template react-ts");
    expect(
      getCliScaffoldCommand({
        stack: "nextjs-ts",
        packageManager: "pnpm",
      }),
    ).toContain("pnpm create next-app");

    const result = await createGreenfieldProject({
      rootPath: tempRoot,
      projectName: "CLI App",
      stack: "vite-react-ts",
      packageManager: "npm",
      scaffoldMethod: "cli",
      executeCli: false,
    });

    expect(result.created).toBe(false);
    expect(result.scaffoldCommand).toBe(
      "npm create vite@latest . -- --template react-ts",
    );
    expect(result.nextSteps[0]).toBe(result.scaffoldCommand);
  });

  it("creates an Expo project with installable SDK 53 dependencies and native-safe metadata", async () => {
    const result = await createGreenfieldProject({
      rootPath: tempRoot,
      projectName: "Hello World Android App",
      stack: "expo",
      packageManager: "npm",
    });

    expect(result.created).toBe(true);
    expect(result.commands).toMatchObject({
      install: "npm install --legacy-peer-deps",
      dev: "npm run preview",
      build: "npm run build",
      typecheck: "npm run typecheck",
    });
    expect(result.nextSteps).toContain("Run npm run typecheck");

    const packageJson = JSON.parse(
      await fs.readFile(path.join(tempRoot, "package.json"), "utf8"),
    );
    expect(packageJson.dependencies).toMatchObject({
      expo: "53.0.27",
      "expo-router": "5.1.11",
      react: "19.0.0",
      "react-native": "0.79.6",
      "react-native-web": "0.20.0",
    });
    expect(packageJson.dependencies.nativewind).toBeUndefined();
    expect(packageJson.dependencies["react-native-worklets"]).toBeUndefined();
    expect(packageJson.devDependencies).toMatchObject({
      "@types/react": "19.0.10",
    });

    const gitignore = await fs.readFile(
      path.join(tempRoot, ".gitignore"),
      "utf8",
    );
    expect(gitignore).toContain("node_modules/");
    expect(gitignore).toContain(".expo/");
    expect(gitignore).toContain("android/");

    const appConfig = await fs.readFile(
      path.join(tempRoot, "app.config.js"),
      "utf8",
    );
    expect(appConfig).toContain('name: "Hello World Android App"');
    expect(appConfig).toContain('slug: "hello-world-android-app"');
    expect(appConfig).toContain(
      'package: "com.orianbuilder.helloworldandroidapp"',
    );
  });
});
