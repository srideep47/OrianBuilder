import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

let userDataDir = "";
vi.mock("@/paths/paths", () => ({
  getUserDataPath: () => userDataDir,
}));

import { MediaJobQueue } from "./queue";
import type { MediaQueueDeps } from "./queue";
import type { MediaJob } from "@/ipc/types/media_queue";
import type { MediaGenerationRequest } from "@/main/ipc/utils/model_orchestrator";

/** Poll until the job reaches a terminal/expected status. */
async function waitFor(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitFor timed out");
}

function makeDeps(overrides: Partial<MediaQueueDeps> = {}): {
  deps: MediaQueueDeps;
  generated: MediaGenerationRequest[];
  muxCalls: Array<{ video: string; audio: string; out: string }>;
  concatCalls: Array<{ inputs: string[]; width: number; height: number }>;
  imported: Array<{ src: string; share: boolean }>;
  updates: MediaJob[];
} {
  const generated: MediaGenerationRequest[] = [];
  const muxCalls: Array<{ video: string; audio: string; out: string }> = [];
  const concatCalls: Array<{
    inputs: string[];
    width: number;
    height: number;
  }> = [];
  const imported: Array<{ src: string; share: boolean }> = [];
  const updates: MediaJob[] = [];
  const deps: MediaQueueDeps = {
    generate: async (request) => {
      generated.push(request);
      await fs.mkdir(path.dirname(request.outputPath), { recursive: true });
      await fs.writeFile(request.outputPath, "fake-bytes");
      return {
        success: true,
        outputPath: request.outputPath,
        durationMs: 5,
      };
    },
    mux: async (video, audio, out) => {
      muxCalls.push({ video, audio, out });
      await fs.writeFile(out, "muxed-bytes");
    },
    concat: async (inputs, target, out) => {
      concatCalls.push({ inputs: [...inputs], ...target });
      await fs.writeFile(out, "concat-bytes");
    },
    parseScript: async () => {
      throw new Error("parseScript not stubbed for this test");
    },
    importToStore: async (src, opts) => {
      imported.push({ src, share: opts.share });
      return `stored-${path.basename(src)}`;
    },
    onJobUpdate: (job) => {
      updates.push({ ...job });
    },
    ...overrides,
  };
  return { deps, generated, muxCalls, concatCalls, imported, updates };
}

beforeEach(async () => {
  userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "media-queue-"));
});

