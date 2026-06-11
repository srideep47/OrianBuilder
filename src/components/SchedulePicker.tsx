import { useMemo } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * "Now or schedule" picker reused by both publish dialogs.
 *
 * Renders a native datetime-local input and a small "presets" row (in 1h /
 * tomorrow morning) so the common cases don't require manual typing. The
 * parent owns the timestamp state (epoch ms or null).
 *
 * `null` means "publish now"; a number means "fire at that epoch-ms".
 */
export function SchedulePicker({
  value,
  onChange,
  disabled,
}: {
  value: number | null;
  onChange: (next: number | null) => void;
  disabled?: boolean;
}) {
  // datetime-local expects "YYYY-MM-DDTHH:mm" in **local** time.
  const inputValue = useMemo(() => {
    if (value === null) return "";
    const d = new Date(value);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }, [value]);

  const setRelative = (msFromNow: number) => {
    onChange(Date.now() + msFromNow);
  };

  const minInputValue = useMemo(() => {
    // Disable picking a time in the past via the browser UI. Note that this
    // is a UX hint only; the engine treats any past time as "fire now".
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }, []);

  const isPast = value !== null && value < Date.now() - 60_000;

  return (
    <div className="space-y-2 rounded-3xl border border-border bg-muted/30 p-3">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="sched-when" className="text-xs">
          Publish at
        </Label>
        <div className="flex flex-wrap gap-1.5">
          <PresetChip
            label="In 1h"
            onClick={() => setRelative(60 * 60 * 1000)}
            disabled={disabled}
          />
          <PresetChip
            label="Tonight 8pm"
            onClick={() => {
              const d = new Date();
              d.setHours(20, 0, 0, 0);
              if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1);
              onChange(d.getTime());
            }}
            disabled={disabled}
          />
          <PresetChip
            label="Tomorrow 9am"
            onClick={() => {
              const d = new Date();
              d.setDate(d.getDate() + 1);
              d.setHours(9, 0, 0, 0);
              onChange(d.getTime());
            }}
            disabled={disabled}
          />
        </div>
      </div>
      <Input
        id="sched-when"
        type="datetime-local"
        value={inputValue}
        min={minInputValue}
        disabled={disabled}
        // The browser-native calendar picker icon is black, which is invisible
        // on the galaxy-mode dark background. `filter: invert(1)` flips it to
        // white; `opacity` softens it to muted-foreground brightness so it
        // matches the rest of the icon set. Scoped to webkit (Chromium/Electron).
        className="[&::-webkit-calendar-picker-indicator]:invert [&::-webkit-calendar-picker-indicator]:opacity-70 [&::-webkit-calendar-picker-indicator]:cursor-pointer [&::-webkit-calendar-picker-indicator]:hover:opacity-100"
        onChange={(e) => {
          const v = e.target.value;
          if (!v) {
            onChange(null);
            return;
          }
          const ms = new Date(v).getTime();
          if (Number.isFinite(ms)) onChange(ms);
        }}
      />
      {isPast && (
        <p className="text-[11px] text-amber-600">
          That time is in the past — the post will fire on the next engine tick.
        </p>
      )}
      {value !== null && !isPast && (
        <p className="text-[11px] text-muted-foreground">
          Will publish in {formatRelative(value - Date.now())}.
        </p>
      )}
    </div>
  );
}

function PresetChip({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-full border border-border bg-transparent/60 px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
    >
      {label}
    </button>
  );
}

function formatRelative(ms: number): string {
  const abs = Math.max(0, ms);
  const minutes = Math.round(abs / 60000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  const days = Math.round(hours / 24);
  return `${days} days`;
}
