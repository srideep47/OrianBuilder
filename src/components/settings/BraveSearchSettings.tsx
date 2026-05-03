import { useState } from "react";
import { useSettings } from "@/hooks/useSettings";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { showSuccess, showError } from "@/lib/toast";
import { Eye, EyeOff, ExternalLink } from "lucide-react";

export function BraveSearchSettings() {
  const { settings, updateSettings } = useSettings();
  const [apiKey, setApiKey] = useState(
    settings?.braveSearchApiKey?.value ?? "",
  );
  const [showKey, setShowKey] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const savedKey = settings?.braveSearchApiKey?.value ?? "";
  const isDirty = apiKey !== savedKey;

  async function handleSave() {
    setIsSaving(true);
    try {
      await updateSettings({
        braveSearchApiKey: apiKey
          ? { value: apiKey, encryptionType: "electron-safe-storage" }
          : undefined,
      });
      showSuccess(
        apiKey
          ? "Brave Search API key saved. Web searches will now use Brave."
          : "Brave Search API key removed. Falling back to DuckDuckGo.",
      );
    } catch (err) {
      showError(err instanceof Error ? err.message : "Failed to save API key");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium text-gray-900 dark:text-white">
            Brave Search
          </h3>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            Provides structured, reliable search results for the agent's{" "}
            <code className="font-mono">web_search</code> tool. Falls back to
            DuckDuckGo automatically when no key is set.
          </p>
        </div>
        <a
          href="https://api.search.brave.com/register"
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:underline whitespace-nowrap"
        >
          Get free key
          <ExternalLink className="size-3" />
        </a>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="brave-api-key" className="text-xs">
          API Key{" "}
          <span className="text-gray-400 font-normal">
            (2,000 req/month free, no credit card required)
          </span>
        </Label>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Input
              id="brave-api-key"
              type={showKey ? "text" : "password"}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="BSA..."
              className="pr-9 font-mono text-sm"
            />
            <button
              type="button"
              onClick={() => setShowKey((v) => !v)}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
            >
              {showKey ? (
                <EyeOff className="size-4" />
              ) : (
                <Eye className="size-4" />
              )}
            </button>
          </div>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={!isDirty || isSaving}
          >
            {isSaving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>

      {savedKey && (
        <p className="text-xs text-green-600 dark:text-green-400">
          ✓ Brave Search is active
        </p>
      )}
      {!savedKey && (
        <p className="text-xs text-gray-400">
          Using DuckDuckGo (no key configured)
        </p>
      )}
    </div>
  );
}
