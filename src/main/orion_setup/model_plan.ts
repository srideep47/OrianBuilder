import {
  resolveDownloadPlan,
  type OrionMediaSelection,
} from "@/shared/orion_media_catalog";
import type { MediaAiModelId } from "@/ipc/types/media_ai";

const MODEL_LABELS: Record<string, string> = {
  text: "Phi-3 mini (text)",
  image: "Stable Diffusion 1.5 (image)",
  audio: "SpeechT5 (speech)",
  video: "Text-to-video (video)",
  "image-sd-turbo": "SD Turbo (image)",
  "image-z-image-turbo": "Z-Image Turbo (image)",
  whisper: "Whisper (transcription)",
};

/**
 * Which model weights to fetch before Orion can run content jobs, given the
 * user's per-modality selection and what's already on disk.
 *
 * Built on the shared catalog's `resolveDownloadPlan` (image/speech tiers that
 * have a one-click pre-download id), plus the generic ModelScope `video`
 * weights — video tiers like LTX have no pre-download id and otherwise fetch on
 * first use, which would stall a storyboard mid-run on a multi-GB download.
 * Pure + deterministic so it can be unit-tested directly.
 */
export function planModelDownloads(
  selection: OrionMediaSelection | undefined,
  downloadedModelIds: Iterable<string>,
): { id: MediaAiModelId; label: string }[] {
  const downloaded = new Set<string>(downloadedModelIds);
  const ids = new Set<MediaAiModelId>(
    resolveDownloadPlan(selection, downloaded).models,
  );
  // Ensure a base video model is present so storyboards don't stall on a
  // first-use fetch (the LTX/Wan tiers download on demand at generation time).
  if (!downloaded.has("video")) ids.add("video");
  return [...ids].map((id) => ({ id, label: MODEL_LABELS[id] ?? id }));
}
