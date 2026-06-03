/**
 * Uploads a video from the generated-media store to YouTube via the Data API
 * v3 resumable upload protocol.
 *
 * Flow:
 *   1. POST .../upload/youtube/v3/videos?uploadType=resumable with the snippet +
 *      status metadata. Google replies with a session URL in the Location header.
 *   2. PUT the file bytes to that session URL in chunks, using Content-Range so
 *      we can report progress. A 308 means "keep going"; 200/201 means done.
 *
 * Only video files are supported (YouTube is video-only).
 */
import { net } from "electron";
import log from "electron-log/main";
import * as store from "@/main/generated_media/store";
import { getValidAccessToken } from "./youtube-oauth";

const logger = log.scope("youtube-publish");

const VIDEOS_ENDPOINT =
  "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status";

// 8 MB chunks — large enough to be efficient, small enough for smooth progress.
const CHUNK_SIZE = 8 * 1024 * 1024;

export type YouTubePrivacy = "public" | "unlisted" | "private";

export interface PublishOptions {
  fileName: string;
  title: string;
  description?: string;
  privacy: YouTubePrivacy;
  tags?: string[];
  /** Called with an integer 0–100 as bytes are uploaded. */
  onProgress?: (percent: number) => void;
}

export interface PublishResult {
  videoId: string;
  url: string;
}

export async function publishVideo(
  opts: PublishOptions,
): Promise<PublishResult> {
  const item = store.statItem(opts.fileName);
  if (item.kind !== "video") {
    throw new Error("Only videos can be published to YouTube.");
  }

  const accessToken = await getValidAccessToken();
  const bytes = store.readFileBytes(opts.fileName);
  const total = bytes.length;
  if (total === 0) throw new Error("Video file is empty.");

  // 1. Open the resumable session.
  const initRes = await net.fetch(VIDEOS_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=utf-8",
      "X-Upload-Content-Length": String(total),
      "X-Upload-Content-Type": item.mimeType,
    },
    body: JSON.stringify({
      snippet: {
        title: opts.title.slice(0, 100) || "Untitled",
        description: (opts.description ?? "").slice(0, 5000),
        tags: opts.tags?.slice(0, 30),
      },
      status: {
        privacyStatus: opts.privacy,
        selfDeclaredMadeForKids: false,
      },
    }),
  });

  if (!initRes.ok) {
    const detail = await initRes.text().catch(() => "");
    throw new Error(
      `Failed to start YouTube upload (${initRes.status}): ${detail.slice(0, 500)}`,
    );
  }
  const sessionUrl = initRes.headers.get("location");
  if (!sessionUrl) {
    throw new Error("YouTube did not return an upload session URL.");
  }

  // 2. Upload the bytes in chunks.
  let offset = 0;
  opts.onProgress?.(0);
  while (offset < total) {
    const end = Math.min(offset + CHUNK_SIZE, total);
    const chunk = bytes.subarray(offset, end);
    // Wrap as a Blob — universally accepted by Electron's net.fetch as BodyInit.
    // Blob automatically sets Content-Length so we don't need to set it manually
    // (manually setting Content-Length is a forbidden header in the Fetch spec
    // and causes ERR_INVALID_ARGUMENT in Chromium/Electron).
    // Copy into a clean ArrayBuffer first to avoid the SharedArrayBuffer/ArrayBuffer
    // type mismatch that Node Buffer<ArrayBufferLike> causes with strict TS.
    const ab = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer;
    const body = new Blob([ab], { type: item.mimeType });
    const res = await net.fetch(sessionUrl, {
      method: "PUT",
      headers: {
        "Content-Range": `bytes ${offset}-${end - 1}/${total}`,
        "Content-Type": item.mimeType,
      },
      body,
    });

    if (res.status === 308) {
      // Resume Incomplete — Google acks via the Range header. Continue from
      // there (defensively trust our own offset if the header is absent).
      const range = res.headers.get("range");
      const nextByte = range ? Number(range.split("-")[1]) + 1 : end;
      offset = Number.isFinite(nextByte) ? nextByte : end;
      opts.onProgress?.(Math.floor((offset / total) * 100));
      continue;
    }

    if (res.status === 200 || res.status === 201) {
      const data = (await res.json()) as { id?: string };
      if (!data.id) throw new Error("YouTube upload finished without a video ID.");
      opts.onProgress?.(100);
      logger.info(`Published video ${data.id} (${opts.title})`);
      return {
        videoId: data.id,
        url: `https://www.youtube.com/watch?v=${data.id}`,
      };
    }

    const detail = await res.text().catch(() => "");
    throw new Error(
      `YouTube upload failed (${res.status}): ${detail.slice(0, 500)}`,
    );
  }

  throw new Error("YouTube upload ended unexpectedly before completion.");
}
