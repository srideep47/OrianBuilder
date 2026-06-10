import { useEffect, useState } from "react";
import { Youtube, ExternalLink, Loader2 } from "lucide-react";
import { ipc, type YouTubeStatus } from "@/ipc/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { showSuccess, showError } from "@/lib/toast";

/**
 * Settings card for connecting a YouTube channel. Uses "bring your own" Google
 * OAuth credentials — the user creates a Desktop-app OAuth client in Google
 * Cloud, pastes the Client ID/Secret here, then connects via the browser.
 */
export function YouTubeIntegration() {
  const [status, setStatus] = useState<YouTubeStatus | null>(null);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const refresh = () =>
    ipc.youtube
      .getStatus(undefined)
      .then(setStatus)
      .catch(() => setStatus(null));

  useEffect(() => {
    void refresh();
  }, []);

  const handleSaveCredentials = async () => {
    if (!clientId.trim() || !clientSecret.trim()) {
      showError("Enter both the Client ID and Client Secret.");
      return;
    }
    setSaving(true);
    try {
      const next = await ipc.youtube.saveCredentials({
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
      });
      setStatus(next);
      setClientId("");
      setClientSecret("");
      setShowForm(false);
      showSuccess("Credentials saved. Now connect your channel.");
    } catch (err: any) {
      showError(err?.message ?? "Failed to save credentials.");
    } finally {
      setSaving(false);
    }
  };

  const handleConnect = async () => {
    setConnecting(true);
    try {
      const next = await ipc.youtube.connect(undefined);
      setStatus(next);
      showSuccess(
        next.channelTitle
          ? `Connected to ${next.channelTitle}`
          : "YouTube channel connected",
      );
    } catch (err: any) {
      showError(err?.message ?? "Failed to connect YouTube.");
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      const next = await ipc.youtube.disconnect(undefined);
      setStatus(next);
      showSuccess("YouTube disconnected.");
    } catch (err: any) {
      showError(err?.message ?? "Failed to disconnect.");
    } finally {
      setDisconnecting(false);
    }
  };

  const title = (
    <h3 className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300">
      <Youtube className="h-4 w-4 text-red-600" />
      YouTube
    </h3>
  );

  // Connected → show channel + disconnect.
  if (status?.connected) {
    return (
      <div className="flex items-center justify-between">
        <div>
          {title}
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {status.channelTitle
              ? `Connected as ${status.channelTitle}`
              : "Channel connected"}{" "}
            · Publish videos from Library → Media
          </p>
        </div>
        <Button
          onClick={handleDisconnect}
          variant="destructive"
          size="sm"
          disabled={disconnecting}
        >
          {disconnecting ? "Disconnecting…" : "Disconnect"}
        </Button>
      </div>
    );
  }

  // Credentials saved but not connected → connect button.
  if (status?.hasCredentials && !showForm) {
    return (
      <div className="flex items-center justify-between">
        <div>
          {title}
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Credentials saved. Connect your channel to start publishing.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={() => setShowForm(true)} variant="outline" size="sm">
            Edit keys
          </Button>
          <Button onClick={handleConnect} size="sm" disabled={connecting}>
            {connecting ? (
              <>
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                Connecting…
              </>
            ) : (
              "Connect channel"
            )}
          </Button>
        </div>
      </div>
    );
  }

  // No credentials yet (or editing) → setup form.
  if (!showForm && !status?.hasCredentials) {
    return (
      <div className="flex items-center justify-between">
        <div>
          {title}
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Publish generated videos to your channel.
          </p>
        </div>
        <Button onClick={() => setShowForm(true)} variant="outline" size="sm">
          Set up
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {title}
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Create a <span className="font-medium">Desktop app</span> OAuth client
        in the Google Cloud Console (enable the “YouTube Data API v3”), then
        paste its credentials below.{" "}
        <a
          href="https://console.cloud.google.com/apis/credentials"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-0.5 text-primary underline"
        >
          Open console <ExternalLink className="h-3 w-3" />
        </a>
      </p>
      <div className="space-y-2">
        <div>
          <Label htmlFor="yt-client-id" className="text-xs">
            Client ID
          </Label>
          <Input
            id="yt-client-id"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="xxxxx.apps.googleusercontent.com"
            autoComplete="off"
          />
        </div>
        <div>
          <Label htmlFor="yt-client-secret" className="text-xs">
            Client Secret
          </Label>
          <Input
            id="yt-client-secret"
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder="GOCSPX-…"
            autoComplete="off"
          />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button onClick={handleSaveCredentials} size="sm" disabled={saving}>
          {saving ? "Saving…" : "Save credentials"}
        </Button>
        <Button
          onClick={() => {
            setShowForm(false);
            setClientId("");
            setClientSecret("");
          }}
          variant="ghost"
          size="sm"
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
