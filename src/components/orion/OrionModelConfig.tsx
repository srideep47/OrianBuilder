import { useEffect, useState } from "react";
import {
  SlidersHorizontal,
  Image as ImageIcon,
  Video,
  Music,
  Mic,
  Box,
  CheckCircle2,
  DownloadCloud,
} from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ipc } from "@/ipc/types";
import { useSettings } from "@/hooks/useSettings";
import type { MediaAiStatus } from "@/ipc/types/media_ai";
import {
  ORION_MEDIA_CATALOG,
  resolveSelection,
  findOption,
  type OrionModality,
  type OrionMediaSelection,
} from "@/shared/orion_media_catalog";

const MODALITY_META: Record<
  OrionModality,
  { label: string; icon: typeof ImageIcon }
> = {
  image: { label: "Image", icon: ImageIcon },
  video: { label: "Video", icon: Video },
  music: { label: "Music", icon: Music },
  speech: { label: "Speech", icon: Mic },
  threed: { label: "3D", icon: Box },
};

const MODALITY_ORDER: OrionModality[] = [
  "image",
  "video",
  "music",
  "speech",
  "threed",
];

/**
 * Apps-screen config box: choose the image / video / music / speech / 3D model
 * for the Orion Factory. Selecting only persists the choice (settings) — it does
 * NOT load anything. The pipeline loads the chosen model on demand and
 * pre-downloads any missing weights at run start.
 */
export function OrionModelConfig() {
  const { settings, updateSettings } = useSettings();
  const [status, setStatus] = useState<MediaAiStatus | null>(null);

  useEffect(() => {
    let active = true;
    ipc.mediaAi
      .getStatus()
      .then((s) => active && setStatus(s))
      .catch(() => {
        /* badges just won't show download state */
      });
    return () => {
      active = false;
    };
  }, []);

  const selection = resolveSelection(
    settings?.orionMediaModels as OrionMediaSelection | undefined,
  );

  const isDownloaded = (modality: OrionModality, tierId: string): boolean => {
    const opt = findOption(modality, tierId);
    if (!opt || !status) return false;
    if (opt.downloadId) {
      return (
        status.models.find((m) => m.id === opt.downloadId)?.downloaded ?? false
      );
    }
    return false; // runtime installs have no per-weight download marker
  };

  const onSelect = (modality: OrionModality, tierId: string) => {
    void updateSettings({
      orionMediaModels: { ...selection, [modality]: tierId },
    } as Parameters<typeof updateSettings>[0]);
  };

  return (
    <div className="w-full rounded-2xl border border-white/10 bg-white/[0.04] p-4">
      <div className="mb-3 flex items-center gap-2">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-fuchsia-500/20 text-fuchsia-300">
          <SlidersHorizontal className="h-4 w-4" />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-white/90">Media Models</h3>
          <p className="text-xs text-white/50">
            Pick a model per modality. Selecting only saves the choice - loading
            and any missing download happen automatically when a build runs.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {MODALITY_ORDER.map((modality) => {
          const meta = MODALITY_META[modality];
          const Icon = meta.icon;
          const options = ORION_MEDIA_CATALOG[modality];
          const current = selection[modality];
          const opt = findOption(modality, current);
          const downloaded = isDownloaded(modality, current);
          return (
            <div
              key={modality}
              className="flex flex-col gap-1.5 rounded-xl border border-white/10 bg-black/20 p-3"
            >
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-white/70">
                  <Icon className="h-3.5 w-3.5" />
                  {meta.label}
                </span>
                {opt &&
                  (downloaded ? (
                    <span className="inline-flex items-center gap-1 text-xs text-emerald-400">
                      <CheckCircle2 className="h-3 w-3" /> Ready
                    </span>
                  ) : opt.runtimeInstall ? (
                    <span className="text-xs text-white/40">
                      installs on first use
                    </span>
                  ) : opt.downloadId ? (
                    <span className="inline-flex items-center gap-1 text-xs text-amber-300/80">
                      <DownloadCloud className="h-3 w-3" /> {opt.sizeLabel}
                    </span>
                  ) : (
                    <span className="text-xs text-white/40">
                      downloads on first use
                    </span>
                  ))}
              </div>
              <Select
                value={current}
                onValueChange={(v) => onSelect(modality, v as string)}
              >
                <SelectTrigger className="w-full bg-black/30">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {options.map((o) => (
                    <SelectItem key={o.tierId} value={o.tierId}>
                      <span>{o.label}</span>
                      <span className="text-xs text-muted-foreground">
                        {o.sizeLabel}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          );
        })}
      </div>
    </div>
  );
}
