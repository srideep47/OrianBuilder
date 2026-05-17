import { useSettings } from "@/hooks/useSettings";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { Bot, AlertTriangle } from "lucide-react";
import { showInfo } from "@/lib/toast";

export function AutonomousModeSwitch({
  showToast = true,
  compact = false,
}: {
  showToast?: boolean;
  compact?: boolean;
}) {
  const { settings, updateSettings } = useSettings();
  const isOn = !!settings?.autonomousMode;

  const onToggle = () => {
    updateSettings({ autonomousMode: !isOn });
    if (!isOn && showToast) {
      showInfo(
        "Autonomous mode ON. The agent will use the mission autonomy policy, auto-continue between turns, and auto-restart the app on errors. Disable any time from chat input.",
      );
    }
  };

  return (
    <div className="flex items-center gap-2">
      <Tooltip>
        <TooltipTrigger
          render={
            <div
              className={
                compact
                  ? "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 transition-colors " +
                    (isOn
                      ? "border-primary/40 bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:text-foreground")
                  : "flex items-center space-x-2"
              }
              role="group"
            />
          }
        >
          <Bot size={compact ? 14 : 16} />
          <Switch
            id="autonomous-mode"
            aria-label="Autonomous build mode"
            checked={isOn}
            onCheckedChange={onToggle}
          />
          <Label
            htmlFor="autonomous-mode"
            className={compact ? "text-xs cursor-pointer" : ""}
          >
            {compact ? "Auto-pilot" : "Autonomous mode"}
          </Label>
        </TooltipTrigger>
        <TooltipContent>
          <div className="max-w-xs space-y-1.5">
            <p className="font-medium">Autonomous (Auto-pilot) mode</p>
            <p className="text-xs">
              Agent runs unattended with the mission autonomy policy:
              auto-continues when it pauses and auto-restarts on errors. Capped
              by <code className="text-xs">maxToolCallSteps</code>.
            </p>
            <p className="text-xs flex items-start gap-1.5">
              <AlertTriangle
                size={12}
                className="text-amber-500 mt-0.5 flex-shrink-0"
              />
              <span>
                Low and medium-risk actions may run without prompts. High-risk
                host actions still ask, and critical destructive actions are
                blocked.
              </span>
            </p>
          </div>
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
