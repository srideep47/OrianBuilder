import { useSettings } from "@/hooks/useSettings";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";

const DEFAULT_SECONDS = 90;
const MIN_SECONDS = 30;
const MAX_SECONDS = 300;

export function StreamStallTimeoutSetting() {
  const { settings, updateSettings } = useSettings();
  const value = settings?.streamStallTimeoutSeconds ?? DEFAULT_SECONDS;
  return (
    <div className="flex items-center gap-3">
      <Label
        htmlFor="stream-stall-timeout"
        className="text-sm whitespace-nowrap"
      >
        Stream stall timeout
      </Label>
      <Input
        id="stream-stall-timeout"
        type="number"
        min={MIN_SECONDS}
        max={MAX_SECONDS}
        step={10}
        value={value}
        onChange={(e) => {
          const next = Number.parseInt(e.target.value, 10);
          if (Number.isNaN(next)) return;
          const clamped = Math.max(MIN_SECONDS, Math.min(MAX_SECONDS, next));
          updateSettings({ streamStallTimeoutSeconds: clamped });
        }}
        className="w-24"
      />
      <span className="text-xs text-muted-foreground">
        seconds (30–300). The agent retries the stream when no tokens arrive
        within this window. Lower = faster recovery on hangs but more false
        positives on slow local models.
      </span>
    </div>
  );
}
