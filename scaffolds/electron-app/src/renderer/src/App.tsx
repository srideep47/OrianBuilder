import { useEffect, useState } from "react";

declare global {
  interface Window {
    api: {
      getVersion: () => Promise<string>;
    };
  }
}

export default function App() {
  const [version, setVersion] = useState<string>("");

  useEffect(() => {
    window.api.getVersion().then(setVersion);
  }, []);

  return (
    <main className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="text-center space-y-4">
        <h1 className="text-4xl font-bold text-gray-900">Electron App</h1>
        <p className="text-gray-500">
          Edit{" "}
          <code className="bg-gray-100 px-1 rounded font-mono text-sm">
            src/renderer/src/App.tsx
          </code>{" "}
          to get started.
        </p>
        {version && (
          <p className="text-sm text-gray-400 font-mono">v{version}</p>
        )}
        <p className="text-xs text-gray-300">
          Electron + React + Vite + Tailwind CSS
        </p>
      </div>
    </main>
  );
}
