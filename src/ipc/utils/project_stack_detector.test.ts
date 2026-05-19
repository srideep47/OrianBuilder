import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { detectProjectStack } from "./project_stack_detector";

let tempRoot: string;

describe("detectProjectStack", () => {
  beforeEach(async () => {
    const testOutputRoot = path.join(process.cwd(), "out");
    await fs.mkdir(testOutputRoot, { recursive: true });
    tempRoot = await fs.mkdtemp(
      path.join(testOutputRoot, "orianbuilder-stack-detector-"),
    );
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("uses static preview commands for Expo projects when available", async () => {
    await fs.writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify(
        {
          scripts: {
            start: "npx expo start",
            build: "npx expo export --platform web --output-dir web-build",
            preview:
              "npx expo export --platform web --output-dir web-build && npx serve web-build --single --listen 4173",
            typecheck: "tsc --noEmit",
          },
          dependencies: {
            expo: "53.0.27",
            react: "19.0.0",
            "react-native": "0.79.6",
          },
          devDependencies: {
            typescript: "5.8.3",
          },
        },
        null,
        2,
      ),
    );
    await fs.writeFile(
      path.join(tempRoot, "app.config.js"),
      "module.exports = {};\n",
    );
    await fs.writeFile(path.join(tempRoot, "tsconfig.json"), "{}\n");

    const stack = await detectProjectStack(tempRoot);

    expect(stack.framework).toBe("expo");
    expect(stack.commands.install).toBe("npm install --legacy-peer-deps");
    expect(stack.commands.dev).toBe("npm run preview");
    expect(stack.commands.start).toBe("npm run start");
    expect(stack.commands.build).toBe("npm run build");
    expect(stack.commands.typecheck).toBe("npm run typecheck");
  });
});
