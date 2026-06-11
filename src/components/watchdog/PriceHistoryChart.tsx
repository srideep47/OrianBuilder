/**
 * Recharts price-history chart. Reads price points + a running-minimum line.
 * Stays a thin presentational component so the Price Monitor can mount and
 * unmount it freely as cards expand/collapse.
 */
import { useMemo } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { PricePoint } from "./api";

export function PriceHistoryChart({
  points,
  symbol,
  chartId,
}: {
  points: PricePoint[];
  symbol: string;
  chartId: number;
}) {
  const enriched = useMemo(() => {
    let runningMin = Infinity;
    return points.map((p) => {
      runningMin = Math.min(runningMin, p.price);
      return { ...p, minPrice: runningMin };
    });
  }, [points]);

  const fillId = `priceFill-${chartId}`;

  if (points.length === 0) {
    return (
      <div className="flex h-56 items-center justify-center rounded-3xl border border-border bg-muted/30 text-sm text-muted-foreground">
        No history data yet — click Check now to record a point.
      </div>
    );
  }

  return (
    <div className="rounded-3xl border border-border bg-muted/20 p-3">
      <div className="mb-1 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        Price Graph
      </div>
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={enriched}
            margin={{ top: 8, right: 12, left: 0, bottom: 4 }}
          >
            <defs>
              <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.45} />
                <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" />
            <XAxis
              dataKey="timestamp"
              tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
              tickFormatter={(v) =>
                new Date(v).toLocaleString(undefined, {
                  month: "short",
                  day: "numeric",
                })
              }
            />
            <YAxis
              tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
              domain={
                points.length === 1
                  ? [points[0].price * 0.9, points[0].price * 1.1]
                  : ["auto", "auto"]
              }
              tickFormatter={(v) => `${symbol}${Number(v).toLocaleString()}`}
              width={70}
            />
            <Tooltip
              contentStyle={{
                background: "hsl(var(--card))",
                border: "1px solid hsl(var(--border))",
                borderRadius: 6,
                fontSize: 12,
                color: "hsl(var(--foreground))",
              }}
              labelStyle={{ color: "hsl(var(--muted-foreground))" }}
              labelFormatter={(v) =>
                new Date(v).toLocaleString(undefined, {
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })
              }
              formatter={(v, name) => [
                `${symbol}${Number(v ?? 0).toLocaleString()}`,
                String(name ?? ""),
              ]}
            />
            <Legend
              iconType="circle"
              wrapperStyle={{
                fontSize: 12,
                color: "hsl(var(--muted-foreground))",
                paddingTop: 8,
              }}
            />
            <Area
              type="monotone"
              dataKey="price"
              name="Current Price"
              stroke="#3b82f6"
              strokeWidth={2}
              fill={`url(#${fillId})`}
              activeDot={{ r: 5, fill: "#3b82f6" }}
              isAnimationActive={false}
            />
            <Line
              type="stepAfter"
              dataKey="minPrice"
              name="Min Price"
              stroke="#10b981"
              strokeWidth={2}
              strokeDasharray="4 2"
              dot={false}
              activeDot={{ r: 4, fill: "#10b981" }}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
