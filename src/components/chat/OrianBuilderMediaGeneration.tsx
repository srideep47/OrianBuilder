import type React from "react";
import { useMemo, useState, type ReactNode } from "react";
import { FileBox, Loader2, Music, Video } from "lucide-react";
import { useAtomValue } from "jotai";
import { currentAppAtom } from "@/atoms/appAtoms";
import { CustomTagState } from "./stateTypes";

interface OrianBuilderMediaGenerationNode {
  properties: {
    kind?: string;
    prompt?: string;
    path?: string;
    mimeType?: string;
    state?: CustomTagState;
  };
}

interface OrianBuilderMediaGenerationProps {
  children?: ReactNode;
  node?: OrianBuilderMediaGenerationNode;
}

/** Build an orian-media:// URL for a path relative to the current app dir. */
function buildMediaUrl(appPath: string, relPath: string): string {
  const normalized = relPath.split("\\").join("/");
  const hasTraversal = normalized.split("/").some((seg) => seg === "..");
  if (!appPath || !normalized || hasTraversal) return "";
  return `orian-media://media/${encodeURIComponent(appPath)}/${normalized
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

/**
 * Renders a generated media asset (video / audio / image / 3D model) inline in
 * chat — ChatGPT-style — resolving the file over the orian-media:// protocol
 * from the current app's path + the relative path in the tag. Used by Orion's
 * media replies and the local-agent `generate_media_asset` tool output.
 */
export const OrianBuilderMediaGeneration: React.FC<
  OrianBuilderMediaGenerationProps
> = ({ node }) => {
  const kind = (node?.properties?.kind ?? "").toLowerCase();
  const prompt = node?.properties?.prompt ?? "";
  const relPath = node?.properties?.path ?? "";
  const state = node?.properties?.state;
  const inProgress = state === "pending";
  const aborted = state === "aborted";
  const [mediaError, setMediaError] = useState(false);

  const app = useAtomValue(currentAppAtom);
  const appPath = app?.resolvedPath ?? app?.path ?? "";
  const url = useMemo(
    () => buildMediaUrl(appPath, relPath),
    [appPath, relPath],
  );

  const caption = (
    <div className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
      {kind === "video" ? (
        <Video size={12} />
      ) : kind === "audio" ? (
        <Music size={12} />
      ) : kind === "model" ? (
        <FileBox size={12} />
      ) : null}
      <span className="italic truncate">{prompt || `Generated ${kind}`}</span>
    </div>
  );

  if (inProgress) {
    return (
      <div className="my-2 flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 size={14} className="animate-spin" />
        Generating {kind || "media"}…
      </div>
    );
  }

  if (aborted || !url || mediaError) {
    return (
      <div className="my-2 rounded-3xl border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
        <span className="font-medium text-foreground">
          {kind ? `Generated ${kind}` : "Generated media"}
        </span>
        {prompt && <span className="ml-1 italic">— {prompt}</span>}
        {(aborted || mediaError) && (
          <div className="mt-0.5 text-xs">
            {aborted ? "Did not finish." : "Could not load the media file."}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="my-2 max-w-md">
      {kind === "video" ? (
        <video
          src={url}
          controls
          className="w-full rounded-3xl border border-border"
          onError={() => setMediaError(true)}
        />
      ) : kind === "audio" ? (
        <audio
          src={url}
          controls
          className="w-full"
          onError={() => setMediaError(true)}
        />
      ) : kind === "model" ? (
        <a
          href={url}
          download
          className="flex items-center gap-2 rounded-3xl border border-border bg-muted/30 px-3 py-2.5 text-sm text-foreground transition-colors hover:bg-muted/50"
        >
          <FileBox size={16} className="text-indigo-400" />
          <span className="flex-1 truncate">{prompt || "3D model"}</span>
          <span className="text-xs text-muted-foreground">Download .glb</span>
        </a>
      ) : (
        <img
          src={url}
          alt={prompt || "Generated media"}
          className="w-full rounded-3xl border border-border object-contain"
          onError={() => setMediaError(true)}
        />
      )}
      {caption}
    </div>
  );
};
