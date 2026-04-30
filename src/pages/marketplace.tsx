import { useState, useEffect, useMemo, useCallback } from "react";
import { ipc } from "@/ipc/types";
import type {
  HFSearchModel,
  HFModelDetail,
  DownloadProgress,
  HFFileSibling,
} from "@/ipc/types";
import { Button } from "@/components/ui/button";
import { showError, showSuccess } from "@/lib/toast";
import { cn } from "@/lib/utils";
import {
  Search,
  Loader2,
  Download,
  X,
  ExternalLink,
  HardDrive,
  Heart,
  Sparkles,
  Clock,
  Tag,
  CheckCircle2,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Cpu,
} from "lucide-react";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatBytes(b: number): string {
  if (!b) return "—";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 / 1024).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

function formatNumber(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

function quantFromName(name: string): string | null {
  const m = name.match(/[._-](IQ\d[A-Z0-9_]*|Q\d[A-Z0-9_]*|F16|F32|BF16)\b/i);
  return m ? m[1].toUpperCase() : null;
}

function paramBillionsFromName(name: string): number | null {
  const m = name.match(/[._\- (](\d+(?:\.\d+)?)\s*[bB](?:[._\- )]|$)/);
  return m ? parseFloat(m[1]) : null;
}

const SORT_OPTIONS = [
  { value: "downloads", label: "Most Downloaded", icon: Download },
  { value: "likes", label: "Most Liked", icon: Heart },
  { value: "trending", label: "Trending", icon: Sparkles },
  { value: "lastModified", label: "Recently Updated", icon: Clock },
] as const;

const FEATURED_QUERIES = [
  { label: "Qwen 3", q: "Qwen3 GGUF" },
  { label: "Llama 3.x", q: "Llama-3 GGUF" },
  { label: "Mistral", q: "Mistral GGUF" },
  { label: "Gemma", q: "Gemma GGUF" },
  { label: "DeepSeek", q: "DeepSeek GGUF" },
  { label: "Phi", q: "Phi-3 GGUF" },
];

// ─── Page ────────────────────────────────────────────────────────────────────

export default function MarketplacePage() {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [sort, setSort] =
    useState<(typeof SORT_OPTIONS)[number]["value"]>("downloads");
  const [results, setResults] = useState<HFSearchModel[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [selected, setSelected] = useState<HFModelDetail | null>(null);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [downloads, setDownloads] = useState<DownloadProgress[]>([]);

  // Debounce typing
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 350);
    return () => clearTimeout(t);
  }, [query]);

  // Search
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setIsSearching(true);
      try {
        const data = await ipc.marketplace.searchModels({
          query: debouncedQuery || undefined,
          ggufOnly: true,
          sort,
          limit: 40,
        });
        if (!cancelled) setResults(data);
      } catch (err: any) {
        if (!cancelled) showError(`Search failed: ${err?.message ?? err}`);
      } finally {
        if (!cancelled) setIsSearching(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, sort]);

  // Download progress subscription
  useEffect(() => {
    (async () => {
      setDownloads(await ipc.marketplace.listDownloads());
    })();
    const off = ipc.events.marketplace.onDownloadProgress((p) => {
      setDownloads((prev) => {
        const next = prev.filter((d) => d.id !== p.id);
        return [...next, p].sort((a, b) => b.startedAt - a.startedAt);
      });
    });
    return off;
  }, []);

  const openDetail = useCallback(async (repoId: string) => {
    setIsLoadingDetail(true);
    setSelected({
      id: repoId,
      author: null,
      siblings: [],
      tags: [],
      downloads: 0,
      likes: 0,
    } as any);
    try {
      const detail = await ipc.marketplace.getModelDetail({ repoId });
      setSelected(detail);
    } catch (err: any) {
      showError(`Failed to load ${repoId}: ${err?.message ?? err}`);
      setSelected(null);
    } finally {
      setIsLoadingDetail(false);
    }
  }, []);

  const startDownload = useCallback(
    async (repoId: string, fileName: string) => {
      const r = await ipc.marketplace.startDownload({ repoId, fileName });
      if (!r.success) {
        showError(`Download failed: ${r.error}`);
      } else {
        showSuccess(`Downloading ${fileName}`);
        setDownloads(await ipc.marketplace.listDownloads());
      }
    },
    [],
  );

  const cancelDl = useCallback(async (id: string) => {
    await ipc.marketplace.cancelDownload({ id });
    setDownloads(await ipc.marketplace.listDownloads());
  }, []);

  const activeDownloads = useMemo(
    () =>
      downloads.filter(
        (d) => d.state === "downloading" || d.state === "queued",
      ),
    [downloads],
  );

  return (
    <div className="flex h-full overflow-hidden">
      {/* ─── Main pane ─── */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Header */}
        <div className="border-b px-6 py-4 bg-background/95 backdrop-blur sticky top-0 z-10">
          <div className="flex items-center justify-between gap-4 mb-3">
            <div>
              <h1 className="text-xl font-bold flex items-center gap-2">
                <HardDrive className="w-5 h-5 text-primary" />
                Model Marketplace
              </h1>
              <p className="text-xs text-muted-foreground">
                Browse Hugging Face GGUF models · download for the in-app
                inference engine
              </p>
            </div>
            {activeDownloads.length > 0 && (
              <span className="text-xs bg-primary/10 text-primary px-2 py-1 rounded-full font-medium flex items-center gap-1.5">
                <Loader2 className="w-3 h-3 animate-spin" />
                {activeDownloads.length} downloading
              </span>
            )}
          </div>

          {/* Search bar */}
          <div className="flex gap-2 items-center">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search GGUF models on Hugging Face… (e.g. qwen3, llama, mistral)"
                className="w-full pl-10 pr-3 py-2 border rounded-lg bg-background text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
              {isSearching && (
                <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-muted-foreground" />
              )}
            </div>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as any)}
              className="border rounded-lg px-3 py-2 text-sm bg-background"
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-wrap gap-1.5 mt-2">
            {FEATURED_QUERIES.map((f) => (
              <button
                key={f.label}
                onClick={() => setQuery(f.q)}
                className="text-xs px-2.5 py-1 rounded-full border bg-muted/40 hover:bg-muted transition-colors"
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {/* Results grid */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {isSearching && results.length === 0 ? (
            <div className="flex items-center justify-center py-24 text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin mr-2" /> Searching
              Hugging Face…
            </div>
          ) : results.length === 0 ? (
            <div className="text-center py-24 text-muted-foreground text-sm">
              No models found. Try a different search.
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-3">
              {results.map((m) => (
                <ModelCard
                  key={m.id}
                  model={m}
                  active={selected?.id === m.id}
                  onClick={() => openDetail(m.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ─── Detail / download panel ─── */}
      <div className="w-[460px] shrink-0 border-l flex flex-col overflow-hidden bg-card/30">
        {selected ? (
          <ModelDetailPanel
            detail={selected}
            isLoading={isLoadingDetail}
            downloads={downloads}
            onClose={() => setSelected(null)}
            onDownload={startDownload}
            onCancel={cancelDl}
          />
        ) : (
          <DownloadsPanel downloads={downloads} onCancel={cancelDl} />
        )}
      </div>
    </div>
  );
}

// ─── Model Card ──────────────────────────────────────────────────────────────

function ModelCard({
  model,
  active,
  onClick,
}: {
  model: HFSearchModel;
  active: boolean;
  onClick: () => void;
}) {
  const author = model.id.split("/")[0];
  const name = model.id.split("/").slice(1).join("/");
  return (
    <button
      onClick={onClick}
      className={cn(
        "text-left rounded-xl border bg-card p-3.5 hover:border-primary/40 hover:shadow-sm transition-all group min-w-0",
        active && "border-primary ring-2 ring-primary/20",
      )}
    >
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted-foreground truncate">{author}</p>
          <p className="font-semibold text-sm truncate group-hover:text-primary transition-colors">
            {name}
          </p>
        </div>
        {model.gated && (
          <span className="text-[10px] bg-yellow-500/10 text-yellow-700 dark:text-yellow-400 px-1.5 py-0.5 rounded shrink-0 font-medium">
            gated
          </span>
        )}
      </div>

      <div className="flex items-center gap-3 text-xs text-muted-foreground mt-2">
        <span className="flex items-center gap-1">
          <Download className="w-3 h-3" />
          {formatNumber(model.downloads)}
        </span>
        <span className="flex items-center gap-1">
          <Heart className="w-3 h-3" />
          {formatNumber(model.likes)}
        </span>
        {model.lastModified && (
          <span className="flex items-center gap-1 ml-auto">
            <Clock className="w-3 h-3" />
            {new Date(model.lastModified).toLocaleDateString()}
          </span>
        )}
      </div>

      {model.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {model.tags.slice(0, 4).map((t) => (
            <span
              key={t}
              className="text-[10px] bg-muted px-1.5 py-0.5 rounded font-mono text-muted-foreground"
            >
              {t}
            </span>
          ))}
        </div>
      )}
    </button>
  );
}

// ─── Detail Panel ────────────────────────────────────────────────────────────

function ModelDetailPanel({
  detail,
  isLoading,
  downloads,
  onClose,
  onDownload,
  onCancel,
}: {
  detail: HFModelDetail;
  isLoading: boolean;
  downloads: DownloadProgress[];
  onClose: () => void;
  onDownload: (repoId: string, fileName: string) => void;
  onCancel: (id: string) => void;
}) {
  const ggufFiles = useMemo(
    () => detail.siblings.filter((s) => /\.gguf$/i.test(s.rfilename)),
    [detail.siblings],
  );

  // Group GGUF files by base name (e.g. "Qwen3-7B" with multiple quants)
  const grouped = useMemo(() => {
    const map = new Map<string, HFFileSibling[]>();
    for (const f of ggufFiles) {
      const base = f.rfilename.replace(
        /[._-]?(IQ\d[A-Z0-9_]*|Q\d[A-Z0-9_]*|F16|F32|BF16)?\.gguf$/i,
        "",
      );
      const key = base || f.rfilename;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(f);
    }
    return Array.from(map.entries()).map(([base, files]) => ({
      base,
      files: files.sort(
        (a, b) => (a.size ?? a.lfs?.size ?? 0) - (b.size ?? b.lfs?.size ?? 0),
      ),
    }));
  }, [ggufFiles]);

  const author = detail.id.split("/")[0];
  const name = detail.id.split("/").slice(1).join("/");

  const dlByName = useMemo(() => {
    const m = new Map<string, DownloadProgress>();
    for (const d of downloads) if (d.repoId === detail.id) m.set(d.fileName, d);
    return m;
  }, [downloads, detail.id]);

  return (
    <div className="flex flex-col h-full">
      <div className="border-b px-4 py-3 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground truncate">{author}</p>
          <p className="font-semibold text-sm truncate">{name}</p>
          <div className="flex items-center gap-3 text-xs text-muted-foreground mt-1.5">
            <span className="flex items-center gap-1">
              <Download className="w-3 h-3" />
              {formatNumber(detail.downloads)}
            </span>
            <span className="flex items-center gap-1">
              <Heart className="w-3 h-3" />
              {formatNumber(detail.likes)}
            </span>
            <a
              href={`https://huggingface.co/${detail.id}`}
              target="_blank"
              rel="noreferrer"
              className="ml-auto text-primary hover:underline flex items-center gap-0.5"
            >
              HF <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose}>
          <X className="w-4 h-4" />
        </Button>
      </div>

      {isLoading ? (
        <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin mr-2" />
          Loading model details…
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {detail.tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {detail.tags.slice(0, 12).map((t) => (
                <span
                  key={t}
                  className="text-[10px] bg-muted px-1.5 py-0.5 rounded font-mono"
                >
                  {t}
                </span>
              ))}
            </div>
          )}

          {detail.description && (
            <div className="text-xs text-muted-foreground leading-relaxed border-t pt-3 line-clamp-6">
              {detail.description}
            </div>
          )}

          <div className="border-t pt-3">
            <h3 className="font-semibold text-sm mb-2 flex items-center gap-1.5">
              <Cpu className="w-3.5 h-3.5" />
              GGUF files ({ggufFiles.length})
            </h3>
            {ggufFiles.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">
                No GGUF files in this repo.
              </p>
            ) : (
              <div className="space-y-3">
                {grouped.map(({ base, files }) => (
                  <FileGroup
                    key={base}
                    base={base}
                    files={files}
                    repoId={detail.id}
                    dlByName={dlByName}
                    onDownload={onDownload}
                    onCancel={onCancel}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function FileGroup({
  base,
  files,
  repoId,
  dlByName,
  onDownload,
  onCancel,
}: {
  base: string;
  files: HFFileSibling[];
  repoId: string;
  dlByName: Map<string, DownloadProgress>;
  onDownload: (repoId: string, fileName: string) => void;
  onCancel: (id: string) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="rounded-lg border bg-background overflow-hidden">
      <button
        className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium hover:bg-muted/50 transition-colors"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="truncate font-mono">{base || "files"}</span>
        <span className="flex items-center gap-1 text-muted-foreground">
          {files.length} variant{files.length !== 1 ? "s" : ""}
          {open ? (
            <ChevronDown className="w-3 h-3" />
          ) : (
            <ChevronRight className="w-3 h-3" />
          )}
        </span>
      </button>
      {open && (
        <div className="border-t divide-y">
          {files.map((f) => {
            const size = f.size ?? f.lfs?.size ?? 0;
            const quant = quantFromName(f.rfilename) ?? "—";
            const params = paramBillionsFromName(f.rfilename);
            const dl = dlByName.get(f.rfilename);
            return (
              <FileRow
                key={f.rfilename}
                fileName={f.rfilename}
                size={size}
                quant={quant}
                params={params}
                download={dl}
                onDownload={() => onDownload(repoId, f.rfilename)}
                onCancel={dl ? () => onCancel(dl.id) : undefined}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function FileRow({
  fileName,
  size,
  quant,
  params,
  download,
  onDownload,
  onCancel,
}: {
  fileName: string;
  size: number;
  quant: string;
  params: number | null;
  download?: DownloadProgress;
  onDownload: () => void;
  onCancel?: () => void;
}) {
  const isDone = download?.state === "completed";
  const isActive =
    download?.state === "downloading" || download?.state === "queued";
  const isFailed = download?.state === "failed";
  const pct =
    download && download.totalBytes > 0
      ? (download.receivedBytes / download.totalBytes) * 100
      : 0;

  return (
    <div className="px-3 py-2 space-y-1">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-mono truncate">{fileName}</p>
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground mt-0.5">
            <span className="bg-primary/10 text-primary font-medium px-1.5 py-0.5 rounded">
              {quant}
            </span>
            {params != null && <span>{params}B</span>}
            {size > 0 && <span>{formatBytes(size)}</span>}
          </div>
        </div>
        <div className="shrink-0">
          {isDone ? (
            <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400 font-medium">
              <CheckCircle2 className="w-3.5 h-3.5" />
              Downloaded
            </span>
          ) : isActive ? (
            <button
              onClick={onCancel}
              className="text-xs text-red-600 hover:underline flex items-center gap-1"
            >
              <X className="w-3 h-3" />
              Cancel
            </button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={onDownload}
              className="h-7 px-2 text-xs"
            >
              <Download className="w-3 h-3 mr-1" />
              Download
            </Button>
          )}
        </div>
      </div>
      {isActive && download && (
        <div className="space-y-0.5">
          <div className="h-1 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="flex justify-between text-[10px] text-muted-foreground tabular-nums">
            <span>
              {formatBytes(download.receivedBytes)} /{" "}
              {formatBytes(download.totalBytes)}
            </span>
            <span>{formatBytes(download.bytesPerSecond)}/s</span>
          </div>
        </div>
      )}
      {isFailed && (
        <p className="text-[10px] text-red-600 flex items-center gap-1">
          <AlertCircle className="w-3 h-3" />
          {download?.error}
        </p>
      )}
    </div>
  );
}

// ─── Downloads Panel (default view) ──────────────────────────────────────────

function DownloadsPanel({
  downloads,
  onCancel,
}: {
  downloads: DownloadProgress[];
  onCancel: (id: string) => void;
}) {
  const [filter, setFilter] = useState<"all" | "active" | "completed">(
    "active",
  );
  const filtered = useMemo(() => {
    if (filter === "active")
      return downloads.filter(
        (d) => d.state === "downloading" || d.state === "queued",
      );
    if (filter === "completed")
      return downloads.filter((d) => d.state === "completed");
    return downloads;
  }, [downloads, filter]);

  return (
    <div className="flex flex-col h-full">
      <div className="border-b px-4 py-3">
        <h2 className="font-semibold text-sm flex items-center gap-1.5">
          <Download className="w-4 h-4" />
          Downloads
        </h2>
        <div className="flex gap-1 mt-2">
          {(["active", "completed", "all"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                "text-xs px-2.5 py-1 rounded-full border capitalize transition-colors",
                filter === f
                  ? "bg-primary text-primary-foreground border-primary"
                  : "hover:bg-muted",
              )}
            >
              {f}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
        {filtered.length === 0 ? (
          <div className="text-center py-12 text-xs text-muted-foreground">
            <Tag className="w-6 h-6 mx-auto mb-2 opacity-50" />
            Pick a model on the left to see download options.
          </div>
        ) : (
          filtered.map((d) => (
            <DownloadCard
              key={d.id}
              download={d}
              onCancel={() => onCancel(d.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function DownloadCard({
  download,
  onCancel,
}: {
  download: DownloadProgress;
  onCancel: () => void;
}) {
  const pct =
    download.totalBytes > 0
      ? (download.receivedBytes / download.totalBytes) * 100
      : 0;
  const isActive =
    download.state === "downloading" || download.state === "queued";
  const eta =
    download.bytesPerSecond > 0 && download.totalBytes > 0
      ? Math.max(
          0,
          (download.totalBytes - download.receivedBytes) /
            download.bytesPerSecond,
        )
      : 0;
  return (
    <div className="rounded-lg border bg-background p-3">
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-mono truncate">{download.fileName}</p>
          <p className="text-[10px] text-muted-foreground truncate">
            {download.repoId}
          </p>
        </div>
        <span
          className={cn(
            "text-[10px] px-1.5 py-0.5 rounded font-medium capitalize shrink-0",
            download.state === "completed" &&
              "bg-green-500/10 text-green-700 dark:text-green-400",
            download.state === "downloading" && "bg-primary/10 text-primary",
            download.state === "failed" && "bg-red-500/10 text-red-600",
            download.state === "cancelled" && "bg-muted text-muted-foreground",
            download.state === "queued" &&
              "bg-yellow-500/10 text-yellow-700 dark:text-yellow-400",
          )}
        >
          {download.state}
        </span>
      </div>
      {isActive && (
        <>
          <div className="h-1 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="flex justify-between text-[10px] text-muted-foreground tabular-nums mt-1">
            <span>
              {formatBytes(download.receivedBytes)} /{" "}
              {formatBytes(download.totalBytes)}
            </span>
            <span>
              {formatBytes(download.bytesPerSecond)}/s
              {eta > 0 &&
                ` · ETA ${eta < 60 ? `${eta.toFixed(0)}s` : `${(eta / 60).toFixed(1)}m`}`}
            </span>
          </div>
          <button
            onClick={onCancel}
            className="text-[10px] text-red-600 hover:underline mt-1.5 flex items-center gap-0.5"
          >
            <X className="w-3 h-3" />
            Cancel
          </button>
        </>
      )}
      {download.state === "failed" && (
        <p className="text-[10px] text-red-600 flex items-start gap-1">
          <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
          {download.error}
        </p>
      )}
    </div>
  );
}
