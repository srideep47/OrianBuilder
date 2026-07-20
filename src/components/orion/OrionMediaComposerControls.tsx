import { useMemo, useState } from "react";
import {
  Box,
  ChevronDown,
  ChevronUp,
  Image as ImageIcon,
  Music,
  SlidersHorizontal,
  Sparkles,
  Video,
  Volume2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  ORION_MEDIA_CATALOG,
  type OrionMediaSelection,
  type OrionModality,
} from "@/shared/orion_media_catalog";
import { USER_FACING_IMAGE_TIERS } from "@/shared/media_tiers";

export type OrionMediaKind = "image" | "video" | "music" | "speech" | "threed";
export type OrionMediaQuality = "draft" | "balanced" | "quality";

export interface OrionMediaRecipe {
  kind: OrionMediaKind;
  quality: OrionMediaQuality;
  aspectRatio: "1:1" | "16:9" | "9:16" | "4:3" | "3:4";
  width: number;
  height: number;
  steps: number;
  guidance: number;
  durationSeconds: number;
  variations: number;
  seed: number | null;
  negativePrompt: string;
}

export const DEFAULT_MEDIA_RECIPE: OrionMediaRecipe = {
  kind: "image",
  quality: "balanced",
  aspectRatio: "1:1",
  width: 768,
  height: 768,
  steps: 6,
  guidance: 4,
  durationSeconds: 8,
  variations: 1,
  seed: null,
  negativePrompt: "",
};

const KIND_OPTIONS: ReadonlyArray<{
  kind: OrionMediaKind;
  label: string;
  icon: typeof ImageIcon;
}> = [
  { kind: "image", label: "Image", icon: ImageIcon },
  { kind: "video", label: "Video", icon: Video },
  { kind: "music", label: "Music", icon: Music },
  { kind: "speech", label: "Speech", icon: Volume2 },
  { kind: "threed", label: "3D", icon: Box },
];

const QUALITY_STEPS: Record<OrionMediaQuality, number> = {
  draft: 4,
  balanced: 6,
  quality: 8,
};

function kindToModality(kind: OrionMediaKind): OrionModality {
  return kind;
}

function recipeNodes(kind: OrionMediaKind, quality: OrionMediaQuality) {
  const output = kind === "threed" ? "GLB" : kind === "image" ? "Image" : kind;
  return ["Prompt", "Recipe", `Generate ${kind}`, `${quality} profile`, output];
}

interface OrionMediaComposerControlsProps {
  value: OrionMediaRecipe;
  selection: Required<OrionMediaSelection>;
  onChange: (next: OrionMediaRecipe) => void;
  onSelectionChange: (next: Required<OrionMediaSelection>) => void;
  disabled?: boolean;
  defaultExpanded?: boolean;
}

/**
 * Model-aware media controls for Orion's single command surface. The catalog is
 * renderer-safe, so every option is visible before the Python backend starts.
 * The compact node strip is the first UI for the media recipe/graph contract;
 * it describes the actual ordered work rather than exposing backend lifecycle.
 */
