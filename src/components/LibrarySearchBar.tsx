import { Search } from "lucide-react";
import { cn } from "@/lib/utils";

export function LibrarySearchBar({
  value,
  onChange,
  placeholder = "Search",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="mb-6 max-w-xl">
      <div
        className={cn(
          "liquid-glass-thin relative flex items-center rounded-full border border-black/[0.05] bg-white/58 transition-all duration-300 shadow-[0_12px_32px_rgba(15,23,42,0.06)] dark:border-white/[0.08] dark:bg-white/[0.05] dark:shadow-[0_12px_32px_rgba(0,0,0,0.24)]",
          "hover:bg-white/72 dark:hover:bg-white/[0.08]",
          "focus-within:border-primary/55 focus-within:ring-[3px] focus-within:ring-primary/20 focus-within:shadow-[0_14px_36px_rgba(0,122,255,0.12)]",
        )}
      >
        <Search className="absolute left-4 h-4 w-4 text-muted-foreground" />
        <input
          type="text"
          placeholder={placeholder}
          aria-label="Search library"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full bg-transparent py-2.5 pl-11 pr-4 text-sm outline-none placeholder:text-muted-foreground transition-all duration-200"
        />
      </div>
    </div>
  );
}
