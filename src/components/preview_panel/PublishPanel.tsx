import { useState, useEffect } from "react";
import { useAtomValue } from "jotai";
import { selectedAppIdAtom } from "@/atoms/appAtoms";
import { useLoadApp } from "@/hooks/useLoadApp";
import { GitHubConnector } from "@/components/GitHubConnector";
import { VercelConnector } from "@/components/VercelConnector";
import { NetlifyConnector } from "@/components/NetlifyConnector";
import { PortalMigrate } from "@/components/PortalMigrate";
import { MigrationPanel } from "@/components/MigrationPanel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { GithubCollaboratorManager } from "@/components/GithubCollaboratorManager";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

export const PublishPanel = () => {
  const selectedAppId = useAtomValue(selectedAppIdAtom);
  const { app, loading } = useLoadApp(selectedAppId);
  const [deployProvider, setDeployProvider] = useState<"vercel" | "netlify">(
    "vercel",
  );

  const vercelConnected = !!app?.vercelProjectId;
  const netlifyConnected = !!app?.netlifySiteId;

  // Single-choice: the non-selected provider's button is disabled, so clicking
  // it does nothing (it won't open the other provider).
  const vercelTabDisabled = deployProvider !== "vercel";
  const netlifyTabDisabled = deployProvider !== "netlify";

  // The currently selected provider is "locked in" once it has an active
  // deployment — you must disconnect it before switching, which is what keeps a
  // site deployed to only ONE provider at a time.
  const activeConnected =
    (deployProvider === "vercel" && vercelConnected) ||
    (deployProvider === "netlify" && netlifyConnected);
  const otherProvider = deployProvider === "vercel" ? "netlify" : "vercel";
  const otherProviderLabel = otherProvider === "vercel" ? "Vercel" : "Netlify";

  // Keep the active tab pinned to whichever provider is actually connected, so
  // the selection always matches the live deployment.
  useEffect(() => {
    if (vercelConnected && deployProvider !== "vercel") {
      setDeployProvider("vercel");
    } else if (netlifyConnected && deployProvider !== "netlify") {
      setDeployProvider("netlify");
    }
  }, [vercelConnected, netlifyConnected, deployProvider]);

  // Switching is only allowed via the explicit control below, and only while
  // the current provider isn't connected.
  const switchToOtherProvider = () => {
    if (activeConnected) return;
    setDeployProvider(otherProvider);
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8 text-center">
        <div className="w-12 h-12 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
          <svg
            className="w-6 h-6 text-blue-600 dark:text-blue-400 animate-spin"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="m4 12a8 8 0 0 1 8-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 0 1 4 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
        </div>
        <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
          Loading...
        </h2>
      </div>
    );
  }

  if (!selectedAppId || !app) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8 text-center">
        <div className="w-12 h-12 rounded-full bg-gray-100 dark:bg-gray-900/30 flex items-center justify-center">
          <svg
            className="w-6 h-6 text-gray-600 dark:text-gray-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
            />
          </svg>
        </div>
        <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
          No App Selected
        </h2>
        <p className="text-gray-600 dark:text-gray-400 max-w-md">
          Select an app to view publishing options.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="p-4 space-y-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-2">
            Publish App
          </h1>
        </div>

        {/* Database Migration - Show MigrationPanel if app has neon project and active branch,
            otherwise fall back to PortalMigrate for portal template apps. Only one is shown. */}
        {app.neonProjectId &&
        (app.neonActiveBranchId || app.neonDevelopmentBranchId) ? (
          <MigrationPanel appId={selectedAppId} />
        ) : app.neonProjectId &&
          app.files.some((f) => f === "payload.config.ts") ? (
          <PortalMigrate appId={selectedAppId} />
        ) : null}

        {/* GitHub Section */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2">
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                <path
                  fillRule="evenodd"
                  d="M10 0C4.477 0 0 4.484 0 10.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0110 4.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.203 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.942.359.31.678.921.678 1.856 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0020 10.017C20 4.484 15.522 0 10 0z"
                  clipRule="evenodd"
                />
              </svg>
              GitHub
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-gray-600 dark:text-gray-400">
              Sync your code to GitHub for collaboration.
            </p>
            <GitHubConnector
              appId={selectedAppId}
              folderName={app.name}
              expanded={true}
            />
            {app.githubOrg && app.githubRepo && (
              <div className="pt-4 border-t border-gray-100 dark:border-gray-800">
                <GithubCollaboratorManager appId={selectedAppId} />
              </div>
            )}
          </CardContent>
        </Card>

        {/* Deployment Section */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2">
              <svg
                className="w-5 h-5 text-blue-600 dark:text-blue-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z"
                />
              </svg>
              Deploy
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">
                Select your deployment destination
              </h3>
              <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                Please choose one platform to connect your account and publish
                your application.
              </p>
            </div>

            {/* Provider Selection (exclusive tab-switcher) */}
            <div>
              <Label className="block text-sm font-medium mb-1">
                Select Deployment Provider
              </Label>
              <div
                role="radiogroup"
                aria-label="Select Deployment Provider"
                className="flex rounded-md border border-gray-200 dark:border-gray-700"
              >
                <Button
                  type="button"
                  role="radio"
                  aria-checked={deployProvider === "vercel"}
                  disabled={vercelTabDisabled}
                  title={
                    vercelTabDisabled
                      ? "Netlify is selected. Use “Switch to Vercel” below."
                      : undefined
                  }
                  variant={deployProvider === "vercel" ? "default" : "ghost"}
                  className={`flex-1 rounded-none rounded-l-md border-0 gap-2 disabled:opacity-40 disabled:cursor-not-allowed ${
                    deployProvider === "vercel"
                      ? "bg-primary text-primary-foreground"
                      : "hover:bg-gray-50 dark:hover:bg-gray-800"
                  }`}
                  data-testid="deploy-provider-vercel"
                >
                  <svg
                    className="w-4 h-4"
                    fill="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path d="M24 22.525H0l12-21.05 12 21.05z" />
                  </svg>
                  Vercel
                </Button>
                <Button
                  type="button"
                  role="radio"
                  aria-checked={deployProvider === "netlify"}
                  disabled={netlifyTabDisabled}
                  title={
                    netlifyTabDisabled
                      ? "Vercel is selected. Use “Switch to Netlify” below."
                      : undefined
                  }
                  variant={deployProvider === "netlify" ? "default" : "ghost"}
                  className={`flex-1 rounded-none rounded-r-md border-0 border-l border-gray-200 dark:border-gray-700 gap-2 disabled:opacity-40 disabled:cursor-not-allowed ${
                    deployProvider === "netlify"
                      ? "bg-primary text-primary-foreground"
                      : "hover:bg-gray-50 dark:hover:bg-gray-800"
                  }`}
                  data-testid="deploy-provider-netlify"
                >
                  <svg
                    className="w-4 h-4"
                    fill="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path d="M16.934 8.519a1.044 1.044 0 0 1 .303.23l2.349-1.045-2.192-2.171-.491 2.954zM12.06 6.546a1.305 1.305 0 0 1 .209.574l3.497 1.482a1.044 1.044 0 0 1 .355-.177l.574-3.45-2.13-2.234-2.505 3.31v.025zM23.917 11.426l-3.282-3.293-2.766 1.234.005.005 4.553 1.93a.36.36 0 0 1 .067.038c.491-.067.957.067 1.423.086zM3.36 13.946l-1.69-1.71L0 13.91l2.602 1.105.758-1.07zM12.957 17.06l-.121.064-1.39 6.876h.04l2.49-3.288-.998-3.673a1.305 1.305 0 0 1-.021.021zM10.836 16.685l-3.575-1.515a.792.792 0 0 1-.046.111L4.1 19.762l8.183-2.516a1.044 1.044 0 0 1-.045-.13l-1.402-.431zM7.18 13.673l3.466 1.47a1.305 1.305 0 0 1 .55-.394l.617-3.722a1.305 1.305 0 0 1-.428-.297l-3.598 1.564a.792.792 0 0 1 .005.214l-.612 1.165z" />
                  </svg>
                  Netlify
                </Button>
              </div>
              {activeConnected ? (
                <p className="text-xs text-amber-600 dark:text-amber-400 mt-2">
                  Your app is deployed to{" "}
                  {deployProvider === "vercel" ? "Vercel" : "Netlify"}.
                  Disconnect it below to switch to {otherProviderLabel}.
                </p>
              ) : (
                <button
                  type="button"
                  onClick={switchToOtherProvider}
                  className="text-xs text-blue-600 dark:text-blue-400 hover:underline mt-2"
                  data-testid="deploy-switch-provider"
                >
                  Switch to {otherProviderLabel}
                </button>
              )}
            </div>

            {/* Dynamic provider content — only one is ever rendered */}
            {deployProvider === "vercel" ? (
              <div data-testid="deploy-provider-content-vercel">
                <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
                  Publish your app by deploying it to Vercel.
                </p>
                {!app?.githubOrg || !app?.githubRepo ? (
                  <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-4">
                    <div className="flex items-start gap-3">
                      <svg
                        className="w-5 h-5 text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.732 16.5c-.77.833.192 2.5 1.732 2.5z"
                        />
                      </svg>
                      <div>
                        <h3 className="text-sm font-medium text-amber-800 dark:text-amber-200">
                          GitHub Required for Vercel Deployment
                        </h3>
                        <p className="text-sm text-amber-700 dark:text-amber-300 mt-1">
                          Deploying to Vercel requires connecting to GitHub
                          first. Please set up your GitHub repository above.
                        </p>
                      </div>
                    </div>
                  </div>
                ) : (
                  <VercelConnector
                    appId={selectedAppId}
                    folderName={app.name}
                  />
                )}
              </div>
            ) : (
              <div data-testid="deploy-provider-content-netlify">
                <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
                  Publish your app by deploying it to Netlify.
                </p>
                <NetlifyConnector appId={selectedAppId} folderName={app.name} />
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
};
