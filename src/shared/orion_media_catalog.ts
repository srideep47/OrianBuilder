/**
 * Curated, pre-downloadable media-model catalog for the Orion Factory config box.
 *
 * Pure data + helpers shared by the renderer (the selection UI on the Apps
 * screen) and the main process (pre-download planning + profile override in the
 * pipeline). NO node-only imports — safe to import from both sides.
 *
 * Only models that the backend can pre-download (or install as a runtime) are
 * listed here, by design (curated set). The richer tier catalog lives in
 * `media_tiers.ts`; this is the subset we expose for explicit selection.
 */

import type { MediaAiModelId } from "@/ipc/types/media_ai";

/** Modalities the user can configure. "threed" matches the settings key. */
export type OrionModality = "image" | "video" | "music" | "speech" | "threed";

export interface OrionModelOption {
  /** Tier id used at generation time (threaded into MediaGenerationRequest). */
  tierId: string;
  label: string;
  /**
   * Backend model id for one-click pre-download via `downloadModels`. Only set
   * when the download id actually fetches THIS model — otherwise the model is
   * downloaded on demand at generation time (see `ltx-video`, whose only enum
   * download id maps to a different model).
   */
  downloadId?: MediaAiModelId;
  /** When set, this model is a pip/runtime install (no per-weight download id);
   *  it ships with the media backend setup and fetches weights on first use. */
  runtimeInstall?: "3d" | "music";
  /** Approximate on-disk size, for the UI badge. */
  sizeLabel: string;
}

/** Sentinel tier id meaning "let the hardware profile / backend pick". The
 *  profile override step skips it, so each device keeps its hardware-matched
 *  default instead of everyone being forced onto one model. */
export const AUTO_TIER_ID = "auto";

// tierId values MUST match the backend tier ids the generators load via
// `forced_tier_id`:
//   image  → mediaai-backend/.../models/image.py  IMAGE_MODEL_TIERS
//   video  → models/video.py  VIDEO_TIERS
//   music  → models/music.py  MUSIC_TIERS
//   speech → models/tts.py    TTS_TIERS
//   3d     → models/threed.py THREED_TIERS
// First entry per modality is the default — "Auto" everywhere a hardware-matched
// choice exists, so a 4 GB laptop never gets a 12 GB model forced on it. Only
// the two image tiers and SpeechT5 have a one-click pre-download id; everything
// else downloads on first use.
export const ORION_MEDIA_CATALOG: Record<OrionModality, OrionModelOption[]> = {
  image: [
    { tierId: AUTO_TIER_ID, label: "Auto (match this device)", sizeLabel: "—" },
    {
      tierId: "z-image-turbo",
      label: "Z Image Turbo",
      downloadId: "image-z-image-turbo",
      sizeLabel: "12 GB",
    },
    {
      tierId: "sd-turbo",
      label: "SD Turbo",
      downloadId: "image-sd-turbo",
      sizeLabel: "1.7 GB",
    },
    { tierId: "sdxl-turbo", label: "SDXL Turbo", sizeLabel: "7 GB" },
    { tierId: "sd-1.5", label: "Stable Diffusion 1.5", sizeLabel: "4 GB" },
    {
      tierId: "z-image-turbo-gguf",
      label: "Z Image Turbo Q4 (GGUF)",
      sizeLabel: "5 GB",
    },
    {
      tierId: "sd-1.5-onnx-cpu",
      label: "SD 1.5 ONNX (CPU)",
      sizeLabel: "2.5 GB",
    },
  ],
  video: [
    // The "video" download id pre-fetches whatever tier the backend picks for
    // this machine; explicit tiers below download on first use.
    { tierId: AUTO_TIER_ID, label: "Auto (match this device)", sizeLabel: "—" },
    {
      tierId: "wan-2.2-i2v",
      label: "Wan 2.2 14B (best, image-to-video)",
      sizeLabel: "~31 GB",
    },
    {
      tierId: "ltx-2-av-small",
      label: "LTX-2.3 (synced audio+video)",
      sizeLabel: "~16.7 GB GGUF",
    },
    {
      tierId: "ltx-video",
      label: "LTX Video (top, no audio)",
      sizeLabel: "18 GB",
    },
    {
      tierId: "wan-2.2-5b",
      label: "Wan 2.2 5B (small GPU)",
      sizeLabel: "~15 GB",
    },
    {
      tierId: "animatediff-sd15",
      label: "AnimateDiff + SD 1.5 (mid)",
      sizeLabel: "6 GB",
    },
    {
      tierId: "animatediff-sd15-small",
      label: "AnimateDiff + SD 1.5 (small)",
      sizeLabel: "6 GB",
    },
    {
      tierId: "text-to-video-cpu",
      label: "Text-to-Video MS (CPU)",
      sizeLabel: "8 GB",
    },
  ],
  music: [
    { tierId: AUTO_TIER_ID, label: "Auto (match this device)", sizeLabel: "—" },
    {
      tierId: "ace-step-xl-turbo-12gb",
      label: "ACE-Step 1.5 XL Turbo (12 GB)",
      runtimeInstall: "music",
      sizeLabel: "~12 GB",
    },
    {
      tierId: "ace-step-turbo-4gb",
      label: "ACE-Step 1.5 Turbo (4 GB)",
      runtimeInstall: "music",
      sizeLabel: "~4 GB",
    },
  ],
  speech: [
    {
      tierId: "speecht5-cpu",
      label: "SpeechT5 (CPU)",
      downloadId: "audio",
      sizeLabel: "600 MB",
    },
    { tierId: "kokoro-82m", label: "Kokoro 82M", sizeLabel: "350 MB" },
    { tierId: "xtts-v2", label: "XTTS v2", sizeLabel: "1.9 GB" },
    { tierId: "f5-tts", label: "F5-TTS", sizeLabel: "5 GB" },
    { tierId: "piper", label: "Piper TTS (CPU)", sizeLabel: "60 MB" },
  ],
  threed: [
    {
      // TripoSR is currently the only image-to-3D model the backend ships.
      tierId: "triposr-6gb",
      label: "TripoSR (6 GB)",
      runtimeInstall: "3d",
      sizeLabel: "1.7 GB",
    },
  ],
};

