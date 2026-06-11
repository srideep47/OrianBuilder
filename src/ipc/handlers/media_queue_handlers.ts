/**
 * IPC + P2P wiring for the Orion media queue (see main/media_queue/queue.ts).
 *
 * - Local jobs run through the same generation seam as Orion flows: P2P
 *   placement first (a capable trusted peer may generate), then the
 *   orchestrator/dispatcher chain with the user's selected model per modality.
 * - video_audio muxing uses the media backend's ffmpeg (/v1/edit/mux).
 * - Friends' jobs arrive via MEDIA_JOB_SUBMIT (trust-gated in swarm.ts); their
 *   finished assets are auto-shared so they can download them from
 *   Library → Shared, and status flows back via MEDIA_JOB_STATUS.
 */
import crypto from "node:crypto";
import { BrowserWindow } from "electron";
import log from "electron-log";
import { createLoggedTypedHandler } from "./base";
import {
  mediaQueueContracts,
  mediaQueueEvents,
  type MediaJob,
} from "@/ipc/types/media_queue";
import { getMediaJobQueue } from "@/main/media_queue/queue";
import { createScriptParser } from "@/main/media_queue/script_parser";
import { defaultGenerateText } from "@/main/flow/pipeline_wiring";
import * as store from "@/main/generated_media/store";
import { mediaShare } from "@/main/network/media-share";
import { networkSwarm } from "@/main/network/swarm";
import type { ChannelMessage } from "@/main/network/peer-channel";
import {
  initMediaDispatcher,
  dispatchMediaGeneration,
} from "@/main/ipc/utils/media_dispatcher";
import { getOrchestrator } from "@/main/ipc/utils/model_orchestrator";
import type { MediaGenerationRequest } from "@/main/ipc/utils/model_orchestrator";
import { maybeGenerateMediaOnPeer } from "@/main/compute/media-remote";
import { getCachedHardwareProfile } from "@/main/hardware/detect";
import {
  selectProfileForVram,
  applySelectionToProfile,
  modelConfigForAsset,
} from "@/main/flow/model_profiles";
import { AUTO_TIER_ID, resolveSelection } from "@/shared/orion_media_catalog";
import { readSettings } from "@/main/settings";
import {
  MEDIA_AI_SERVER_URL,
  isMediaAiBackendHealthy,
  startMediaAiBackend,
} from "@/ipc/utils/media_ai_backend";
import { generatedMediaEvents } from "@/ipc/types/generated_media";
import type { AssetType } from "@/ipc/types/manifest";

const logger = log.scope("media-queue-handlers");
const handle = createLoggedTypedHandler(logger);

type MediaJobSubmitMessage = Extract<
  ChannelMessage,
  { type: "MEDIA_JOB_SUBMIT" }
>;
type MediaJobStatusMessage = Extract<
  ChannelMessage,
  { type: "MEDIA_JOB_STATUS" }
>;

const ASSET_TYPE_BY_MODEL: Record<string, AssetType> = {
  image: "image",
  video: "video",
  music: "music",
  audio: "speech",
};

function emitQueueChanged(): void {
  const jobs = getMediaJobQueue().list();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(mediaQueueEvents.changed.channel, { jobs });
    }
  }
}

function emitMediaChanged(): void {
  const count = store.list().length;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(generatedMediaEvents.changed.channel, { count });
    }
  }
}

/** Generation seam: P2P placement first, then orchestrator/dispatcher with the
 *  user's selected model for the modality (mirrors the flow capability path). */
async function generateForQueue(request: MediaGenerationRequest) {
  // Enrich with the selected model + best settings for this modality.
  try {
    const profile = await getCachedHardwareProfile();
    const vram = profile?.primaryGpu?.vramMb ?? 0;
    const hwProfile = applySelectionToProfile(
      selectProfileForVram(vram),
      resolveSelection(readSettings().orionMediaModels),
    );
    const assetType = ASSET_TYPE_BY_MODEL[request.modelType];
    if (assetType) {
      const cfg = modelConfigForAsset(hwProfile, assetType);
      request = {
        ...request,
        // "auto" means no forced tier — leave modelId unset so the
        // dispatcher/backend run RAM-aware selection (older peers would
        // otherwise treat the sentinel as a real tier id).
        modelId: cfg.modelId === AUTO_TIER_ID ? undefined : cfg.modelId,
        // Job-specific options (aspect-ratio dims, duration) win over defaults.
        options: { ...cfg.defaultSettings, ...request.options },
      };
    }
  } catch (err) {
    logger.warn("model profile resolution failed; using auto tiering", err);
  }

  const remote = await maybeGenerateMediaOnPeer(request).catch(() => null);
  if (remote?.success) return remote;
  if (remote) {
    logger.warn(
      `remote queue generation failed (${remote.error ?? "unknown"}); running locally`,
    );
  }

  initMediaDispatcher();
  const orch = getOrchestrator();
  if (orch.getStatus().state === "llm-loaded") {
    return orch.runMediaGeneration(request);
  }
  return dispatchMediaGeneration(request);
}

async function ensureBackendHealthy(): Promise<void> {
  if (await isMediaAiBackendHealthy()) return;
  await startMediaAiBackend();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await isMediaAiBackendHealthy()) return;
    await new Promise((r) => setTimeout(r, 750));
  }
  throw new Error(
    "Media AI backend isn't available for muxing — open the Media AI page once to complete setup.",
  );
}

