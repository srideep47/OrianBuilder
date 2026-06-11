/**
 * Price Monitor — tracks product URLs, charts their price history, and shows a
 * "deal verdict" (best/worst/typical) plus drop-chance heuristic. Mirrors the
 * watch_dog dashboard but rebuilt against OrianBuilder's Card/Button primitives
 * and the project's sonner toaster (instead of the standalone app's native
 * Electron notification).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  RefreshCw,
  Plus,
  Trash2,
  ChevronDown,
  ChevronRight,
  Loader2,
  Star,
  ShoppingCart,
  BellRing,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

import type { WatchdogApi, PricePoint, Product } from "./api";
import { PriceHistoryChart } from "./PriceHistoryChart";

interface Analytics {
  high: number;
  low: number;
  avg: number;
}

function calculateAnalytics(points: PricePoint[]): Analytics | null {
  if (points.length === 0) return null;
  const prices = points.map((p) => p.price);
  return {
    high: Math.max(...prices),
    low: Math.min(...prices),
    avg: prices.reduce((a, b) => a + b, 0) / prices.length,
  };
}

export function PriceMonitor({ api }: { api: WatchdogApi }) {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [urlInput, setUrlInput] = useState("");
  const [targetInput, setTargetInput] = useState("");
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [history, setHistory] = useState<Record<number, PricePoint[]>>({});

  const refresh = useCallback(async () => {
    try {
      const list = await api.listProducts();
      setProducts(list);
    } catch (err) {
      toast.error("Could not load products", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const loadHistory = useCallback(
    async (id: number) => {
      try {
        const points = await api.productHistory(id);
        setHistory((prev) => ({ ...prev, [id]: points }));
      } catch (err) {
        toast.error("Couldn't load price history", {
          description: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [api],
  );

  const onAdd = useCallback(async () => {
    const url = urlInput.trim();
    if (!url) return;
    setAdding(true);
    try {
      const rawTarget = targetInput.trim();
      const parsed = rawTarget ? Number(rawTarget) : null;
      const target =
        parsed !== null && !Number.isNaN(parsed) && parsed > 0 ? parsed : null;
      const created = await api.addProduct(url, target);
      setUrlInput("");
      setTargetInput("");
      await refresh();
      // Auto-open the graph on the newly added product so users immediately
      // see the seed data point.
      setExpandedId(created.id);
      await loadHistory(created.id);
      toast.success("Product tracked");
    } catch (err) {
      toast.error("Failed to track product", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setAdding(false);
    }
  }, [api, urlInput, targetInput, refresh, loadHistory]);

  const onCheck = useCallback(
    async (id: number) => {
      setBusyId(id);
      try {
        const updated = await api.checkProduct(id);
        setProducts((prev) => prev.map((p) => (p.id === id ? updated : p)));
        // Fire a toast (and let the OS surface it via sonner's stack) when the
        // recheck hits the user's target — the equivalent of the standalone
        // app's native Electron notification.
        if (
          updated.current_price !== null &&
          updated.target_price !== null &&
          updated.current_price <= updated.target_price
        ) {
          const symbol = updated.current_currency || "₹";
          toast.success("Price drop alert", {
            description: `Now ${symbol}${updated.current_price.toFixed(2)} — at or below your ${symbol}${updated.target_price.toFixed(2)} target.`,
            duration: 8_000,
          });
        }
        if (expandedId === id) await loadHistory(id);
      } catch (err) {
        toast.error("Check failed", {
          description: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setBusyId(null);
      }
    },
    [api, expandedId, loadHistory],
  );

  const onRemove = useCallback(
    async (id: number) => {
      try {
        await api.removeProduct(id);
        setProducts((prev) => prev.filter((p) => p.id !== id));
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
      if (!history[id]) await loadHistory(id);
    },
    [expandedId, history, loadHistory],
  );

  return (
    <div className="space-y-4">
      <div className="grid gap-2 md:grid-cols-[1fr_180px_auto]">
        <Input
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void onAdd();
          }}
          placeholder="https://shop.example.com/item"
          disabled={adding}
        />
        <Input
          value={targetInput}
          onChange={(e) => setTargetInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void onAdd();
          }}
          placeholder="Target price (optional)"
          inputMode="decimal"
          disabled={adding}
        />
        <Button onClick={onAdd} disabled={adding || !urlInput.trim()}>
          {adding ? (
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          ) : (
            <Plus className="w-4 h-4 mr-2" />
          )}
          Track
        </Button>
      </div>

      {loading ? (
        <EmptyState>
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </EmptyState>
      ) : products.length === 0 ? (
        <EmptyState>No products tracked yet.</EmptyState>
      ) : (
        <div className="space-y-3">
          {products.map((product) => {
            const isExpanded = expandedId === product.id;
            const points = history[product.id] ?? [];
            const analytics = calculateAnalytics(points);
            const symbol = product.current_currency || "₹";
            const targetSymbol = product.target_currency || symbol;
            return (
              <ProductRow
                key={product.id}
                product={product}
                isExpanded={isExpanded}
                busy={busyId === product.id}
                points={points}
                analytics={analytics}
                symbol={symbol}
                targetSymbol={targetSymbol}
                onCheck={() => void onCheck(product.id)}
                onRemove={() => void onRemove(product.id)}
                onToggle={() => void onExpand(product.id)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function ProductRow({
  product,
  isExpanded,
  busy,
  points,
  analytics,
  symbol,
  targetSymbol,
  onCheck,
  onRemove,
  onToggle,
}: {
  product: Product;
  isExpanded: boolean;
  busy: boolean;
  points: PricePoint[];
  analytics: Analytics | null;
  symbol: string;
  targetSymbol: string;
  onCheck: () => void;
  onRemove: () => void;
  onToggle: () => void;
}) {
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <button
          type="button"
          onClick={onToggle}
          className="flex flex-1 min-w-0 items-start gap-3 text-left hover:opacity-90"
        >
          {isExpanded ? (
            <ChevronDown className="w-4 h-4 mt-1 text-muted-foreground shrink-0" />
          ) : (
            <ChevronRight className="w-4 h-4 mt-1 text-muted-foreground shrink-0" />
          )}
          {product.image_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={product.image_url}
              alt=""
              className="h-14 w-14 shrink-0 rounded-3xl border border-border object-cover"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = "none";
              }}
            />
          ) : (
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-3xl border border-border bg-muted/40 text-muted-foreground">
              <BellRing className="w-4 h-4" />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs text-muted-foreground font-mono">
              {product.url}
            </div>
            <div className="mt-1 flex flex-wrap items-baseline gap-2">
              <div className="text-xl font-semibold">
                {product.current_price !== null
                  ? `${symbol}${product.current_price.toFixed(2)}`
                  : "—"}
              </div>
              {product.rating !== null && (
                <RatingBadge
                  rating={product.rating}
                  count={product.rating_count}
                />
              )}
            </div>
            <div className="text-xs text-muted-foreground">
              Target:{" "}
              {product.target_price !== null
                ? `${targetSymbol}${product.target_price.toFixed(2)}`
                : "not set"}
            </div>
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
        <div className="mt-4 space-y-4 border-t border-border pt-4">
          {analytics && (
            <>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <StatCard
                  label="Lowest"
                  value={`${symbol}${analytics.low.toFixed(2)}`}
                  tone="good"
                />
                <StatCard
                  label="Highest"
                  value={`${symbol}${analytics.high.toFixed(2)}`}
                  tone="bad"
                />
                <StatCard
                  label="Average"
                  value={`${symbol}${analytics.avg.toFixed(2)}`}
                />
                <StatCard label="Checks" value={String(points.length)} />
              </div>
              <DealIndicator
                current={product.current_price}
                analytics={analytics}
                target={product.target_price}
                symbol={symbol}
              />
            </>
          )}
          <PriceHistoryChart
            points={points}
            symbol={symbol}
            chartId={product.id}
          />
          <PriceSummaryRow
            points={points}
            current={product.current_price}
            symbol={symbol}
            productUrl={product.url}
          />
        </div>
      )}
    </Card>
  );
}

function RatingBadge({
  rating,
  count,
}: {
  rating: number;
  count: number | null;
}) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-3xl border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-600 dark:text-amber-300"
      title={count !== null ? `${count.toLocaleString()} ratings` : undefined}
    >
      <Star className="w-2.5 h-2.5 fill-amber-500 text-amber-500" />
      <span className="font-medium">{rating.toFixed(1)}</span>
      {count !== null && (
        <span className="opacity-60">({count.toLocaleString()})</span>
      )}
    </span>
  );
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "good" | "bad";
}) {
  return (
    <div
      className={cn(
        "rounded-3xl border bg-card p-3",
        tone === "good" && "border-emerald-500/40 bg-emerald-500/5",
        tone === "bad" && "border-red-500/40 bg-red-500/5",
      )}
    >
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          "mt-1 text-base font-semibold",
          tone === "good" && "text-emerald-600 dark:text-emerald-300",
          tone === "bad" && "text-red-600 dark:text-red-300",
        )}
      >
        {value}
      </div>
    </div>
  );
}

function DealIndicator({
  current,
  analytics,
  target,
  symbol,
}: {
  current: number | null;
  analytics: Analytics;
  target: number | null;
  symbol: string;
}) {
  if (current === null) {
    return (
      <div className="rounded-3xl border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
        No current price yet — click <strong>Check now</strong> to record one.
      </div>
    );
  }
  const sameLow = current <= analytics.low + 0.001;
  const sameHigh =
    current >= analytics.high - 0.001 && analytics.high > analytics.low;
  const aboveLow = current - analytics.low;
  const offHigh = analytics.high - current;
  const hitTarget = target !== null && current <= target;

  let toneClass = "border-border bg-muted/30 text-foreground";
  let icon = "•";
  let message: React.ReactNode;

  if (hitTarget) {
    toneClass =
      "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200";
    icon = "✓";
    message = (
      <>
        Target hit — now at{" "}
        <strong>
          {symbol}
          {current.toFixed(2)}
        </strong>{" "}
        (you set {symbol}
        {target.toFixed(2)}).
      </>
    );
  } else if (sameLow) {
    toneClass =
      "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200";
    icon = "★";
    message = (
      <>
        Best deal — current price{" "}
        <strong>
          {symbol}
          {current.toFixed(2)}
        </strong>{" "}
        is the lowest seen
        {offHigh > 0 && (
          <>
            {" "}
            ({symbol}
            {offHigh.toFixed(2)} below the highest)
          </>
        )}
        .
      </>
    );
  } else if (sameHigh) {
    toneClass =
      "border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-300";
    icon = "▲";
    message = (
      <>
        Worst price so far — {symbol}
        {aboveLow.toFixed(2)} above the lowest ({symbol}
        {analytics.low.toFixed(2)}). Worth waiting.
      </>
    );
  } else {
    message = (
      <>
        {symbol}
        {aboveLow.toFixed(2)} above the lowest ({symbol}
        {analytics.low.toFixed(2)}).{" "}
        {target !== null
          ? `${symbol}${(current - target).toFixed(2)} above your target.`
          : "Set a target price to get a drop alert."}
      </>
    );
  }

  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-3xl border px-3 py-2 text-sm",
        toneClass,
      )}
    >
      <span className="font-semibold">{icon}</span>
      <span className="flex-1">{message}</span>
    </div>
  );
}

function PriceSummaryRow({
  points,
  current,
  symbol,
  productUrl,
}: {
  points: PricePoint[];
  current: number | null;
  symbol: string;
  productUrl: string;
}) {
  const summary = useMemo(() => {
    if (points.length === 0) return null;
    const prices = points.map((p) => p.price);
    const lowest = Math.min(...prices);
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
    const lowestTimestamp = points.find((p) => p.price === lowest)?.timestamp;

    let dropChance = 0;
    if (points.length >= 2) {
      let drops = 0;
      for (let i = 1; i < points.length; i++) {
        if (points[i].price < points[i - 1].price) drops++;
      }
      dropChance = Math.round((drops / (points.length - 1)) * 100);
    }
    const verdict =
      dropChance >= 40
        ? {
            label: "High chance of price drop",
            tone: "text-amber-600 dark:text-amber-300",
            advice: "Worth waiting a bit.",
          }
        : dropChance >= 15
          ? {
              label: "Moderate chance",
              tone: "text-foreground",
              advice: "Could go either way.",
            }
          : {
              label: "Low chance of price drop",
              tone: "text-emerald-600 dark:text-emerald-300",
              advice: "You can buy now.",
            };

    return { lowest, avg, lowestTimestamp, dropChance, verdict };
  }, [points]);

  if (!summary) return null;

  let deltaNote: React.ReactNode = null;
  if (current !== null) {
    const delta = current - summary.lowest;
    if (delta > 0.001) {
      deltaNote = (
        <span className="text-emerald-600 dark:text-emerald-400">
          (lower than current by {symbol}
          {delta.toLocaleString(undefined, { maximumFractionDigits: 2 })})
        </span>
      );
    } else {
      deltaNote = (
        <span className="text-emerald-600 dark:text-emerald-400">
          (you're at the lowest seen)
        </span>
      );
    }
  }

  return (
    <div className="rounded-3xl border border-border bg-muted/20 p-3">
      <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto]">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Lowest till date
          </div>
          <div className="mt-1 text-lg font-semibold text-emerald-600 dark:text-emerald-300">
            {symbol}
            {summary.lowest.toLocaleString(undefined, {
              maximumFractionDigits: 2,
            })}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {summary.lowestTimestamp &&
              new Date(summary.lowestTimestamp).toLocaleDateString()}{" "}
            {deltaNote}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Average
          </div>
          <div className="mt-1 text-lg font-semibold">
            {symbol}
            {summary.avg.toLocaleString(undefined, {
              maximumFractionDigits: 2,
            })}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            across {points.length} checks
          </div>
        </div>
        <div className="flex flex-col gap-2 md:items-end">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Drop chance
            </div>
            <div
              className={cn("mt-1 text-sm font-medium", summary.verdict.tone)}
            >
              {summary.dropChance}% — {summary.verdict.label}
            </div>
            <div className="text-xs text-muted-foreground">
              {summary.verdict.advice}
            </div>
          </div>
          <a
            href={productUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center justify-center gap-2 rounded-3xl bg-orange-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-orange-400 transition-colors"
          >
            <ShoppingCart className="w-3.5 h-3.5" />
            Buy It Now
          </a>
        </div>
      </div>
    </div>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-center gap-2 py-12 rounded-2xl border border-dashed border-border text-sm text-muted-foreground">
      {children}
    </div>
  );
}
