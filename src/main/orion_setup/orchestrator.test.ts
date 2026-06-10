import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

let userDataDir = "";
vi.mock("@/paths/paths", () => ({
  getUserDataPath: () => userDataDir,
}));

import { OrionSetupOrchestrator } from "./orchestrator";
import type { OrionSetupDeps } from "./orchestrator";
import type { OrionSetupState } from "@/ipc/types/orion_setup";

interface Calls {
  refreshHardware: number;
  installDeps: number;
  downloads: string[];
  startBackend: number;
  enableNetwork: number;
}

function makeDeps(over: Partial<OrionSetupDeps> = {}): {
  deps: OrionSetupDeps;
  calls: Calls;
} {
  const calls: Calls = {
    refreshHardware: 0,
    installDeps: 0,
    downloads: [],
    startBackend: 0,
    enableNetwork: 0,
  };
  const deps: OrionSetupDeps = {
    refreshHardware: async () => {
      calls.refreshHardware += 1;
      return { backend: "cuda", summary: "RTX 4080 · cuda" };
    },
    getMediaStatus: async () => ({
      venvExists: false,
      depsInstalled: false,
      healthy: false,
      downloadedModelIds: [],
    }),
    resolveModelPlan: (downloaded) =>
      [...downloaded].includes("video")
        ? []
        : [{ id: "video", label: "Video" }],
    installDeps: async () => {
      calls.installDeps += 1;
    },
    downloadModel: async (id, onLog) => {
      onLog('{"type":"progress","percentage":100}');
      calls.downloads.push(id);
    },
    startBackend: async () => {
      calls.startBackend += 1;
    },
    waitHealthy: async () => true,
    detectEngineModel: () => false,
    enableNetwork: async () => {
      calls.enableNetwork += 1;
    },
    onUpdate: () => {},
    ...over,
  };
  return { deps, calls };
}

async function waitFor(check: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitFor timed out");
}

const stepStatus = (s: OrionSetupState, id: string) =>
  s.steps.find((x) => x.id === id)?.status;

beforeEach(async () => {
  userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "orion-setup-"));
});

