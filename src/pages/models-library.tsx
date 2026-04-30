import { useState, useEffect, useCallback } from "react";
import { ipc } from "@/ipc/types";
import type {
  LocalModelEntry,
  GgufMetadata,
  EmbeddedServerStatus,
} from "@/ipc/types";
import { Button } from "@/components/ui/button";
import { showError, showSuccess } from "@/lib/toast";
import { useNavigate } from "@tanstack/react-router";
import { cn } from "@/lib/utils";
import {
  HardDrive,
  Trash2,
  Zap,
  Loader2,
  FolderOpen,
  CheckCircle2,
  AlertCircle,
  Cpu,
  Layers,
  Database,
  Folder,
} from "lucide-react";

function fmtBytes(b: number): string {
  if (!b) return "—";
  if (b < 1024 ** 3) return `${(b / 1024 / 1024).toFixed(0)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

export default function ModelsLibraryPage() {
  const [models, setModels] = useState<LocalModelEntry[]>([]);
  const [dirInfo, setDirInfo] = useState<{
    dir: string;
    totalBytes: number;
    freeBytes: number;
  } | null>(null);
  const [status, setStatus] = useState<EmbeddedServerStatus | null>(null);
  const [metadata, setMetadata] = useState<Record<string, GgufMetadata>>({});
  const [loadingPath, setLoadingPath] = useState<string | null>(null);
  const [deletingPath, setDeletingPath] = useState<string | null>(null);
  const navigate = useNavigate();

  const refresh = useCallback(async () => {
    const [list, info, s] = await Promise.all([
      ipc.marketplace.listLocalModels(),
      ipc.marketplace.getModelsDirInfo(),
      ipc.embeddedModel.getStatus(),
    ]);
    setModels(list);
    setDirInfo(info);
    setStatus(s);
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [refresh]);

  // Lazy GGUF metadata for all on-disk models — read once each.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const updates: Record<string, GgufMetadata> = {};
      for (const m of models) {
        if (metadata[m.filePath]) continue;
        try {
          const md = await ipc.marketplace.readGgufMetadata({
            filePath: m.filePath,
          });
          if (cancelled) return;
          updates[m.filePath] = md;
        } catch {
          /* ignore — show without metadata */
        }
      }
      if (Object.keys(updates).length > 0 && !cancelled) {
        setMetadata((prev) => ({ ...prev, ...updates }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [models, metadata]);

  const loadIntoEngine = useCallback(
    async (m: LocalModelEntry) => {
      setLoadingPath(m.filePath);
      try {
        const cfg = await ipc.embeddedModel.getSavedConfig();
        const result = await ipc.embeddedModel.loadModel({
          modelPath: m.filePath,
          gpuMemoryUtilization: cfg.gpuMemoryUtilization ?? 0.8,
          contextSize: cfg.contextSize ?? 8192,
          batchSize: cfg.batchSize ?? 512,
          temperature: cfg.temperature ?? 0.7,
          topP: cfg.topP ?? 0.95,
          topK: cfg.topK ?? 40,
          repeatPenalty: cfg.repeatPenalty ?? 1.1,
          seed: cfg.seed ?? null,
          flashAttention: cfg.flashAttention ?? true,
        });
        if (result.success) {
          showSuccess(
            `Loaded ${m.fileName} — open Engine to tune settings, or pick "Embedded" in chat`,
          );
          await refresh();
        } else {
          showError(`Load failed: ${result.error}`);
        }
      } finally {
        setLoadingPath(null);
      }
    },
    [refresh],
  );

  const removeModel = useCallback(
    async (m: LocalModelEntry) => {
      if (!confirm(`Delete ${m.fileName}?\n\n${m.filePath}`)) return;
      setDeletingPath(m.filePath);
      try {
        const r = await ipc.marketplace.deleteLocalModel({
          filePath: m.filePath,
        });
        if (r.success) {
          showSuccess("Model deleted");
          await refresh();
        } else {
          showError(`Delete failed: ${r.error}`);
        }
      } finally {
        setDeletingPath(null);
      }
    },
    [refresh],
  );

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="border-b px-6 py-4 sticky top-0 z-10 bg-background/95 backdrop-blur">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold flex items-center gap-2">
              <Database className="w-5 h-5 text-primary" />
              Models Library
            </h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              Downloaded GGUF models · load any of them into the in-app
              inference engine
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate({ to: "/marketplace" })}
            >
              <HardDrive className="w-4 h-4 mr-1.5" />
              Browse Marketplace
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate({ to: "/inference" })}
            >
              <Cpu className="w-4 h-4 mr-1.5" />
              Engine Settings
            </Button>
          </div>
        </div>

        {dirInfo && (
          <div className="grid grid-cols-3 gap-3 mt-3">
            <div className="rounded-lg border bg-card p-3">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
                Models on disk
              </p>
              <p className="text-lg font-bold tabular-nums">{models.length}</p>
            </div>
            <div className="rounded-lg border bg-card p-3">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
                Total size
              </p>
              <p className="text-lg font-bold tabular-nums">
                {fmtBytes(dirInfo.totalBytes)}
              </p>
            </div>
            <div className="rounded-lg border bg-card p-3 truncate">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide flex items-center gap-1">
                <Folder className="w-3 h-3" />
                Storage path
              </p>
              <p className="text-xs font-mono truncate" title={dirInfo.dir}>
                {dirInfo.dir}
              </p>
            </div>
          </div>
        )}
      </div>

      <div className="flex-1 px-6 py-5 space-y-3 max-w-5xl mx-auto w-full">
        {models.length === 0 ? (
          <div className="text-center py-20 rounded-xl border bg-card">
            <FolderOpen className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
            <p className="text-sm font-medium">No models downloaded yet</p>
            <p className="text-xs text-muted-foreground mt-1 mb-4">
              Browse the Marketplace to download GGUF models from Hugging Face.
            </p>
            <Button onClick={() => navigate({ to: "/marketplace" })}>
              <HardDrive className="w-4 h-4 mr-1.5" />
              Open Marketplace
            </Button>
          </div>
        ) : (
          models.map((m) => (
            <ModelRow
              key={m.filePath}
              model={m}
              metadata={metadata[m.filePath]}
              isLoaded={status?.modelPath === m.filePath}
              isLoading={loadingPath === m.filePath}
              isDeleting={deletingPath === m.filePath}
              onLoad={() => loadIntoEngine(m)}
              onDelete={() => removeModel(m)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function ModelRow({
  model,
  metadata,
  isLoaded,
  isLoading,
  isDeleting,
  onLoad,
  onDelete,
}: {
  model: LocalModelEntry;
  metadata?: GgufMetadata;
  isLoaded: boolean;
  isLoading: boolean;
  isDeleting: boolean;
  onLoad: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border bg-card px-4 py-3 transition-colors",
        isLoaded
          ? "border-green-500/40 bg-green-50/30 dark:bg-green-900/10"
          : "hover:border-primary/30",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1">
            <p className="font-mono text-sm font-medium truncate">
              {model.fileName}
            </p>
            {isLoaded && (
              <span className="text-[10px] bg-green-500/10 text-green-700 dark:text-green-400 px-1.5 py-0.5 rounded font-medium flex items-center gap-0.5 shrink-0">
                <CheckCircle2 className="w-3 h-3" />
                Loaded
              </span>
            )}
          </div>
          {model.repoId && (
            <p className="text-xs text-muted-foreground truncate">
              {model.repoId}
            </p>
          )}
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs">
            <Spec label="Size" value={fmtBytes(model.fileSizeBytes)} />
            {metadata?.architecture && (
              <Spec label="Arch" value={metadata.architecture} />
            )}
            {metadata?.quantization && (
              <Spec label="Quant" value={metadata.quantization} mono />
            )}
            {metadata?.blockCount != null && (
              <Spec
                label="Layers"
                value={String(metadata.blockCount)}
                icon={Layers}
              />
            )}
            {metadata?.embeddingLength != null && (
              <Spec label="Hidden" value={String(metadata.embeddingLength)} />
            )}
            {metadata?.attentionHeadCount != null && (
              <Spec
                label="Heads"
                value={`${metadata.attentionHeadCount}${metadata.attentionHeadCountKv && metadata.attentionHeadCountKv !== metadata.attentionHeadCount ? ` (KV ${metadata.attentionHeadCountKv})` : ""}`}
              />
            )}
            {metadata?.contextLength != null && (
              <Spec
                label="Trained ctx"
                value={`${(metadata.contextLength / 1024).toFixed(0)}K`}
              />
            )}
            {metadata?.vocabSize != null && (
              <Spec label="Vocab" value={metadata.vocabSize.toLocaleString()} />
            )}
          </div>
        </div>
        <div className="flex flex-col gap-1.5 shrink-0">
          <Button
            size="sm"
            variant={isLoaded ? "outline" : "default"}
            disabled={isLoading || isLoaded}
            onClick={onLoad}
          >
            {isLoading ? (
              <>
                <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                Loading…
              </>
            ) : isLoaded ? (
              <>
                <CheckCircle2 className="w-3.5 h-3.5 mr-1.5" />
                Active
              </>
            ) : (
              <>
                <Zap className="w-3.5 h-3.5 mr-1.5" />
                Load
              </>
            )}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={isLoading || isDeleting}
            onClick={onDelete}
            className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20"
          >
            {isDeleting ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Trash2 className="w-3.5 h-3.5" />
            )}
          </Button>
        </div>
      </div>
      {metadata?.contextLength == null && metadata == null && (
        <p className="text-[10px] text-muted-foreground mt-2 flex items-center gap-1">
          <AlertCircle className="w-3 h-3" />
          Reading metadata…
        </p>
      )}
    </div>
  );
}

function Spec({
  label,
  value,
  mono,
  icon: Icon,
}: {
  label: string;
  value: string;
  mono?: boolean;
  icon?: React.ElementType;
}) {
  return (
    <span className="flex items-center gap-1 text-muted-foreground">
      {Icon && <Icon className="w-3 h-3" />}
      <span className="text-[10px] uppercase tracking-wide">{label}</span>
      <span className={cn("text-foreground font-medium", mono && "font-mono")}>
        {value}
      </span>
    </span>
  );
}
