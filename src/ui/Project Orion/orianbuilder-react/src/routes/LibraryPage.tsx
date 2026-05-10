import { useAtom } from "jotai";
import { libFilterAtom, type LibFilter } from "@/lib/atoms";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { TabBar } from "@/components/ui/Tabs";

const FILTERS: { id: LibFilter; icon: string; label: string }[] = [
  { id: "all", icon: "⊞", label: "All" },
  { id: "themes", icon: "◎", label: "Themes" },
  { id: "prompts", icon: "◫", label: "Prompts" },
  { id: "media", icon: "✦", label: "Media" },
];

export function LibraryPage() {
  const [filter, setFilter] = useAtom(libFilterAtom);

  return (
    <div className="lib-shell">
      <aside className="lib-aside">
        <div className="head">⊟ Library</div>
        {FILTERS.map((f) => (
          <button
            key={f.id}
            className={`lib-item ${filter === f.id ? "active" : ""}`}
            onClick={() => setFilter(f.id)}
            type="button"
          >
            <span>{f.icon}</span> {f.label}
          </button>
        ))}
      </aside>

      <div className="lib-content">
        <div
          className="row between"
          style={{ marginBottom: 14, flexWrap: "wrap", gap: 10 }}
        >
          <div>
            <span className="eyebrow">⊟ Archive</span>
            <h1 className="page-title" style={{ fontSize: 22, marginTop: 5 }}>
              Library
            </h1>
          </div>
          <Button variant="primary" size="sm">
            + New ▾
          </Button>
        </div>

        <div className="search-pill" style={{ marginBottom: 14 }}>
          <span className="si">⌕</span>
          <Input placeholder="Search themes and prompts…" />
        </div>

        <TabBar
          value={filter}
          onValueChange={(v) => setFilter(v as LibFilter)}
          options={FILTERS.map((f) => ({ value: f.id, label: f.label }))}
          className="!mb-[18px]"
        />

        <div className="glass empty-zone">
          <div className="galaxy-mini" aria-hidden />
          <h3>No items in your library yet</h3>
          <p>Create or import themes, prompts, and media to get started.</p>
          <Button variant="primary" size="sm">
            + Add First Item
          </Button>
        </div>
      </div>
    </div>
  );
}