describe("OrionSetupOrchestrator", () => {
  it("runs the full required chain to completion", async () => {
    const orch = new OrionSetupOrchestrator();
    const { deps, calls } = makeDeps();
    orch.setDeps(deps);

    await orch.start({ includeEngine: true, includeP2p: true });
    await waitFor(() => orch.getState().overall === "completed");

    const state = orch.getState();
    expect(stepStatus(state, "hardware")).toBe("done");
    expect(stepStatus(state, "media-deps")).toBe("done");
    expect(stepStatus(state, "media-models")).toBe("done");
    expect(stepStatus(state, "start-backend")).toBe("done");
    // Optional steps don't block completion.
    expect(stepStatus(state, "engine-model")).toBe("needs-action");
    expect(stepStatus(state, "p2p")).toBe("needs-action");
    expect(state.backend).toBe("cuda");

    expect(calls.installDeps).toBe(1);
    expect(calls.downloads).toEqual(["video"]);
    expect(calls.startBackend).toBe(1);
    expect(calls.enableNetwork).toBe(1);
  });

  it("skips optional steps that are toggled off", async () => {
    const orch = new OrionSetupOrchestrator();
    const { deps, calls } = makeDeps();
    orch.setDeps(deps);

    await orch.start({ includeEngine: false, includeP2p: false });
    await waitFor(() => orch.getState().overall === "completed");

    const state = orch.getState();
    expect(stepStatus(state, "engine-model")).toBe("skipped");
    expect(stepStatus(state, "p2p")).toBe("skipped");
    expect(calls.enableNetwork).toBe(0);
  });

  it("recovers a step caught mid-run back to pending on init (resumable)", async () => {
    const file = path.join(userDataDir, "orion-setup", "state.json");
    await fs.mkdir(path.dirname(file), { recursive: true });
    const crashed: OrionSetupState = {
      overall: "running",
      includeEngine: true,
      includeP2p: true,
      log: [],
      startedAt: Date.now(),
      steps: [
        {
          id: "hardware",
          label: "Detect hardware",
          required: true,
          status: "done",
        },
        {
          id: "media-deps",
          label: "Install media backend",
          required: true,
          status: "running",
        },
        {
          id: "media-models",
          label: "Download media models",
          required: true,
          status: "pending",
        },
        {
          id: "start-backend",
          label: "Start media backend",
          required: true,
          status: "pending",
        },
      ],
    };
    await fs.writeFile(file, JSON.stringify(crashed), "utf-8");

    const orch = new OrionSetupOrchestrator();
    orch.setDeps(makeDeps().deps);
    await orch.init();

    const state = orch.getState();
    expect(state.overall).toBe("paused"); // interrupted run is resumable
    expect(stepStatus(state, "media-deps")).toBe("pending"); // reset from running
  });

  it("resume re-derives already-done work and skips it", async () => {
    const file = path.join(userDataDir, "orion-setup", "state.json");
    await fs.mkdir(path.dirname(file), { recursive: true });
    const prior: OrionSetupState = {
      overall: "paused",
      includeEngine: false,
      includeP2p: false,
      log: [],
      startedAt: Date.now(),
      backend: "cuda",
      steps: [
        {
          id: "hardware",
          label: "Detect hardware",
          required: true,
          status: "done",
        },
        {
          id: "media-deps",
          label: "Install media backend",
          required: true,
          status: "done",
        },
        {
          id: "media-models",
          label: "Download media models",
          required: true,
          status: "done",
        },
        {
          id: "start-backend",
          label: "Start media backend",
          required: true,
          status: "done",
        },
        {
          id: "engine-model",
          label: "Local language model",
          required: false,
          status: "skipped",
        },
        {
          id: "p2p",
          label: "Pair a teammate (P2P)",
          required: false,
          status: "skipped",
        },
      ],
    };
    await fs.writeFile(file, JSON.stringify(prior), "utf-8");

    const orch = new OrionSetupOrchestrator();
    // Live status reports everything already installed/healthy.
    const { deps, calls } = makeDeps({
      getMediaStatus: async () => ({
        venvExists: true,
        depsInstalled: true,
        healthy: true,
        downloadedModelIds: ["video"],
      }),
    });
    orch.setDeps(deps);
    await orch.init();

    await orch.resume();
    await waitFor(() => orch.getState().overall === "completed");

    // Nothing re-installed/re-downloaded/re-started — resume skipped done work.
    expect(calls.installDeps).toBe(0);
    expect(calls.downloads).toEqual([]);
    expect(calls.startBackend).toBe(0);
    expect(calls.refreshHardware).toBe(0);
  });

  it("pauses on a failing required step after retrying with backoff", async () => {
    const orch = new OrionSetupOrchestrator();
    let attempts = 0;
    const { deps } = makeDeps({
      installDeps: async () => {
        attempts += 1;
        throw new Error("pip failed (no network)");
      },
    });
    orch.setDeps(deps);

    await orch.start({ includeEngine: false, includeP2p: false });
    await waitFor(() => orch.getState().overall === "paused", 12_000);

    const state = orch.getState();
    expect(stepStatus(state, "media-deps")).toBe("failed");
    expect(attempts).toBe(3); // DEFAULT_ATTEMPTS, with backoff between
    // A required failure stops the chain before later steps.
    expect(stepStatus(state, "start-backend")).toBe("pending");
  }, 15_000);

  it("retries a single failed step and completes", async () => {
    const orch = new OrionSetupOrchestrator();
    // Backend is "down" for the whole first run (every attempt fails → paused),
    // then comes back so an explicit retry of just that step succeeds.
    let backendUp = false;
    const { deps } = makeDeps({
      startBackend: async () => {
        if (!backendUp) throw new Error("backend offline");
      },
      // Deps/models already present so the retry only re-runs start-backend.
      getMediaStatus: async () => ({
        venvExists: true,
        depsInstalled: true,
        healthy: false,
        downloadedModelIds: ["video"],
      }),
    });
    orch.setDeps(deps);

    await orch.start({ includeEngine: false, includeP2p: false });
    // start-backend fails all attempts → paused.
    await waitFor(() => orch.getState().overall === "paused", 12_000);
    expect(stepStatus(orch.getState(), "start-backend")).toBe("failed");

    backendUp = true;
    await orch.retryStep("start-backend");
    await waitFor(() => orch.getState().overall === "completed", 6_000);
    expect(stepStatus(orch.getState(), "start-backend")).toBe("done");
  }, 20_000);

  it("cancel mid-download leaves the run resumable (paused)", async () => {
    const orch = new OrionSetupOrchestrator();
    let releaseFirst: (() => void) | null = null;
    let entered = false;
    const gate = new Promise<void>((r) => {
      releaseFirst = r;
    });
    const { deps, calls } = makeDeps({
      resolveModelPlan: () => [
        { id: "image-z-image-turbo", label: "Image" },
        { id: "video", label: "Video" },
      ],
      downloadModel: async (id) => {
        if (id === "image-z-image-turbo") {
          entered = true;
          await gate; // hold the first download so we can cancel mid-flight
        }
        calls.downloads.push(id);
      },
    });
    orch.setDeps(deps);

    await orch.start({ includeEngine: false, includeP2p: false });
    await waitFor(() => entered);
    await orch.cancel();
    releaseFirst!();

    await waitFor(() => orch.getState().overall === "paused");
    // Second model never downloaded; media-models is resumable.
    expect(calls.downloads).toEqual(["image-z-image-turbo"]);
    expect(stepStatus(orch.getState(), "media-models")).toBe("pending");
  });
});
