import { Palette, FileText, BookOpen, Image } from "lucide-react";
import { cn } from "@/lib/utils";

export type FilterType = "all" | "themes" | "prompts" | "media";

const FILTER_OPTIONS: {
  key: FilterType;
  label: string;
  icon: typeof BookOpen;
}[] = [
  { key: "all", label: "All", icon: BookOpen },
  { key: "themes", label: "Themes", icon: Palette },
  { key: "prompts", label: "Prompts", icon: FileText },
  { key: "media", label: "Media", icon: Image },
];

export function LibraryFilterTabs({
  active,
  onChange,
}: {
  active: FilterType;
  onChange: (f: FilterType) => void;
}) {
  return (
    <div
      className="liquid-glass-thin mb-6 flex w-fit gap-1 rounded-[16px] border border-black/[0.05] p-1.5 shadow-[0_12px_32px_rgba(15,23,42,0.06)] dark:border-white/[0.08] dark:shadow-[0_12px_32px_rgba(0,0,0,0.24)]"
      role="group"
      aria-label="Library filters"
    >
      {FILTER_OPTIONS.map((opt) => (
        <button
          key={opt.key}
          type="button"
          aria-pressed={active === opt.key}
          onClick={() => onChange(opt.key)}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-[12px] px-4 py-1.5 text-[13px] font-medium transition-all duration-200",
            active === opt.key
              ? "bg-card text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.72),0_10px_20px_rgba(15,23,42,0.08)] ring-1 ring-black/5 dark:ring-white/10"
              : "text-muted-foreground hover:bg-black/[0.04] hover:text-foreground dark:hover:bg-white/[0.06]",
          )}
        >
          <opt.icon className="h-4 w-4" />
          {opt.label}
        </button>
      ))}
    </div>
  );
}
