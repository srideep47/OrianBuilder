/**
 * Website Radar — track URLs and surface AI-summarised diffs when their text
 * changes. Backend endpoints used: /websites, /websites/{id}/check,
 * /websites/{id}/updates, /websites/{id}/items.
 */
import { useCallback, useEffect, useState } from "react";
import {
  RefreshCw,
  Plus,
  Trash2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Loader2,
  AlertCircle,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import type {
  WatchdogApi,
  Website,
  WebsiteItem,
  WebsiteUpdate,
} from "./api";

type ItemsState = WebsiteItem[] | "loading" | "error" | undefined;

export function WebsiteRadar({ api }: { api: WatchdogApi }) {
  const [websites, setWebsites] = useState<Website[]>([]);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState("");
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [updates, setUpdates] = useState<Record<number, WebsiteUpdate[]>>({});
  const [items, setItems] = useState<Record<number, ItemsState>>({});

  const refresh = useCallback(async () => {
    try {
      const list = await api.listWebsites();
      setWebsites(list);
    } catch (err) {
      toast.error("Could not load websites", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onAdd = useCallback(async () => {
    const url = input.trim();
    if (!url) return;
    setAdding(true);
    try {
      await api.addWebsite(url);
      setInput("");
      await refresh();
      toast.success("Website added");
    } catch (err) {
      toast.error("Failed to add website", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setAdding(false);
    }
  }, [api, input, refresh]);

  const onCheck = useCallback(
    async (id: number) => {
      setBusyId(id);
      try {
        const updated = await api.checkWebsite(id);
        setWebsites((prev) => prev.map((w) => (w.id === id ? updated : w)));
        if (expandedId === id) {
          const fresh = await api.websiteUpdates(id);
          setUpdates((prev) => ({ ...prev, [id]: fresh }));
        }
      } catch (err) {
        toast.error("Check failed", {
          description: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setBusyId(null);
      }
    },
    [api, expandedId],
  );

  const onRemove = useCallback(
    async (id: number) => {
      try {
        await api.removeWebsite(id);
        setWebsites((prev) => prev.filter((w) => w.id !== id));
        if (expandedId === id) setExpandedId(null);
      } catch (err) {
        toast.error("Failed to remove", {
          description: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [api, expandedId],
  );

  const onExpand = useCallback(
    async (id: number) => {
      if (expandedId === id) {
        setExpandedId(null);
        return;
      }
      setExpandedId(id);
      // Load both panels in parallel.
      setItems((prev) => ({ ...prev, [id]: "loading" }));
      try {
        const [u, i] = await Promise.all([
          api.websiteUpdates(id),
          api.websiteItems(id),
        ]);
        setUpdates((prev) => ({ ...prev, [id]: u }));
        setItems((prev) => ({ ...prev, [id]: i }));
      } catch (err) {
        setItems((prev) => ({ ...prev, [id]: "error" }));
        toast.error("Could not expand", {
          description: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [api, expandedId],
  );

  const onReloadItems = useCallback(
    async (id: number) => {
      setItems((prev) => ({ ...prev, [id]: "loading" }));
      try {
        const i = await api.websiteItems(id);
        setItems((prev) => ({ ...prev, [id]: i }));
      } catch {
        setItems((prev) => ({ ...prev, [id]: "error" }));
      }
    },
    [api],
  );

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void onAdd();
          }}
          placeholder="https://example.com/news"
          disabled={adding}
        />
        <Button onClick={onAdd} disabled={adding || !input.trim()}>
          {adding ? (
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          ) : (
            <Plus className="w-4 h-4 mr-2" />
          )}
          Add
        </Button>
      </div>

      {loading ? (
        <EmptyState>
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </EmptyState>
      ) : websites.length === 0 ? (
        <EmptyState>No websites tracked yet.</EmptyState>
      ) : (
        <div className="space-y-3">
          {websites.map((site) => (
            <WebsiteRow
              key={site.id}
              site={site}
              isExpanded={expandedId === site.id}
              busy={busyId === site.id}
              updates={updates[site.id] ?? []}
              items={items[site.id]}
              onCheck={() => void onCheck(site.id)}
              onRemove={() => void onRemove(site.id)}
              onToggle={() => void onExpand(site.id)}
              onReloadItems={() => void onReloadItems(site.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function WebsiteRow({
  site,
  isExpanded,
  busy,
  updates,
  items,
  onCheck,
  onRemove,
  onToggle,
  onReloadItems,
}: {
  site: Website;
  isExpanded: boolean;
  busy: boolean;
  updates: WebsiteUpdate[];
  items: ItemsState;
  onCheck: () => void;
  onRemove: () => void;
  onToggle: () => void;
  onReloadItems: () => void;
}) {
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <button
          type="button"
          onClick={onToggle}
          className="flex flex-1 min-w-0 items-start gap-2 text-left hover:opacity-90"
        >
          {isExpanded ? (
            <ChevronDown className="w-4 h-4 mt-0.5 text-muted-foreground shrink-0" />
          ) : (
            <ChevronRight className="w-4 h-4 mt-0.5 text-muted-foreground shrink-0" />
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs text-muted-foreground font-mono">
              {site.url}
            </div>
            <div className="mt-1 text-sm">{site.summary ?? "No summary yet."}</div>
          </div>
        </button>
        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant="ghost"
            size="icon"
            onClick={onCheck}
            disabled={busy}
            title="Check now"
            className="h-8 w-8"
          >
            {busy ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={onRemove}
            title="Remove"
            className="h-8 w-8 text-muted-foreground hover:text-red-500"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      {isExpanded && (
        <div className="mt-4 grid gap-4 md:grid-cols-2 border-t border-border pt-4">
          <ItemsPanel state={items} onReload={onReloadItems} />
          <UpdatesPanel updates={updates} />
        </div>
      )}
    </Card>
  );
}

function ItemsPanel({
  state,
  onReload,
}: {
  state: ItemsState;
  onReload: () => void;
}) {
  return (
    <div className="rounded-md border border-border bg-muted/30 p-3 max-h-72 flex flex-col">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Recent posts on the page
        </h3>
        <button
          onClick={onReload}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          Reload
        </button>
      </div>
      <div className="flex-1 overflow-y-auto space-y-1.5">
        {state === "loading" || state === undefined ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Scanning the page…
          </div>
        ) : state === "error" ? (
          <div className="flex items-center gap-2 text-sm text-red-500">
            <AlertCircle className="w-3.5 h-3.5" /> Couldn't read the page.
          </div>
        ) : state.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            Nothing post-like found on this page.
          </div>
        ) : (
          state.map((item) => (
            <a
              key={item.url}
              href={item.url}
              target="_blank"
              rel="noreferrer"
              className="group flex items-start gap-2 rounded-md border border-border bg-card p-2 hover:bg-accent transition-colors"
            >
              <ExternalLink className="w-3 h-3 mt-1 text-muted-foreground group-hover:text-foreground shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="text-sm truncate">{item.title}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {item.url}
                </div>
              </div>
            </a>
          ))
        )}
      </div>
    </div>
  );
}

function UpdatesPanel({ updates }: { updates: WebsiteUpdate[] }) {
  return (
    <div className="rounded-md border border-border bg-muted/30 p-3 max-h-72 flex flex-col">
      <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">
        Change history
      </h3>
      <div className="flex-1 overflow-y-auto space-y-2">
        {updates.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            No changes recorded yet.
          </div>
        ) : (
          updates.map((u) => (
            <div
              key={u.id}
              className="rounded-md border border-border bg-card p-2"
            >
              <div className="text-[10px] text-muted-foreground mb-0.5">
                {new Date(u.timestamp).toLocaleString()}
              </div>
              <div className="text-sm">{u.update_text}</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-center gap-2 py-12 rounded-lg border border-dashed border-border text-sm text-muted-foreground">
      {children}
    </div>
  );
}
