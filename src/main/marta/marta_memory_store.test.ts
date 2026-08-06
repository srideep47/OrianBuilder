import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let root: string;
let appData: string;
let userData: string;

vi.mock("@/paths/paths", () => ({
  getUserDataPath: () => userData,
  getElectron: () => ({
    app: {
      getPath: (name: string) => (name === "appData" ? appData : userData),
    },
  }),
}));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "orion-marta-memory-"));
  appData = path.join(root, "app-data");
  userData = path.join(root, "profile");
  fs.mkdirSync(appData, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  vi.unstubAllEnvs();
  vi.stubEnv("NODE_ENV", "production");
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("Marta universal layered memory", () => {
  it("stores normal profiles in shared app data and keeps explicit test profiles isolated", async () => {
    const store = await import("./marta_memory_store");
    expect(store.getMartaMemoryPath()).toBe(
      path.join(appData, "orianbuilder-marta-memory-v2.json"),
    );

    process.argv.push("--user-data-dir=isolated-test");
    try {
      expect(store.getMartaMemoryPath()).toBe(
        path.join(userData, "marta-memory.json"),
      );
    } finally {
      process.argv.pop();
    }
  });

  it("recalls global/project facts and task episodes without leaking other projects", async () => {
    const store = await import("./marta_memory_store");
    await store.rememberMartaFact({
      scope: "global",
      key: "coding worker",
      value: "Claude Haiku low effort",
      source: "user",
    });
    await store.rememberMartaFact({
      scope: "project",
      projectId: 7,
      key: "test command",
      value: "npm test",
      source: "orion",
    });
    await store.rememberMartaFact({
      scope: "project",
      projectId: 9,
      key: "secret convention",
      value: "project nine only",
      source: "orion",
    });
    await store.recordMartaEpisode({
      taskId: "task:1",
      projectId: 7,
      goal: "Build the page",
      outcome: "succeeded",
      summary: "Build and preview passed",
      completedAt: 10,
    });

    const digest = await store.getMartaMemoryDigest(7);
    expect(digest).toContain("Claude Haiku low effort");
    expect(digest).toContain("npm test");
    expect(digest).toContain("Build and preview passed");
    expect(digest).not.toContain("project nine only");
    await store._flushMartaMemoryForTests();
  });
});