export function OrionMediaComposerControls({
  value,
  selection,
  onChange,
  onSelectionChange,
  disabled = false,
  defaultExpanded = true,
}: OrionMediaComposerControlsProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const modality = kindToModality(value.kind);
  const selectedTier = selection[modality];
  const modelOptions = ORION_MEDIA_CATALOG[modality];
  const imageTier = useMemo(
    () => USER_FACING_IMAGE_TIERS.find((tier) => tier.tierId === selectedTier),
    [selectedTier],
  );
  const nodes = recipeNodes(value.kind, value.quality);

  const patch = (changes: Partial<OrionMediaRecipe>) =>
    onChange({ ...value, ...changes });

  const selectKind = (kind: OrionMediaKind) => {
    if (kind === value.kind) return;
    if (kind === "image") {
      patch({ kind, aspectRatio: "1:1", width: 768, height: 768 });
    } else if (kind === "video") {
      patch({ kind, aspectRatio: "16:9", variations: 1 });
    } else {
      patch({ kind, variations: 1 });
    }
  };

  const applyQuality = (quality: OrionMediaQuality) => {
    const preset = imageTier?.qualityPresets.find((candidate) =>
      candidate.label.toLowerCase().startsWith(quality),
    );
    patch({
      quality,
      steps: preset?.steps ?? QUALITY_STEPS[quality],
      guidance: preset?.guidance ?? value.guidance,
    });
  };

  const selectModel = (tierId: string) => {
    onSelectionChange({ ...selection, [modality]: tierId });
    if (value.kind !== "image") return;
    const nextTier = USER_FACING_IMAGE_TIERS.find(
      (tier) => tier.tierId === tierId,
    );
    if (!nextTier) return;
    patch({
      width: nextTier.defaultWidth,
      height: nextTier.defaultHeight,
      steps: nextTier.defaultSteps,
      guidance: nextTier.defaultGuidance,
    });
  };

  return (
    <section className="mt-3 overflow-hidden rounded-2xl border border-border/70 bg-background/35">
      <button
        type="button"
        onClick={() => setExpanded((open) => !open)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-muted/35"
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-xl bg-primary/12 text-primary">
          <SlidersHorizontal className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-semibold text-foreground">
            Media recipe
          </span>
          <span className="block truncate text-[11px] text-muted-foreground">
            {value.kind} ·{" "}
            {modelOptions.find((model) => model.tierId === selectedTier)?.label}
          </span>
        </span>
        <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-300">
          local first
        </span>
        {expanded ? (
          <ChevronUp className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        )}
      </button>

      {expanded && (
        <div className="border-t border-border/60 p-3">
          <div className="grid grid-cols-5 gap-1 rounded-xl bg-muted/30 p-1">
            {KIND_OPTIONS.map(({ kind, label, icon: Icon }) => (
              <button
                key={kind}
                type="button"
                disabled={disabled}
                onClick={() => selectKind(kind)}
                className={cn(
                  "flex min-w-0 items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-xs font-medium transition-colors",
                  value.kind === kind
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
                )}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" />
                <span className="hidden sm:inline">{label}</span>
              </button>
            ))}
          </div>

          <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <label className="space-y-1.5 text-[11px] font-medium text-muted-foreground md:col-span-2">
              Model
              <select
                value={selectedTier}
                disabled={disabled}
                onChange={(event) => selectModel(event.target.value)}
                className="h-9 w-full rounded-xl border border-border bg-background/70 px-3 text-xs text-foreground outline-none focus:border-primary/60"
              >
                {modelOptions.map((model) => (
                  <option key={model.tierId} value={model.tierId}>
                    {model.label} · {model.sizeLabel}
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-1.5 text-[11px] font-medium text-muted-foreground">
              Quality
              <select
                value={value.quality}
                disabled={disabled}
                onChange={(event) =>
                  applyQuality(event.target.value as OrionMediaQuality)
                }
                className="h-9 w-full rounded-xl border border-border bg-background/70 px-3 text-xs text-foreground outline-none focus:border-primary/60"
              >
                <option value="draft">Draft · fastest</option>
                <option value="balanced">Balanced</option>
                <option value="quality">Quality · slower</option>
              </select>
            </label>

            {value.kind === "image" || value.kind === "video" ? (
              <label className="space-y-1.5 text-[11px] font-medium text-muted-foreground">
                Canvas
                <select
                  value={value.aspectRatio}
                  disabled={disabled}
                  onChange={(event) =>
                    patch({
                      aspectRatio: event.target
                        .value as OrionMediaRecipe["aspectRatio"],
                    })
                  }
                  className="h-9 w-full rounded-xl border border-border bg-background/70 px-3 text-xs text-foreground outline-none focus:border-primary/60"
                >
                  <option value="1:1">Square · 1:1</option>
                  <option value="16:9">Landscape · 16:9</option>
                  <option value="9:16">Portrait · 9:16</option>
                  <option value="4:3">Classic · 4:3</option>
                  <option value="3:4">Portrait · 3:4</option>
                </select>
              </label>
            ) : (
              <label className="space-y-1.5 text-[11px] font-medium text-muted-foreground">
                Duration
                <input
                  type="number"
                  min={1}
                  max={value.kind === "music" ? 180 : 60}
                  value={value.durationSeconds}
                  disabled={disabled}
                  onChange={(event) =>
                    patch({ durationSeconds: Number(event.target.value) || 1 })
                  }
                  className="h-9 w-full rounded-xl border border-border bg-background/70 px-3 text-xs text-foreground outline-none focus:border-primary/60"
                />
              </label>
            )}
          </div>

          <details className="mt-3 rounded-xl border border-border/60 bg-muted/15">
            <summary className="cursor-pointer list-none px-3 py-2 text-xs font-medium text-foreground">
              Advanced controls
              <span className="ml-2 font-normal text-muted-foreground">
                seed, sampling, variations, negative prompt
              </span>
            </summary>
            <div className="grid gap-3 border-t border-border/50 p-3 sm:grid-cols-2 lg:grid-cols-4">
              {(value.kind === "image" || value.kind === "video") && (
                <label className="space-y-1 text-[11px] text-muted-foreground">
                  Sampling steps · {value.steps}
                  <input
                    type="range"
                    min={imageTier?.minSteps ?? 1}
                    max={
                      imageTier?.maxSteps ?? (value.kind === "video" ? 50 : 30)
                    }
                    value={value.steps}
                    disabled={disabled}
                    onChange={(event) =>
                      patch({ steps: Number(event.target.value) })
                    }
                    className="block w-full accent-primary"
                  />
                </label>
              )}
              {value.kind === "image" &&
                (imageTier?.supportsGuidance ?? true) && (
                  <label className="space-y-1 text-[11px] text-muted-foreground">
                    Guidance · {value.guidance.toFixed(1)}
                    <input
                      type="range"
                      min={0}
                      max={12}
                      step={0.5}
                      value={value.guidance}
                      disabled={disabled}
                      onChange={(event) =>
                        patch({ guidance: Number(event.target.value) })
                      }
                      className="block w-full accent-primary"
                    />
                  </label>
                )}
              <label className="space-y-1 text-[11px] text-muted-foreground">
                Seed · blank is random
                <input
                  type="number"
                  min={0}
                  value={value.seed ?? ""}
                  disabled={disabled}
                  onChange={(event) =>
                    patch({
                      seed: event.target.value
                        ? Number(event.target.value)
                        : null,
                    })
                  }
                  placeholder="Random"
                  className="h-8 w-full rounded-lg border border-border bg-background/70 px-2 text-xs text-foreground outline-none focus:border-primary/60"
                />
              </label>
              {value.kind === "image" && (
                <label className="space-y-1 text-[11px] text-muted-foreground">
                  Variations · {value.variations}
                  <input
                    type="range"
                    min={1}
                    max={4}
                    value={value.variations}
                    disabled={disabled}
                    onChange={(event) =>
                      patch({ variations: Number(event.target.value) })
                    }
                    className="block w-full accent-primary"
                  />
                </label>
              )}
              {(value.kind === "image" || value.kind === "video") && (
                <label className="space-y-1 text-[11px] text-muted-foreground sm:col-span-2 lg:col-span-4">
                  Negative prompt
                  <input
                    value={value.negativePrompt}
                    disabled={disabled}
                    onChange={(event) =>
                      patch({ negativePrompt: event.target.value })
                    }
                    placeholder="Things Orion should avoid"
                    className="h-8 w-full rounded-lg border border-border bg-background/70 px-2 text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-primary/60"
                  />
                </label>
              )}
            </div>
          </details>

          <div
            className="mt-3 flex items-center gap-1.5 overflow-x-auto pb-0.5"
            aria-label="Media recipe graph"
          >
            {nodes.map((node, index) => (
              <div key={node} className="contents">
                {index > 0 && (
                  <span className="h-px min-w-3 flex-1 bg-border" />
                )}
                <span
                  className={cn(
                    "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-medium",
                    index === 2
                      ? "border-primary/35 bg-primary/12 text-primary"
                      : "border-border bg-background/50 text-muted-foreground",
                  )}
                >
                  {index === 2 ? <Sparkles className="h-3 w-3" /> : null}
                  {node}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
