import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { showError, showSuccess } from "@/lib/toast";
import { queryKeys } from "@/lib/queryKeys";
import { ipc } from "@/ipc/types";
import { FolderOpen, RotateCcw, HardDrive } from "lucide-react";

function formatGB(bytes: number | null): string {
  if (bytes == null) return "unknown";
  return `${(bytes / 1024 ** 3).toFixed(1)} GB free`;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function AppDataLocationSelector() {
  const [isBusy, setIsBusy] = useState(false);
  const queryClient = useQueryClient();

  const appDataDirQuery = useQuery({
    queryKey: queryKeys.system.appDataDir,
    queryFn: () => ipc.system.getAppDataDir(),
    meta: {
      showErrorToast: true,
      errorMessage: "Failed to fetch app data folder",
    },
  });

  const setAppDataDirMutation = useMutation({
    mutationFn: (parentDir: string | null) =>
      ipc.system.setAppDataDir(parentDir),
    onSuccess: async (result) => {
      if (result.requiresRestart) {
        showSuccess(
          result.moved
            ? "App data copied. Restarting OrianBuilder to use the new location..."
            : "App data location updated. Restarting OrianBuilder...",
        );
        setTimeout(() => {
          ipc.system.restartOrianBuilder();
        }, 1200);
      } else {
        await queryClient.invalidateQueries({
          queryKey: queryKeys.system.appDataDir,
        });
        showSuccess("App data location is already set.");
        setIsBusy(false);
      }
    },
    onError: (error) => {
      showError(`Failed to set app data folder: ${getErrorMessage(error)}`);
      setIsBusy(false);
    },
  });

  const dataDir = appDataDirQuery.data?.path ?? "Loading...";
  const isPathAvailable = appDataDirQuery.data?.isPathAvailable ?? true;
  const isPathDefault = appDataDirQuery.data?.isPathDefault ?? true;
  const freeBytes = appDataDirQuery.data?.freeBytes ?? null;

  const applyRelocation = (parentDir: string | null) => {
    setIsBusy(true);
    setAppDataDirMutation.mutate(parentDir);
  };

  const handleSelect = async () => {
    setIsBusy(true);
    try {
      const result = await ipc.system.selectAppDataDir();
      if (result.path) {
        applyRelocation(result.path);
      } else if (result.path === null && result.canceled === false) {
        showError(
          "Unable to use selected folder. Ensure it is a valid directory with write permissions.",
        );
        setIsBusy(false);
      } else {
        setIsBusy(false);
      }
    } catch (error: unknown) {
      showError(`Failed to select app data folder: ${getErrorMessage(error)}`);
      setIsBusy(false);
    }
  };

  const handleResetToDefault = () => applyRelocation(null);

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="flex gap-2 items-center flex-wrap">
          <Label className="text-sm font-medium">
            App Data & Model Storage
          </Label>

          <Button
            onClick={handleSelect}
            disabled={isBusy}
            variant="outline"
            size="sm"
            className="flex items-center gap-2"
            data-testid="app-data-dir-button"
          >
            <FolderOpen className="w-4 h-4" />
            {isBusy ? "Working..." : "Change Location"}
          </Button>

          {!isPathDefault && (
            <Button
              onClick={handleResetToDefault}
              disabled={isBusy}
              variant="ghost"
              size="sm"
              className="flex items-center gap-2"
            >
              <RotateCcw className="w-4 h-4" />
              Reset to Default
            </Button>
          )}
        </div>

        <div className="p-3 bg-gray-50 dark:bg-gray-800 rounded-2xl border border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
              {isPathDefault ? "Default Location:" : "Custom Location:"}
            </span>
            <span className="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-1">
              <HardDrive className="w-3 h-3" />
              {formatGB(freeBytes)}
            </span>
          </div>
          <p
            className={`text-sm font-mono ${
              isPathAvailable
                ? "text-gray-700 dark:text-gray-300"
                : "text-red-800 dark:text-red-400"
            } break-all max-h-32 overflow-y-auto`}
          >
            {dataDir}
          </p>
        </div>

        <div className="text-sm text-gray-500 dark:text-gray-400">
          <p>
            {isPathAvailable
              ? "Where OrianBuilder stores its database, settings, and downloaded AI models (images, video, 3D, music - can be tens of GB). Move this to a drive with more free space if model downloads fail. Changing the location copies your existing data and restarts the app."
              : "Your app data folder is inaccessible. Make sure the drive is connected and the folder has write permissions, or change/reset it."}
          </p>
        </div>
      </div>
    </div>
  );
}