async function muxForQueue(
  videoPath: string,
  audioPath: string,
  outputPath: string,
): Promise<void> {
  await ensureBackendHealthy();
  const res = await fetch(`${MEDIA_AI_SERVER_URL}/v1/edit/mux`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      video_path: videoPath,
      audio_path: audioPath,
      output_path: outputPath,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`audio mux failed (${res.status}): ${text.slice(0, 300)}`);
  }
}

async function concatForQueue(
  inputPaths: string[],
  target: { width: number; height: number; fps: number },
  outputPath: string,
  opts?: { keepAudio?: boolean },
): Promise<void> {
  await ensureBackendHealthy();
  const res = await fetch(`${MEDIA_AI_SERVER_URL}/v1/edit/concat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      input_paths: inputPaths,
      output_path: outputPath,
      mode: "reencode",
      target_width: target.width,
      target_height: target.height,
      target_fps: target.fps,
      // Carry the clips' synced audio (AV models) through the re-encode.
      keep_audio: opts?.keepAudio === true,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `clip assembly failed (${res.status}): ${text.slice(0, 300)}`,
    );
  }
}

async function importToStore(
  srcPath: string,
  opts: { prompt: string; share: boolean },
): Promise<string> {
  const item = await store.saveFromPath(srcPath, {
    prompt: opts.prompt,
    promptOrStem: opts.prompt,
  });
  if (opts.share) {
    store.setShared(item.fileName, true);
    mediaShare.announceToAll();
  }
  emitMediaChanged();
  return item.fileName;
}

function onJobUpdate(job: MediaJob): void {
  emitQueueChanged();
  // Push status back to the friend who submitted this job.
  if (
    job.hostedBy === "local" &&
    job.requestedBy.source === "peer" &&
    job.requestedBy.peerKey
  ) {
    networkSwarm.sendMediaJobStatus(job.requestedBy.peerKey, {
      type: "MEDIA_JOB_STATUS",
      jobId: job.id,
      status: job.status,
      stage: job.stage,
      error: job.error,
      fileNames: job.outputFileNames,
    });
  }
}

// ── Entry points called from swarm.ts (trust-gated there) ────────────────────

/** A trusted friend submitted a job to OUR queue. */
export function handlePeerJobSubmit(
  peerKey: string,
  displayName: string,
  msg: MediaJobSubmitMessage,
): void {
  const queue = getMediaJobQueue();
  logger.info(
    `peer job from ${displayName} (${peerKey.slice(0, 12)}…): ${msg.kind} "${msg.prompt.slice(0, 60)}"`,
  );
  queue.enqueue(
    {
      kind: msg.kind,
      prompt: msg.prompt,
      audioPrompt: msg.audioPrompt,
      audioKind: msg.audioKind,
      aspectRatio: msg.aspectRatio,
      durationSec: msg.durationSec,
    },
    { source: "peer", peerKey, displayName },
    msg.jobId,
  );
}

/** A host device reported progress on a job WE submitted to them. */
export function handlePeerJobStatus(msg: MediaJobStatusMessage): void {
  getMediaJobQueue().applyPeerStatus({
    jobId: msg.jobId,
    status: msg.status,
    stage: msg.stage,
    error: msg.error,
    fileNames: msg.fileNames,
  });
}

// ── Registration ──────────────────────────────────────────────────────────────

export function registerMediaQueueHandlers(): void {
  const queue = getMediaJobQueue();
  queue.setDeps({
    generate: generateForQueue,
    mux: muxForQueue,
    concat: concatForQueue,
    parseScript: createScriptParser(defaultGenerateText),
    importToStore,
    onJobUpdate,
  });
  void queue.init();

  handle(mediaQueueContracts.enqueue, async (_e, params) => {
    if (params.targetPeerId) {
      // Submit to a friend's queue; track a mirror entry locally.
      const peer = networkSwarm
        .getStatus()
        .peers.find((p) => p.publicKey === params.targetPeerId);
      if (!peer || !peer.isTrusted || peer.status !== "online") {
        throw new Error(
          "That device isn't connected right now — pick another or run locally.",
        );
      }
      const jobId = crypto.randomUUID();
      const sent = networkSwarm.sendMediaJobSubmit(params.targetPeerId, {
        type: "MEDIA_JOB_SUBMIT",
        jobId,
        kind: params.kind,
        prompt: params.prompt,
        audioPrompt: params.audioPrompt,
        audioKind: params.audioKind,
        aspectRatio: params.aspectRatio,
        durationSec: params.durationSec,
      });
      if (!sent) {
        throw new Error("Couldn't reach that device — try again.");
      }
      const mirror: MediaJob = {
        id: jobId,
        kind: params.kind,
        prompt: params.prompt,
        audioPrompt: params.audioPrompt,
        audioKind: params.audioKind,
        aspectRatio: params.aspectRatio ?? "16:9",
        durationSec: params.durationSec,
        status: "queued",
        requestedBy: { source: "local" },
        hostedBy: params.targetPeerId,
        hostLabel: `${peer.displayName} · ${peer.deviceName}`,
        createdAt: Date.now(),
      };
      queue.addMirror(mirror);
      return mirror;
    }
    return queue.enqueue(params, { source: "local" });
  });

  handle(mediaQueueContracts.list, async () => queue.list());

  handle(mediaQueueContracts.cancel, async (_e, { jobId }) => ({
    ok: queue.cancel(jobId),
  }));

  handle(mediaQueueContracts.retry, async (_e, { jobId }) => ({
    ok: queue.retry(jobId),
  }));

  handle(mediaQueueContracts.remove, async (_e, { jobId }) => ({
    ok: queue.remove(jobId),
  }));
}
