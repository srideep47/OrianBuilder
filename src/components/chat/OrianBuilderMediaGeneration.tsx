import type React from "react";
import { useMemo, useState, type ReactNode } from "react";
import {
  Check,
  Copy,
  FileBox,
  FolderOpen,
  Image as ImageIcon,
  Loader2,
  Music,
  Video,
} from "lucide-react";
import { useAtomValue } from "jotai";
import { currentAppAtom } from "@/atoms/appAtoms";
import { ipc } from "@/ipc/types";
import { CustomTagState } from "./stateTypes";

interface OrianBuilderMediaGenerationNode {
  properties: {
    kind?: string;
    prompt?: string;
    path?: string;
    absolutePath?: string;
    mimeType?: string;
    durationMs?: string;
    state?: CustomTagState;
  };
}

interface OrianBuilderMediaGenerationProps {
  children?: ReactNode;
  node?: OrianBuilderMediaGenerationNode;
}

function buildMediaUrl(appPath: string, relPath: string): string {
  const normalized = relPath.split("\\").join("/");
  const hasTraversal = normalized.split("/").some((seg) => seg === "..");
  if (!appPath || !normalized || hasTraversal) return "";
  return `orian-media://media/${encodeURIComponent(appPath)}/${normalized
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

function titleForKind(kind: string): string {
  if (kind === "model") return "3D model";
  return kind ? `${kind[0].toUpperCase()}${kind.slice(1)}` : "Media";
}

/** Rich, full-width session result for every Orion media modality. */
export const OrianBuilderMediaGeneration: React.FC<
  OrianBuilderMediaGenerationProps
> = ({ node }) => {
  const kind = (node?.properties?.kind ?? "").toLowerCase();
  const prompt = node?.properties?.prompt ?? "";
  const relPath = node?.properties?.path ?? "";
  const absolutePath = node?.properties?.absolutePath ?? "";
  const durationMs = Number(node?.properties?.durationMs || 0);
  const state = node?.properties?.state;
  const inProgress = state === "pending";
  const aborted = state === "aborted";
  const [mediaError, setMediaError] = useState(false);
  const [copied, setCopied] = useState(false);

  const app = useAtomValue(currentAppAtom);
  const appPath = app?.resolvedPath ?? app?.path ?? "";
  const url = useMemo(
    () => buildMediaUrl(appPath, relPath),
    [appPath, relPath],
  );

  if (inProgress) {
    return (
      <div className="my-3 flex max-w-3xl items-center gap-2 rounded-2xl border border-border bg-card/55 px-4 py-3 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin text-primary" />
        Generating {kind || "media"} locally…
      </div>
    );
  }

  if (aborted || !url || mediaError) {
    return (
      <div className="my-3 max-w-3xl rounded-2xl border border-border bg-card/55 px-4 py-3 text-sm text-muted-foreground">
        <span className="font-medium text-foreground">
          {titleForKind(kind)} result
        </span>
        {prompt && <span className="ml-1">— {prompt}</span>}
        <div className="mt-1 text-xs">
          {aborted
            ? "Generation did not finish."
            : "The generated file could not be loaded."}
        </div>
      </div>
    );
  }

  const KindIcon =
    kind === "video"
      ? Video
      : kind === "audio"
        ? Music
        : kind === "model"
          ? FileBox
          : ImageIcon;

  const copyPath = async () => {
    await navigator.clipboard.writeText(absolutePath || relPath);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  return (
    <article className="my-4 w-full max-w-3xl overflow-hidden rounded-[22px] border border-border bg-card/65 shadow-[0_16px_50px_rgba(0,0,0,0.16)]">
      <header className="flex items-start gap-3 border-b border-border/70 px-4 py-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary">
          <KindIcon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-foreground">
              Generated {titleForKind(kind)}
            </h3>
            <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-300">
              ready
            </span>
            {durationMs > 0 && (
              <span className="text-[10px] text-muted-foreground">
                {(durationMs / 1000).toFixed(1)}s
              </span>
            )}
          </div>
          <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
            {prompt || `Generated ${kind}`}
          </p>
        </div>
      </header>

      <div className="bg-black/35">
        {kind === "video" ? (
          <video
            src={url}
            controls
            className="max-h-[560px] w-full bg-black object-contain"
            onError={() => setMediaError(true)}
          />
        ) : kind === "audio" ? (
          <div className="flex min-h-36 items-center bg-gradient-to-br from-primary/15 via-background/40 to-background/80 p-5">
            <audio
              src={url}
              controls
              className="w-full"
              onError={() => setMediaError(true)}
            />
          </div>
        ) : kind === "model" ? (
          <a
            href={url}
            download
            className="flex min-h-44 flex-col items-center justify-center gap-3 bg-gradient-to-br from-primary/12 to-background/70 p-6 text-foreground transition-colors hover:from-primary/18"
          >
            <span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-primary/25 bg-primary/12 text-primary">
              <FileBox className="h-7 w-7" />
            </span>
            <span className="text-sm font-medium">
              Download and open the GLB model
            </span>
            <span className="text-xs text-muted-foreground">
              Ready for Godot, Blender, or the current project
            </span>
          </a>
        ) : (
          <img
            src={url}
            alt={prompt || "Generated media"}
            className="max-h-[680px] w-full object-contain"
            onError={() => setMediaError(true)}
          />
        )}
      </div>

      <footer className="flex flex-wrap items-center gap-1.5 border-t border-border/70 px-3 py-2.5">
        {absolutePath && (
          <button
            type="button"
            onClick={() => void ipc.system.showItemInFolder(absolutePath)}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            <FolderOpen className="h-3.5 w-3.5" /> Show in folder
          </button>
        )}
        <button
          type="button"
          onClick={() => void copyPath()}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-emerald-400" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
          {copied ? "Copied" : "Copy path"}
        </button>
        <span className="ml-auto truncate text-[10px] text-muted-foreground/70">
          Saved to this session and Media Library
        </span>
      </footer>
    </article>
  );
};
