import type { MediaReplyAsset } from "@/ipc/types/intent";

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Build the persisted assistant message rendered by the shared chat parser. */
export function formatOrionMediaReply(
  command: string,
  assets: MediaReplyAsset[],
): string {
  const parts: string[] = [];
  for (const asset of assets) {
    if (asset.error || !asset.relativePath) {
      parts.push(
        `Couldn't generate ${asset.kind}${asset.error ? `: ${asset.error}` : ""}.` +
          (asset.setupRoute
            ? " Set up the local media runtime, then try again."
            : ""),
      );
      continue;
    }
    parts.push(
      `<orianbuilder-media-generation kind="${escapeAttribute(asset.kind)}" prompt="${escapeAttribute(asset.prompt)}" path="${escapeAttribute(asset.relativePath)}" absolute-path="${escapeAttribute(asset.absolutePath ?? "")}" mime-type="${escapeAttribute(asset.mimeType)}" duration-ms="${asset.durationMs ?? ""}" state="finished"></orianbuilder-media-generation>`,
    );
  }
  return parts.length
    ? parts.join("\n\n")
    : `No media was generated for: ${command}`;
}
