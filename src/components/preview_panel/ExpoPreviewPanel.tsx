import { useAtomValue } from "jotai";
import { appConsoleEntriesAtom } from "@/atoms/appAtoms";
import { QRCodeSVG } from "qrcode.react";
import { useMemo, useState } from "react";
import {
  Smartphone,
  ExternalLink,
  Loader2,
  RefreshCw,
  Copy,
  Check,
} from "lucide-react";
import { ipc } from "@/ipc/types";
import { cn } from "@/lib/utils";

// Expo Metro outputs lines like:
//   › Metro waiting on exp://192.168.1.5:8081
//   › Metro waiting on exp://localhost:8081
//   exp://... (various formats)
const EXPO_URL_RE = /exp:\/\/[^\s\]"',]+/;

function extractExpoUrl(message: string): string | null {
  const m = EXPO_URL_RE.exec(message);
  return m ? m[0] : null;
}

interface ExpoPreviewPanelProps {
  appId: number;
}

export function ExpoPreviewPanel({ appId }: ExpoPreviewPanelProps) {
  const consoleEntries = useAtomValue(appConsoleEntriesAtom);
  const [copied, setCopied] = useState(false);

  // Scan console entries newest-first so we get the most recent URL
  const expoUrl = useMemo(() => {
    for (let i = consoleEntries.length - 1; i >= 0; i--) {
      const entry = consoleEntries[i];
      if (entry.appId !== appId) continue;
      const url = extractExpoUrl(entry.message);
      if (url) return url;
    }
    return null;
  }, [consoleEntries, appId]);

  // Expo web dev server runs on 8081 by default
  const webPreviewUrl = "http://localhost:8081";

  const handleCopy = async () => {
    if (!expoUrl) return;
    await navigator.clipboard.writeText(expoUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleOpenWeb = () => {
    ipc.system.openExternalUrl(webPreviewUrl);
  };

  if (!expoUrl) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-center p-8">
        <div className="flex flex-col items-center gap-3">
          <div className="relative">
            <Smartphone
              size={48}
              className="text-gray-300 dark:text-gray-600"
            />
            <Loader2
              size={20}
              className="absolute -bottom-1 -right-1 animate-spin text-primary"
            />
          </div>
          <h2 className="text-base font-semibold text-gray-700 dark:text-gray-300">
            Starting Expo...
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 max-w-xs">
            Metro bundler is starting. The QR code will appear once it&apos;s
            ready.
          </p>
        </div>
        <div className="mt-4 flex flex-col gap-2 items-center">
          <p className="text-xs text-gray-400 dark:text-gray-500">
            Watching console for{" "}
            <code className="bg-gray-100 dark:bg-gray-800 px-1 rounded">
              exp://
            </code>{" "}
            URL...
          </p>
          <button
            onClick={handleOpenWeb}
            className="flex items-center gap-1.5 text-xs text-primary hover:underline"
          >
            <ExternalLink size={12} />
            Try web preview at localhost:8081
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center h-full gap-5 p-8 overflow-auto">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Smartphone size={20} className="text-primary" />
        <h2 className="text-base font-semibold">Expo Go Preview</h2>
      </div>

      {/* Instruction */}
      <p className="text-sm text-gray-500 dark:text-gray-400 text-center max-w-xs">
        Scan with{" "}
        <strong className="text-gray-700 dark:text-gray-300">Expo Go</strong> on
        Android or the{" "}
        <strong className="text-gray-700 dark:text-gray-300">Camera app</strong>{" "}
        on iOS to open on your device
      </p>

      {/* QR Code */}
      <div className="p-4 bg-white rounded-2xl shadow-lg border border-gray-100 dark:border-gray-700">
        <QRCodeSVG
          value={expoUrl}
          size={220}
          bgColor="#ffffff"
          fgColor="#000000"
          level="M"
          marginSize={1}
        />
      </div>

      {/* URL with copy button */}
      <div className="flex items-center gap-2 bg-gray-100 dark:bg-gray-800 rounded-lg px-3 py-1.5 max-w-full">
        <code className="text-xs text-gray-600 dark:text-gray-300 truncate max-w-[240px]">
          {expoUrl}
        </code>
        <button
          onClick={handleCopy}
          title="Copy URL"
          className={cn(
            "p-1 rounded transition-colors flex-shrink-0",
            copied
              ? "text-green-500"
              : "text-gray-400 hover:text-gray-600 dark:hover:text-gray-200",
          )}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>

      {/* Action buttons */}
      <div className="flex flex-col sm:flex-row gap-2 items-center">
        <button
          onClick={handleOpenWeb}
          className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors"
        >
          <ExternalLink size={14} />
          Open Web Preview
        </button>
        <button
          onClick={() => ipc.system.openExternalUrl(expoUrl)}
          className="flex items-center gap-2 px-4 py-2 border border-border rounded-lg text-sm hover:bg-[var(--background-darkest)] transition-colors"
        >
          <RefreshCw size={14} />
          Open in Expo Go
        </button>
      </div>

      {/* Note */}
      <p className="text-xs text-gray-400 dark:text-gray-500 text-center max-w-xs">
        Make sure your phone is on the same Wi-Fi network as this computer
      </p>
    </div>
  );
}
