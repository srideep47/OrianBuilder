import { useAtomValue } from "jotai";
import { appConsoleEntriesAtom } from "@/atoms/appAtoms";
import { useMemo, useState } from "react";
import { AppWindow, RotateCw, TerminalSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ipc } from "@/ipc/types";
import { showError, showSuccess } from "@/lib/toast";

interface ElectronPreviewPanelProps {
  appId: number;
}

export function ElectronPreviewPanel({ appId }: ElectronPreviewPanelProps) {
  const consoleEntries = useAtomValue(appConsoleEntriesAtom);
  const [isRestarting, setIsRestarting] = useState(false);
  const latestMessage = useMemo(() => {
    for (let i = consoleEntries.length - 1; i >= 0; i--) {
      const entry = consoleEntries[i];
      if (entry.appId === appId && entry.message.trim()) {
        return entry.message.trim();
      }
    }
    return null;
  }, [consoleEntries, appId]);

  const restart = async () => {
    setIsRestarting(true);
    try {
      await ipc.app.restartApp({ appId });
      showSuccess("Electron app restarted");
    } catch (error) {
      showError(error);
    } finally {
      setIsRestarting(false);
    }
  };

  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 p-8 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-lg border border-border bg-muted/30">
        <AppWindow size={28} className="text-primary" />
      </div>
      <div className="space-y-2">
        <h2 className="text-base font-semibold">Electron Desktop Preview</h2>
        <p className="max-w-md text-sm text-muted-foreground">
          Desktop apps run in their own Electron window. Use this panel to watch
          startup output and restart the native preview process.
        </p>
      </div>
      <Button
        onClick={restart}
        disabled={isRestarting}
        variant="outline"
        className="gap-2"
      >
        <RotateCw
          className={isRestarting ? "h-4 w-4 animate-spin" : "h-4 w-4"}
        />
        Restart Desktop App
      </Button>
      <div className="w-full max-w-lg rounded-lg border border-border bg-muted/20 p-3 text-left">
        <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <TerminalSquare size={14} />
          Latest output
        </div>
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">
          {latestMessage ?? "Waiting for Electron startup output..."}
        </pre>
      </div>
    </div>
  );
}
