import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Globe } from "lucide-react";
import { ipc, App } from "@/ipc/types";
import { useSettings } from "@/hooks/useSettings";
import { useLoadApp } from "@/hooks/useLoadApp";
import { useNetlifyDeployments } from "@/hooks/useNetlifyDeployments";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface NetlifyConnectorProps {
  appId: number | null;
  folderName: string;
}

interface NetlifySite {
  id: string;
  name: string;
  framework?: string | null;
}

interface ConnectedNetlifyConnectorProps {
  appId: number;
  app: App;
  refreshApp: () => void;
}

interface UnconnectedNetlifyConnectorProps {
  appId: number | null;
  folderName: string;
  settings: any;
  refreshSettings: () => void;
  refreshApp: () => void;
}

function ConnectedNetlifyConnector({
  appId,
  app,
  refreshApp,
}: ConnectedNetlifyConnectorProps) {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const {
    deployments,
    isLoading: isLoadingDeployments,
    error: deploymentsError,
    getDeployments,
    disconnectProject,
    isDisconnecting,
    disconnectError,
  } = useNetlifyDeployments(appId);

  const handleGetDeployments = async () => {
    setIsRefreshing(true);
    try {
      const minLoadingTime = new Promise((resolve) => setTimeout(resolve, 750));
      await Promise.all([getDeployments(), minLoadingTime]);
      refreshApp();
    } finally {
      setIsRefreshing(false);
    }
  };

  const isLoadingOrRefreshing = isLoadingDeployments || isRefreshing;

  const handleDisconnectProject = async () => {
    await disconnectProject();
    refreshApp();
  };

  return (
    <div
      className="mt-4 w-full rounded-md"
      data-testid="netlify-connected-project"
    >
      <p className="text-sm text-gray-600 dark:text-gray-300">
        Connected to Netlify Site:
      </p>
      <a
        onClick={(e) => {
          e.preventDefault();
          ipc.system.openExternalUrl(
            `https://app.netlify.com/sites/${app.netlifySiteName}`,
          );
        }}
        className="cursor-pointer text-blue-600 hover:underline dark:text-blue-400"
        target="_blank"
        rel="noopener noreferrer"
      >
        {app.netlifySiteName}
      </a>
      {app.netlifyDeploymentUrl && (
        <div className="mt-2">
          <p className="text-sm text-gray-600 dark:text-gray-300">
            Live URL:{" "}
            <a
              onClick={(e) => {
                e.preventDefault();
                if (app.netlifyDeploymentUrl) {
                  ipc.system.openExternalUrl(app.netlifyDeploymentUrl);
                }
              }}
              className="cursor-pointer text-blue-600 hover:underline dark:text-blue-400 font-mono"
              target="_blank"
              rel="noopener noreferrer"
            >
              {app.netlifyDeploymentUrl}
            </a>
          </p>
        </div>
      )}
      <div className="mt-2 flex gap-2">
        <Button onClick={handleGetDeployments} disabled={isLoadingOrRefreshing}>
          {isLoadingOrRefreshing ? (
            <>
              <svg
                className="animate-spin h-5 w-5 mr-2 inline"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                style={{ display: "inline" }}
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                ></circle>
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                ></path>
              </svg>
              Refreshing...
            </>
          ) : (
            "Refresh Deployments"
          )}
        </Button>
        <Button
          onClick={handleDisconnectProject}
          disabled={isDisconnecting}
          variant="outline"
        >
          {isDisconnecting ? "Disconnecting..." : "Disconnect from site"}
        </Button>
      </div>
      {deploymentsError && (
        <div className="mt-2">
          <p className="text-red-600">{deploymentsError}</p>
        </div>
      )}
      {deployments.length > 0 && (
        <div className="mt-4">
          <h4 className="font-medium mb-2">Recent Deployments:</h4>
          <div className="space-y-2">
            {deployments.map((deployment) => (
              <div
                key={deployment.uid}
                className="bg-gray-50 dark:bg-gray-800 rounded-md p-3"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${
                        deployment.readyState === "READY"
                          ? "bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-300"
                          : deployment.readyState === "BUILDING"
                            ? "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/20 dark:text-yellow-300"
                            : "bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300"
                      }`}
                    >
                      {deployment.readyState}
                    </span>
                    <span className="text-sm text-gray-600 dark:text-gray-300">
                      {new Date(deployment.createdAt).toLocaleString()}
                    </span>
                  </div>
                  {deployment.url && (
                    <a
                      onClick={(e) => {
                        e.preventDefault();
                        ipc.system.openExternalUrl(`https://${deployment.url}`);
                      }}
                      className="cursor-pointer text-blue-600 hover:underline dark:text-blue-400 text-sm"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <Globe className="h-4 w-4 inline mr-1" />
                      View
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {disconnectError && (
        <p className="text-red-600 mt-2">{disconnectError}</p>
      )}
    </div>
  );
}

function UnconnectedNetlifyConnector({
  appId,
  folderName,
  settings,
  refreshSettings,
  refreshApp,
}: UnconnectedNetlifyConnectorProps) {
  // --- Manual Token Entry State ---
  const [accessToken, setAccessToken] = useState("");
  const [isSavingToken, setIsSavingToken] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [tokenSuccess, setTokenSuccess] = useState(false);

  // --- Site Setup State ---
  const [siteSetupMode, setSiteSetupMode] = useState<"create" | "existing">(
    "create",
  );
  const [availableSites, setAvailableSites] = useState<NetlifySite[]>([]);
  const [isLoadingSites, setIsLoadingSites] = useState(false);
  const [selectedSite, setSelectedSite] = useState<string>("");

  // Create new site state
  const [siteName, setSiteName] = useState(folderName);
  const [siteAvailable, setSiteAvailable] = useState<boolean | null>(null);
  const [siteCheckError, setSiteCheckError] = useState<string | null>(null);
  const [isCheckingSite, setIsCheckingSite] = useState(false);
  const [isCreatingSite, setIsCreatingSite] = useState(false);
  const [createSiteError, setCreateSiteError] = useState<string | null>(null);
  const [createSiteSuccess, setCreateSiteSuccess] = useState<boolean>(false);

  const debounceTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Load available sites when Netlify is connected
  useEffect(() => {
    if (settings?.netlifyAccessToken && siteSetupMode === "existing") {
      loadAvailableSites();
    }
  }, [settings?.netlifyAccessToken, siteSetupMode]);

  useEffect(() => {
    return () => {
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }
    };
  }, []);

  // Validate the pre-filled site name once Netlify is connected, so name
  // collisions surface immediately instead of only on "Create & Deploy".
  useEffect(() => {
    if (
      settings?.netlifyAccessToken &&
      siteSetupMode === "create" &&
      siteName
    ) {
      checkSiteAvailability(siteName);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.netlifyAccessToken, siteSetupMode]);

  const loadAvailableSites = async () => {
    setIsLoadingSites(true);
    try {
      const sites = await ipc.netlify.listSites();
      setAvailableSites(sites);
    } catch (error) {
      console.error("Failed to load Netlify sites:", error);
    } finally {
      setIsLoadingSites(false);
    }
  };

  const handleSaveAccessToken = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!accessToken.trim()) return;

    setIsSavingToken(true);
    setTokenError(null);
    setTokenSuccess(false);

    try {
      await ipc.netlify.saveToken({
        token: accessToken.trim(),
      });
      setTokenSuccess(true);
      setAccessToken("");
      refreshSettings();
    } catch (err: any) {
      setTokenError(err.message || "Failed to save access token.");
    } finally {
      setIsSavingToken(false);
    }
  };

  const checkSiteAvailability = useCallback(async (name: string) => {
    setSiteCheckError(null);
    setSiteAvailable(null);
    if (!name) return;
    setIsCheckingSite(true);
    try {
      const result = await ipc.netlify.isSiteAvailable({ name });
      setSiteAvailable(result.available);
      if (!result.available) {
        setSiteCheckError(result.error || "Site name is not available.");
      }
    } catch (err: any) {
      setSiteCheckError(err.message || "Failed to check site availability.");
    } finally {
      setIsCheckingSite(false);
    }
  }, []);

  const debouncedCheckSiteAvailability = useCallback(
    (name: string) => {
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }
      debounceTimeoutRef.current = setTimeout(() => {
        checkSiteAvailability(name);
      }, 500);
    },
    [checkSiteAvailability],
  );

  const handleSetupSite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!appId) return;

    setCreateSiteError(null);
    setIsCreatingSite(true);
    setCreateSiteSuccess(false);

    try {
      if (siteSetupMode === "create") {
        await ipc.netlify.createSite({
          name: siteName,
          appId,
        });
      } else {
        await ipc.netlify.connectExistingSite({
          siteId: selectedSite,
          appId,
        });
      }
      setCreateSiteSuccess(true);
      setSiteCheckError(null);
      refreshApp();
    } catch (err: any) {
      const raw: string =
        err.message ||
        `Failed to ${siteSetupMode === "create" ? "create" : "connect to"} site.`;
      setCreateSiteError(raw);
    } finally {
      setIsCreatingSite(false);
    }
  };

  // Parse error message that may contain an embedded action link ("msg||link:url")
  const parseCreateError = (
    raw: string | null,
  ): { message: string; link: string | null } => {
    if (!raw) return { message: "", link: null };
    const stripped = raw.replace(
      /^Error invoking remote method '[^']+': Error: /,
      "",
    );
    const sep = stripped.indexOf("||link:");
    if (sep !== -1) {
      return { message: stripped.slice(0, sep), link: stripped.slice(sep + 7) };
    }
    return { message: stripped, link: null };
  };

  if (!settings?.netlifyAccessToken) {
    return (
      <div className="mt-1 w-full" data-testid="netlify-unconnected-project">
        <div className="w-full">
          <div className="flex items-center gap-2 mb-4">
            <h3 className="font-medium">Connect to Netlify</h3>
          </div>

          <div className="space-y-4">
            <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-md p-3">
              <p className="text-sm text-blue-800 dark:text-blue-200 mb-2">
                To connect your app to Netlify, you'll need to create a personal
                access token:
              </p>
              <ol className="list-decimal list-inside text-sm text-blue-700 dark:text-blue-300 space-y-1">
                <li>If you don't have a Netlify account, sign up first</li>
                <li>Go to Netlify user settings to create a token</li>
                <li>Copy the token and paste it below</li>
              </ol>

              <div className="flex gap-2 mt-3">
                <Button
                  onClick={() => {
                    ipc.system.openExternalUrl(
                      "https://app.netlify.com/signup",
                    );
                  }}
                  variant="outline"
                  className="flex-1"
                >
                  Sign Up for Netlify
                </Button>
                <Button
                  onClick={() => {
                    ipc.system.openExternalUrl(
                      "https://app.netlify.com/user/applications#personal-access-tokens",
                    );
                  }}
                  className="flex-1 bg-blue-600 hover:bg-blue-700 text-white"
                >
                  Open Netlify Settings
                </Button>
              </div>
            </div>

            <form onSubmit={handleSaveAccessToken} className="space-y-3">
              <div>
                <Label className="block text-sm font-medium mb-1">
                  Netlify Personal Access Token
                </Label>
                <Input
                  type="password"
                  placeholder="Enter your Netlify personal access token"
                  value={accessToken}
                  onChange={(e) => setAccessToken(e.target.value)}
                  disabled={isSavingToken}
                  className="w-full"
                  data-testid="netlify-token-input"
                />
              </div>

              <Button
                type="submit"
                disabled={!accessToken.trim() || isSavingToken}
                className="w-full"
              >
                {isSavingToken ? (
                  <>
                    <svg
                      className="animate-spin h-4 w-4 mr-2"
                      xmlns="http://www.w3.org/2000/svg"
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
                      ></circle>
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                      ></path>
                    </svg>
                    Saving Token...
                  </>
                ) : (
                  "Save Netlify Token"
                )}
              </Button>
            </form>

            {tokenError && (
              <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md p-3">
                <p className="text-sm text-red-800 dark:text-red-200">
                  {tokenError}
                </p>
              </div>
            )}

            {tokenSuccess && (
              <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-md p-3">
                <p className="text-sm text-green-800 dark:text-green-200">
                  Successfully connected to Netlify! You can now set up your
                  site below.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-4 w-full rounded-md" data-testid="netlify-setup-project">
      <div className="font-medium mb-2">Set up your Netlify site</div>

      <div className="overflow-hidden transition-all duration-300 ease-in-out">
        <div className="pt-0 space-y-4">
          {/* Mode Selection */}
          <div>
            <div className="flex rounded-md border border-gray-200 dark:border-gray-700">
              <Button
                type="button"
                variant={siteSetupMode === "create" ? "default" : "ghost"}
                className={`flex-1 rounded-none rounded-l-md border-0 ${
                  siteSetupMode === "create"
                    ? "bg-primary text-primary-foreground"
                    : "hover:bg-gray-50 dark:hover:bg-gray-800"
                }`}
                onClick={() => {
                  setSiteSetupMode("create");
                  setCreateSiteError(null);
                  setCreateSiteSuccess(false);
                }}
              >
                Create new site
              </Button>
              <Button
                type="button"
                variant={siteSetupMode === "existing" ? "default" : "ghost"}
                className={`flex-1 rounded-none rounded-r-md border-0 border-l border-gray-200 dark:border-gray-700 ${
                  siteSetupMode === "existing"
                    ? "bg-primary text-primary-foreground"
                    : "hover:bg-gray-50 dark:hover:bg-gray-800"
                }`}
                onClick={() => {
                  setSiteSetupMode("existing");
                  setCreateSiteError(null);
                  setCreateSiteSuccess(false);
                }}
              >
                Connect to existing site
              </Button>
            </div>
          </div>

          <form className="space-y-4" onSubmit={handleSetupSite}>
            {siteSetupMode === "create" ? (
              <div>
                <Label className="block text-sm font-medium">Site Name</Label>
                <Input
                  data-testid="netlify-create-site-name-input"
                  className="w-full mt-1"
                  value={siteName}
                  onChange={(e) => {
                    const newValue = e.target.value;
                    setSiteName(newValue);
                    setSiteAvailable(null);
                    setSiteCheckError(null);
                    debouncedCheckSiteAvailability(newValue);
                  }}
                  disabled={isCreatingSite}
                />
                {isCheckingSite && (
                  <p className="text-xs text-gray-500 mt-1">
                    Checking availability...
                  </p>
                )}
                {siteAvailable === true && (
                  <p className="text-xs text-green-600 mt-1">
                    Site name is available!
                  </p>
                )}
                {siteAvailable === false && (
                  <p className="text-xs text-red-600 mt-1">{siteCheckError}</p>
                )}
              </div>
            ) : (
              <div>
                <Label className="block text-sm font-medium">Select Site</Label>
                <Select
                  value={selectedSite}
                  onValueChange={(v) => setSelectedSite(v ?? "")}
                  disabled={isLoadingSites}
                >
                  <SelectTrigger
                    className="w-full mt-1"
                    data-testid="netlify-site-select"
                  >
                    <SelectValue
                      placeholder={
                        isLoadingSites ? "Loading sites..." : "Select a site"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {availableSites.map((site) => (
                      <SelectItem key={site.id} value={site.id}>
                        {site.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <Button
              type="submit"
              disabled={
                isCreatingSite ||
                (siteSetupMode === "create" &&
                  (siteAvailable === false || !siteName)) ||
                (siteSetupMode === "existing" && !selectedSite)
              }
            >
              {isCreatingSite
                ? siteSetupMode === "create"
                  ? "Building & deploying…"
                  : "Connecting..."
                : siteSetupMode === "create"
                  ? "Create & Deploy Site"
                  : "Connect to Site"}
            </Button>
          </form>

          {createSiteError &&
            (() => {
              const { message, link } = parseCreateError(createSiteError);
              return (
                <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md p-3 mt-2 space-y-2">
                  <p className="text-sm text-red-800 dark:text-red-200">
                    {message}
                  </p>
                  {link && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="border-red-300 dark:border-red-700 text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/30"
                      onClick={() => ipc.system.openExternalUrl(link)}
                    >
                      Connect Repository on Netlify →
                    </Button>
                  )}
                </div>
              );
            })()}
          {createSiteSuccess && (
            <p className="text-green-600 mt-2">
              {siteSetupMode === "create"
                ? "Site created and deployed!"
                : "Connected to site!"}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export function NetlifyConnector({ appId, folderName }: NetlifyConnectorProps) {
  const { app, refreshApp } = useLoadApp(appId);
  const { settings, refreshSettings } = useSettings();

  if (app?.netlifySiteId && appId) {
    return (
      <ConnectedNetlifyConnector
        appId={appId}
        app={app}
        refreshApp={refreshApp}
      />
    );
  } else {
    return (
      <UnconnectedNetlifyConnector
        appId={appId}
        folderName={folderName}
        settings={settings}
        refreshSettings={refreshSettings}
        refreshApp={refreshApp}
      />
    );
  }
}