describe("MediaJobQueue", () => {
  it("processes an image job and imports the output", async () => {
    const queue = new MediaJobQueue();
    const { deps, generated, imported } = makeDeps();
    queue.setDeps(deps);

    const job = queue.enqueue(
      { kind: "image", prompt: "a coffee logo", aspectRatio: "1:1" },
      { source: "local" },
    );
    await waitFor(() => queue.list()[0]?.status === "done");

    expect(generated).toHaveLength(1);
    expect(generated[0]).toMatchObject({
      modelType: "image",
      prompt: "a coffee logo",
      options: expect.objectContaining({ width: 1024, height: 1024 }),
    });
    expect(imported[0]?.share).toBe(false);
    const finished = queue.list()[0]!;
    expect(finished.id).toBe(job.id);
    expect(finished.outputFileNames).toHaveLength(1);
  });

  it("runs video_audio as video → audio → mux and shares peer jobs", async () => {
    const queue = new MediaJobQueue();
    const { deps, generated, muxCalls, imported } = makeDeps();
    queue.setDeps(deps);

    queue.enqueue(
      {
        kind: "video_audio",
        prompt: "a rotating coffee mug",
        audioKind: "music",
        aspectRatio: "9:16",
        durationSec: 8,
      },
      { source: "peer", peerKey: "friend-key", displayName: "Friend" },
    );
    await waitFor(() => queue.list()[0]?.status === "done");

    expect(generated.map((g) => g.modelType)).toEqual(["video", "music"]);
    expect(generated[0]!.options).toMatchObject({
      width: 288,
      height: 512,
      duration_s: 8,
    });
    // Music prompt defaults to one matched to the video prompt.
    expect(generated[1]!.prompt).toContain("a rotating coffee mug");
    expect(muxCalls).toHaveLength(1);
    // Peer-requested output is auto-shared for download via media share.
    expect(imported).toHaveLength(1);
    expect(imported[0]!.share).toBe(true);
  });

  it("marks a job failed on generation error and supports retry", async () => {
    const queue = new MediaJobQueue();
    let attempts = 0;
    const { deps } = makeDeps({
      generate: async (request) => {
        attempts += 1;
        if (attempts === 1) {
          return {
            success: false,
            outputPath: request.outputPath,
            durationMs: 1,
            error: "backend offline",
          };
        }
        await fs.writeFile(request.outputPath, "ok");
        return { success: true, outputPath: request.outputPath, durationMs: 1 };
      },
    });
    queue.setDeps(deps);

    const job = queue.enqueue(
      { kind: "image", prompt: "x" },
      { source: "local" },
    );
    await waitFor(() => queue.list()[0]?.status === "failed");
    expect(queue.list()[0]!.error).toContain("backend offline");

    expect(queue.retry(job.id)).toBe(true);
    await waitFor(() => queue.list()[0]?.status === "done");
    expect(attempts).toBe(2);
  });

  it("treats placeholder output as failure", async () => {
    const queue = new MediaJobQueue();
    const { deps } = makeDeps({
      generate: async (request) => ({
        success: true,
        outputPath: request.outputPath,
        durationMs: 1,
        error: "placeholder (no real provider available)",
      }),
    });
    queue.setDeps(deps);

    queue.enqueue({ kind: "image", prompt: "x" }, { source: "local" });
    await waitFor(() => queue.list()[0]?.status === "failed");
    expect(queue.list()[0]!.error).toContain("no media provider");
  });

  it("cancels a queued job before it runs", async () => {
    const queue = new MediaJobQueue();
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { deps, generated } = makeDeps({
      generate: async (request) => {
        await gate; // hold the first job so the second stays queued
        await fs.writeFile(request.outputPath, "ok");
        generatedPrompts.push(request.prompt);
        return { success: true, outputPath: request.outputPath, durationMs: 1 };
      },
    });
    const generatedPrompts: string[] = [];
    queue.setDeps(deps);

    queue.enqueue({ kind: "image", prompt: "first" }, { source: "local" });
    const second = queue.enqueue(
      { kind: "image", prompt: "second" },
      { source: "local" },
    );
    expect(queue.cancel(second.id)).toBe(true);
    release!();

    await waitFor(() =>
      queue
        .list()
        .every((j) => j.status === "done" || j.status === "cancelled"),
    );
    expect(generatedPrompts).toEqual(["first"]);
    expect(queue.list().find((j) => j.id === second.id)?.status).toBe(
      "cancelled",
    );
    expect(generated.filter((g) => g.prompt === "second")).toHaveLength(0);
  });

  it("recovers crashed running jobs back to queued on init", async () => {
    const file = path.join(userDataDir, "media-queue", "jobs.json");
    await fs.mkdir(path.dirname(file), { recursive: true });
    const crashed: MediaJob = {
      id: "job-1",
      kind: "image",
      prompt: "interrupted",
      aspectRatio: "16:9",
      status: "running",
      stage: "image",
      requestedBy: { source: "local" },
      hostedBy: "local",
      createdAt: Date.now(),
      startedAt: Date.now(),
    };
    await fs.writeFile(file, JSON.stringify([crashed]), "utf-8");

    const queue = new MediaJobQueue();
    const { deps } = makeDeps();
    queue.setDeps(deps);
    await queue.init();
    // The recovered job re-runs to completion.
    await waitFor(() => queue.list()[0]?.status === "done");
  });

  it("runs a storyboard: scenes in order → concat → soundtrack → mux", async () => {
    const queue = new MediaJobQueue();
    const { deps, generated, muxCalls, concatCalls, imported } = makeDeps({
      parseScript: async () => ({
        style: "Bright 2D cartoon",
        scenes: [
          { index: 1, title: "Intro", prompt: "coral reef", durationSec: 16 },
          {
            index: 2,
            title: "Baby Shark",
            prompt: "yellow shark",
            durationSec: 8,
          },
          {
            index: 3,
            title: "Outro",
            prompt: "the end bubbles",
            durationSec: 8,
          },
        ],
      }),
    });
    queue.setDeps(deps);

    queue.enqueue(
      {
        kind: "storyboard",
        prompt: "the full script text",
        aspectRatio: "16:9",
      },
      { source: "local" },
    );
    await waitFor(() => queue.list()[0]?.status === "done", 5_000);

    // Three video clips in scene order, style prepended, durations threaded.
    const videos = generated.filter((g) => g.modelType === "video");
    expect(videos).toHaveLength(3);
    expect(videos[0]!.prompt).toBe("Bright 2D cartoon. coral reef");
    expect(videos[1]!.prompt).toContain("yellow shark");
    expect(videos[0]!.options).toMatchObject({ duration_s: 16 });

    // Auto-edit: one concat of the three clips at the final 16:9 resolution.
    expect(concatCalls).toHaveLength(1);
    expect(concatCalls[0]!.inputs).toHaveLength(3);
    expect(concatCalls[0]).toMatchObject({ width: 1280, height: 720 });

    // One matched soundtrack over the total duration (16+8+8), then mux.
    const music = generated.filter((g) => g.modelType === "music");
    expect(music).toHaveLength(1);
    expect(music[0]!.options).toMatchObject({ duration_s: 32 });
    expect(muxCalls).toHaveLength(1);

    // One final file imported; per-scene progress all done.
    expect(imported).toHaveLength(1);
    const job = queue.list()[0]!;
    expect(job.scenes?.map((s) => s.status)).toEqual(["done", "done", "done"]);
    expect(job.outputFileNames).toHaveLength(1);
  });

  it("skips concat for a single-scene storyboard and fails cleanly on parse errors", async () => {
    const queue = new MediaJobQueue();
    const { deps, concatCalls, muxCalls } = makeDeps({
      parseScript: async (script) => {
        if (script === "bad script")
          throw new Error("Could not parse the script");
        return {
          scenes: [
            { index: 1, title: "Only", prompt: "one scene", durationSec: 5 },
          ],
        };
      },
    });
    queue.setDeps(deps);

    queue.enqueue(
      { kind: "storyboard", prompt: "bad script" },
      { source: "local" },
    );
    await waitFor(() => queue.list()[0]?.status === "failed");
    expect(queue.list()[0]!.error).toContain("Could not parse");

    queue.enqueue(
      { kind: "storyboard", prompt: "good single scene" },
      { source: "local" },
    );
    await waitFor(() =>
      queue
        .list()
        .some((j) => j.prompt === "good single scene" && j.status === "done"),
    );
    expect(concatCalls).toHaveLength(0); // single scene → no concat
    expect(muxCalls).toHaveLength(1); // soundtrack still muxed
  });

  it("applies peer status updates to mirror entries only", async () => {
    const queue = new MediaJobQueue();
    const { deps } = makeDeps();
    queue.setDeps(deps);

    const mirror: MediaJob = {
      id: "remote-1",
      kind: "video",
      prompt: "remote job",
      aspectRatio: "16:9",
      status: "queued",
      requestedBy: { source: "local" },
      hostedBy: "peer-key",
      hostLabel: "Friend · desktop",
      createdAt: Date.now(),
    };
    queue.addMirror(mirror);

    queue.applyPeerStatus({
      jobId: "remote-1",
      status: "done",
      fileNames: ["clip.mp4"],
    });
    const updated = queue.list().find((j) => j.id === "remote-1")!;
    expect(updated.status).toBe("done");
    expect(updated.outputFileNames).toEqual(["clip.mp4"]);
    expect(updated.finishedAt).toBeDefined();
  });
});