export const ORION_MODALITIES: readonly OrionModality[] = [
  "image",
  "video",
  "music",
  "speech",
  "threed",
] as const;

/** User selection of one model per modality (tier ids). */
export interface OrionMediaSelection {
  image?: string;
  video?: string;
  music?: string;
  speech?: string;
  threed?: string;
}

/** The first (best) option per modality — the implicit default. */
export function defaultSelection(): Required<OrionMediaSelection> {
  return {
    image: ORION_MEDIA_CATALOG.image[0].tierId,
    video: ORION_MEDIA_CATALOG.video[0].tierId,
    music: ORION_MEDIA_CATALOG.music[0].tierId,
    speech: ORION_MEDIA_CATALOG.speech[0].tierId,
    threed: ORION_MEDIA_CATALOG.threed[0].tierId,
  };
}

/** Merge a (partial) saved selection over the defaults, ignoring any saved id
 *  that is no longer a valid option for its modality (e.g. an old/renamed tier
 *  id) so the dropdown never lands on an unknown value. */
export function resolveSelection(
  saved: OrionMediaSelection | undefined,
): Required<OrionMediaSelection> {
  const out = defaultSelection();
  if (saved) {
    for (const modality of ORION_MODALITIES) {
      const id = saved[modality];
      if (id && findOption(modality, id)) {
        out[modality] = id;
      }
    }
  }
  return out;
}

export function findOption(
  modality: OrionModality,
  tierId: string | undefined,
): OrionModelOption | undefined {
  if (!tierId) return undefined;
  return ORION_MEDIA_CATALOG[modality].find((o) => o.tierId === tierId);
}

export interface DownloadPlan {
  /** Backend model ids to fetch before the run (weights with a download id). */
  models: MediaAiModelId[];
  /** Runtime installs the selection needs (best-effort; not auto-pip-installed
   *  mid-run — surfaced so the caller/UI can act). */
  runtimes: ("3d" | "music")[];
}

/**
 * Given the user's selection and the set of already-downloaded backend model
 * ids, return what still needs fetching before a Factory run. Pure.
 */
export function resolveDownloadPlan(
  saved: OrionMediaSelection | undefined,
  downloadedModelIds: ReadonlySet<string>,
  modalities: readonly OrionModality[] = ORION_MODALITIES,
): DownloadPlan {
  const selection = resolveSelection(saved);
  const models: MediaAiModelId[] = [];
  const runtimes: ("3d" | "music")[] = [];

  for (const modality of modalities) {
    const opt = findOption(modality, selection[modality]);
    if (!opt) continue;
    if (opt.downloadId) {
      if (!downloadedModelIds.has(opt.downloadId)) models.push(opt.downloadId);
    } else if (opt.runtimeInstall) {
      runtimes.push(opt.runtimeInstall);
    }
  }
  return { models, runtimes };
}
