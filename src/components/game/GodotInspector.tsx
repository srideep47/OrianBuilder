import { useEffect, useMemo, useState } from "react";
import { Check, RefreshCw, Search, SlidersHorizontal, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { ipc } from "@/ipc/types";
import {
  EmptyState,
  LBadge,
  LIconButton,
  LInput,
  LoadingState,
  Panel,
} from "@/components/liquid";
import { useNodeProperties, type NodeProperty } from "./useGodot";

/**
 * The property inspector — the manual counterpart to `godot_set_property`.
 *
 * Values are edited in the same JSON-ish shape the bridge accepts, because the
 * bridge coerces from the *target's* current type: typing `{"x":1,"y":2,"z":0}`
 * into a `position` sets a Vector3, and the same text on a plain dictionary field
 * stays a dictionary. Rendering a bespoke widget per Godot type would be a large
 * surface for little gain, and would quietly disagree with what the agent does.
 */
export function GodotInspector({
  nodePath,
  className,
}: {
  nodePath: string | null;
  className?: string;
}) {
  const { properties, error, loading, refresh } = useNodeProperties(nodePath);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return properties;
    return properties.filter((p) => p.name.toLowerCase().includes(q));
  }, [properties, query]);

  return (
    <Panel
      title="Inspector"
      subtitle={nodePath ?? "no node selected"}
      icon={<SlidersHorizontal />}
      flush
      className={cn("min-h-0", className)}
      actions={
        nodePath ? (
          <LIconButton
            label="Re-read properties"
            size="compact"
            disabled={loading}
            onClick={() => void refresh()}
          >
            <RefreshCw className={loading ? "animate-spin" : undefined} />
          </LIconButton>
        ) : undefined
      }
      bodyClassName="flex min-h-0 flex-col"
    >
      {!nodePath ? (
        <EmptyState
          compact
          icon={<SlidersHorizontal />}
          title="Nothing selected"
          description="Pick a node in the scene tree to see and edit its properties live."
        />
      ) : loading && properties.length === 0 ? (
        <LoadingState compact label="properties" />
      ) : error ? (
        <EmptyState
          compact
          icon={<SlidersHorizontal />}
          title="Unavailable"
          description={error}
        />
      ) : (
        <>
          <div className="shrink-0 border-b border-white/[0.07] p-2">
            <LInput
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter properties…"
              aria-label="Filter properties"
              icon={<Search />}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {filtered.length === 0 ? (
              <EmptyState
                compact
                title={`No property matches “${query}”`}
                description="Clear the filter to see everything this node exposes."
              />
            ) : (
              filtered.map((property) => (
                <PropertyRow
                  key={property.name}
                  nodePath={nodePath}
                  property={property}
                  onSaved={refresh}
                />
              ))
            )}
          </div>
        </>
      )}
    </Panel>
  );
}

/** Renders a value as editable text. Objects become compact JSON. */
function toText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Parses editor text back into something the bridge can coerce. */
function fromText(text: string, previous: unknown): unknown {
  const trimmed = text.trim();
  if (trimmed === "") return "";
  if (typeof previous === "boolean") return trimmed === "true";
  if (typeof previous === "number") {
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : trimmed;
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // Leave it as text: the bridge will reject it with a readable error, which
      // is better than us silently sending malformed JSON as a string.
      return trimmed;
    }
  }
  if (trimmed === "true" || trimmed === "false") return trimmed === "true";
  const n = Number(trimmed);
  if (trimmed !== "" && Number.isFinite(n)) return n;
  return trimmed;
}

function PropertyRow({
  nodePath,
  property,
  onSaved,
}: {
  nodePath: string;
  property: NodeProperty;
  onSaved: () => void;
}) {
  const original = toText(property.value);
  const [draft, setDraft] = useState(original);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // Re-sync when the engine reports a new value (another edit, or the game
  // moved the node) so the field never shows a stale draft as if it were live.
  useEffect(() => {
    setDraft(original);
    setFailure(null);
  }, [original]);

  const dirty = draft !== original;

  const save = async () => {
    setSaving(true);
    setFailure(null);
    try {
      const res = await ipc.godot.call({
        action: "set_property",
        params: {
          path: nodePath,
          property: property.name,
          value: fromText(draft, property.value),
        },
      });
      if (res.ok === true) {
        onSaved();
      } else {
        setFailure((res.error as string) ?? "set_property failed");
      }
    } catch (err) {
      setFailure((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const isBoolean = typeof property.value === "boolean";

  return (
    <div className="border-b border-white/[0.06] px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-[11px] text-foreground/85">
            {property.name}
          </span>
          <span className="block text-[10px] text-muted-foreground/70">
            {property.type}
          </span>
        </span>

        {isBoolean ? (
          <button
            type="button"
            role="switch"
            aria-checked={draft === "true"}
            aria-label={`${property.name} enabled`}
            onClick={() => {
              setDraft(draft === "true" ? "false" : "true");
            }}
            className={cn(
              "relative h-5 w-9 shrink-0 rounded-full transition-colors",
              draft === "true" ? "bg-primary" : "bg-white/[0.14]",
            )}
          >
            <span
              className={cn(
                "absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform",
                draft === "true" ? "translate-x-[18px]" : "translate-x-0.5",
              )}
            />
          </button>
        ) : (
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void save();
              if (e.key === "Escape") setDraft(original);
            }}
            spellCheck={false}
            className={cn(
              "min-w-0 flex-1 rounded-[9px] border px-2 py-1 font-mono text-[11px] outline-none transition-colors",
              "bg-white/[0.05] text-foreground placeholder:text-muted-foreground/60",
              failure
                ? "border-[var(--cosmos-red)]/50"
                : dirty
                  ? "border-primary/50"
                  : "border-white/[0.09]",
            )}
          />
        )}

        {/* Commit controls only appear when there's something to commit. */}
        {dirty && (
          <span className="flex shrink-0 items-center gap-0.5">
            <LIconButton
              label={`Apply ${property.name}`}
              size="compact"
              className="h-6 w-6"
              disabled={saving}
              onClick={() => void save()}
            >
              <Check />
            </LIconButton>
            <LIconButton
              label={`Discard change to ${property.name}`}
              size="compact"
              className="h-6 w-6"
              onClick={() => setDraft(original)}
            >
              <X />
            </LIconButton>
          </span>
        )}
      </div>
      {failure && (
        <div className="mt-1.5">
          <LBadge tone="danger">{failure}</LBadge>
        </div>
      )}
    </div>
  );
}
