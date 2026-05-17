import { describe, expect, it } from "vitest";

import { getProjectVerificationCommands } from "./project_factory";

describe("getProjectVerificationCommands", () => {
  it("uses `preview` (build + static serve) for electron-app dev so QA gate can hit an HTTP endpoint", () => {
    const commands = getProjectVerificationCommands({
      stack: "electron-app",
      packageManager: "npm",
    });

    expect(commands.install).toBe("npm install");
    expect(commands.dev).toBe("npm run preview");
    expect(commands.build).toBe("npm run build");
    expect(commands.typecheck).toBe("npm run typecheck");
  });

  it("returns the standard dev command for vite-react-ts", () => {
    const commands = getProjectVerificationCommands({
      stack: "vite-react-ts",
      packageManager: "npm",
    });

    expect(commands.dev).toBe("npm run dev");
    expect(commands.build).toBe("npm run build");
    expect(commands.typecheck).toBe("npm run typecheck");
  });

  it("uses `start` for expo, not dev", () => {
    const commands = getProjectVerificationCommands({
      stack: "expo",
      packageManager: "npm",
    });

    expect(commands.dev).toBe("npm run start");
    expect(commands.build).toBeNull();
    expect(commands.typecheck).toBe("npm run typecheck");
  });

  it("emits no dev/build/typecheck for blank stack", () => {
    const commands = getProjectVerificationCommands({
      stack: "blank",
      packageManager: "npm",
    });

    expect(commands.dev).toBeNull();
    expect(commands.build).toBeNull();
    expect(commands.typecheck).toBeNull();
  });

  it("respects pnpm package manager for electron-app", () => {
    const commands = getProjectVerificationCommands({
      stack: "electron-app",
      packageManager: "pnpm",
    });

    expect(commands.install).toBe("pnpm install");
    expect(commands.dev).toBe("pnpm preview");
    expect(commands.build).toBe("pnpm build");
    expect(commands.typecheck).toBe("pnpm typecheck");
  });
});
