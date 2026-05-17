import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { detectProjectStack } from "@/ipc/utils/project_stack_detector";

let tempRoot: string;

async function writeJson(filePath: string, value: unknown) {
  await fs.writeFile(filePath, JSON.stringify(value, null, 2));
}

describe("project stack detector", () => {
  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "orianbuilder-stack-"));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("detects a pnpm Next.js TypeScript project", async () => {
    await writeJson(path.join(tempRoot, "package.json"), {
      packageManager: "pnpm@9.0.0",
      scripts: {
        dev: "next dev",
        build: "next build",
        lint: "next lint",
        typecheck: "tsc --noEmit",
      },
      dependencies: {
        next: "^15.0.0",
        react: "^19.0.0",
      },
      devDependencies: {
        typescript: "^5.8.0",
      },
    });
    await fs.writeFile(path.join(tempRoot, "next.config.ts"), "");
    await fs.writeFile(path.join(tempRoot, "tsconfig.json"), "{}");
    await fs.writeFile(path.join(tempRoot, "pnpm-lock.yaml"), "");

    const detection = await detectProjectStack(tempRoot);

    expect(detection).toMatchObject({
      packageManager: "pnpm",
      framework: "nextjs",
      kind: "fullstack",
      language: "typescript",
      confidence: "high",
      commands: {
        install: "pnpm install",
        dev: "pnpm dev",
        build: "pnpm build",
        lint: "pnpm lint",
        typecheck: "pnpm typecheck",
      },
    });
    expect(detection.configFiles).toContain("next.config.ts");
    expect(detection.evidence).toContain("Next.js config file found");
  });

  it("detects Vite from config and npm lockfile", async () => {
    await writeJson(path.join(tempRoot, "package.json"), {
      scripts: {
        dev: "vite",
        build: "vite build",
        test: "vitest",
      },
      dependencies: {
        "@vitejs/plugin-react": "^4.0.0",
        react: "^19.0.0",
        vite: "^6.0.0",
      },
    });
    await fs.writeFile(path.join(tempRoot, "vite.config.ts"), "");
    await fs.writeFile(path.join(tempRoot, "package-lock.json"), "{}");

    const detection = await detectProjectStack(tempRoot);

    expect(detection).toMatchObject({
      packageManager: "npm",
      framework: "vite",
      kind: "frontend",
      commands: {
        install: "npm install",
        dev: "npm run dev",
        build: "npm run build",
        test: "npm run test",
      },
    });
  });

  it("infers a TypeScript check for apps without a typecheck script", async () => {
    await writeJson(path.join(tempRoot, "package.json"), {
      scripts: {
        dev: "vite",
        build: "vite build",
      },
      dependencies: {
        "@vitejs/plugin-react": "^4.0.0",
        react: "^19.0.0",
        vite: "^6.0.0",
      },
      devDependencies: {
        typescript: "^5.8.0",
      },
    });
    await fs.writeFile(path.join(tempRoot, "vite.config.ts"), "");
    await fs.writeFile(path.join(tempRoot, "tsconfig.json"), "{}");
    await fs.writeFile(path.join(tempRoot, "package-lock.json"), "{}");

    const detection = await detectProjectStack(tempRoot);

    expect(detection).toMatchObject({
      language: "typescript",
      commands: {
        typecheck: "npx tsc --noEmit",
      },
    });
  });

  it("returns low-confidence unknown results for empty directories", async () => {
    const detection = await detectProjectStack(tempRoot);

    expect(detection).toMatchObject({
      framework: "unknown",
      kind: "unknown",
      confidence: "low",
      scripts: {},
    });
    expect(detection.warnings).toContain(
      "No package.json found; commands are inferred with low confidence.",
    );
  });
});
