import { useMemo, useState } from "react";
import {
  Box,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  FileCode2,
  Layers,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ipc } from "@/ipc/types";
import {
  EmptyState,
  LIconButton,
  LInput,
  LoadingState,
  Panel,
} from "@/components/liquid";
import type { SceneNode } from "./useGodot";

/**
 * The live scene tree, as an actual tree you can navigate.
 *
 * Reads from the running engine, not from the `.tscn` on disk — so it reflects
 * what the agent just built in memory, which is the state you need to inspect
 * before deciding whether to save it.
 */
export function GodotSceneTree({
  root,
  error,
  loading,
  selected,
  onSelect,
  onRefresh,
  className,
}: {
  root: SceneNode | null;
  error: string | null;
  loading: boolean;
  selected: string | null;
  onSelect: (path: string) => void;
  onRefresh: () => void;
  className?: string;
}) {
  const [query, setQuery] = useState("");

  const nodeCount = useMemo(() => (root ? countNodes(root) : 0), [root]);

  return (
    <Panel
      title="Scene"
      subtitle={
        root ? `${nodeCount} nodes · live from the engine` : "no scene loaded"
      }
      icon={<Layers />}
      flush
      className={cn("min-h-0", className)}
      actions={
        <LIconButton
          label="Re-read the scene tree"
          size="compact"
          disabled={loading}
          onClick={onRefresh}
        >
          <RefreshCw className={loading ? "animate-spin" : undefined} />
        </LIconButton>
      }
      bodyClassName="flex min-h-0 flex-col"
    >
      {root && nodeCount > 12 && (
        <div className="shrink-0 border-b border-white/[0.07] p-2">
          <LInput
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by name or class…"
            aria-label="Filter scene nodes"
            icon={<Search />}
          />
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {loading && !root ? (
          <LoadingState compact label="scene" />
        ) : error ? (
          <EmptyState
            compact
            icon={<Layers />}
            title="No scene"
            description={error}
          />
        ) : !root ? (
          <EmptyState
            compact
            icon={<Layers />}
            title="Nothing loaded"
            description="Start the engine to inspect its live scene tree."
          />
        ) : (
          <TreeRow
            node={root}
            depth={0}
            query={query.trim().toLowerCase()}
            selected={selected}
            onSelect={onSelect}
            onRefresh={onRefresh}
          />
        )}
      </div>
    </Panel>
  );
}

function countNodes(node: SceneNode): number {
  return 1 + (node.children ?? []).reduce((sum, c) => sum + countNodes(c), 0);
}

/** True when this node or any descendant matches, so filtering keeps ancestors. */
function matches(node: SceneNode, query: string): boolean {
  if (!query) return true;
  if (
    node.name.toLowerCase().includes(query) ||
    node.class.toLowerCase().includes(query)
  ) {
    return true;
  }
  return (node.children ?? []).some((c) => matches(c, query));
}

function TreeRow({
  node,
  depth,
  query,
  selected,
  onSelect,
  onRefresh,
}: {
  node: SceneNode;
  depth: number;
  query: string;
  selected: string | null;
  onSelect: (path: string) => void;
  onRefresh: () => void;
}) {
  // Open the first three levels by default: deep enough to see the structure,
  // shallow enough that a large scene doesn't render thousands of rows at once.
  const [open, setOpen] = useState(depth < 3);
  const children = (node.children ?? []).filter((c) => matches(c, query));
  const hasChildren = children.length > 0 || (node.child_count ?? 0) > 0;
  const isSelected = selected === node.path;

  if (!matches(node, query)) return null;

  const toggleVisible = async () => {
    if (node.visible === null || node.visible === undefined) return;
    await ipc.godot.call({
      action: "set_property",
      params: { path: node.path, property: "visible", value: !node.visible },
    });
    onRefresh();
  };

  const deleteNode = async () => {
    await ipc.godot.call({
      action: "delete_node",
      params: { path: node.path },
    });
    onRefresh();
  };

  return (
    <div>
      <div
        className={cn(
          "group flex items-center gap-1 rounded-[9px] pr-1 transition-colors",
          isSelected ? "bg-primary/18" : "hover:bg-white/[0.05]",
        )}
        style={{ paddingLeft: `${depth * 12 + 2}px` }}
      >
        <button
          type="button"
          aria-label={open ? "Collapse" : "Expand"}
          onClick={() => setOpen((v) => !v)}
          className={cn(
            "flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground",
            !hasChildren && "invisible",
          )}
        >
          {open ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5" />
          )}
        </button>

        <button
          type="button"
          onClick={() => onSelect(node.path)}
          className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left outline-none"
        >
          <Box
            className={cn(
              "h-3.5 w-3.5 shrink-0",
              isSelected ? "text-primary" : "text-muted-foreground/70",
            )}
          />
          <span
            className={cn(
              "truncate text-[12px]",
              isSelected ? "font-medium text-primary" : "text-foreground",
            )}
          >
            {node.name}
          </span>
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">
            {node.class}
          </span>
          {node.script && (
            <span
              title={node.script}
              className="flex shrink-0 items-center"
              aria-label={`Script: ${node.script}`}
            >
              <FileCode2 className="h-3 w-3 text-[var(--cosmos-blue)]" />
            </span>
          )}
        </button>

        {/* Row actions appear on hover so a 200-node tree isn't a wall of icons. */}
        <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          {node.visible !== null && node.visible !== undefined && (
            <LIconButton
              label={node.visible ? "Hide this node" : "Show this node"}
              size="compact"
              className="h-6 w-6"
              onClick={() => void toggleVisible()}
            >
              {node.visible ? <Eye /> : <EyeOff />}
            </LIconButton>
          )}
          {depth > 0 && (
            <LIconButton
              label="Delete this node"
              size="compact"
              className="h-6 w-6 hover:text-[var(--cosmos-red)]"
              onClick={() => void deleteNode()}
            >
              <Trash2 />
            </LIconButton>
          )}
        </span>
      </div>

      {open &&
        children.map((child) => (
          <TreeRow
            key={child.path}
            node={child}
            depth={depth + 1}
            query={query}
            selected={selected}
            onSelect={onSelect}
            onRefresh={onRefresh}
          />
        ))}
    </div>
  );
}
