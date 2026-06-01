import { IpcMainInvokeEvent } from "electron";
import { writeSettings, readSettings } from "../../main/settings";
import * as schema from "../../db/schema";
import { db } from "../../db";
import { apps } from "../../db/schema";
import { eq } from "drizzle-orm";
import log from "electron-log";
import { IS_TEST_BUILD } from "../utils/test_utils";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { spawn } from "child_process";
import { getOrianBuilderAppPath } from "@/paths/paths";
import { createTypedHandler } from "./base";
import {
  netlifyContracts,
  SaveNetlifyAccessTokenParams,
  IsNetlifySiteAvailableParams,
  CreateNetlifySiteParams,
  ConnectToExistingNetlifySiteParams,
  GetNetlifyDeploymentsParams,
  DisconnectNetlifySiteParams,
  NetlifySite,
  NetlifyDeployment,
} from "../types/netlify";
import {
  OrianBuilderError,
  OrianBuilderErrorKind,
} from "@/errors/orianbuilder_error";

const logger = log.scope("netlify_handlers");

// Use test server URLs when in test mode
const TEST_SERVER_BASE = `http://localhost:${process.env.FAKE_LLM_PORT || "3500"}`;

const NETLIFY_API_BASE = IS_TEST_BUILD
  ? `${TEST_SERVER_BASE}/netlify/api/v1`
  : "https://api.netlify.com/api/v1";

// --- Helper Functions ---

/** Strip the protocol from a URL so it matches the host-only format the UI expects. */
function toHost(urlOrHost: string | null | undefined): string | null {
  if (!urlOrHost) return null;
  return urlOrHost.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

function toHttpsUrl(hostOrUrl: string | null | undefined): string | null {
  if (!hostOrUrl) return null;
  return hostOrUrl.startsWith("http") ? hostOrUrl : `https://${hostOrUrl}`;
}

interface NetlifyApiOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
}

/**
 * Thin wrapper around the Netlify REST API. Mirrors how the Vercel handlers talk
 * to Vercel, but Netlify uses a plain REST surface so we hit it with `fetch`.
 */
async function netlifyApi<T>(
  token: string,
  endpoint: string,
  options: NetlifyApiOptions = {},
): Promise<T> {
  const { method = "GET", body } = options;
  const response = await fetch(`${NETLIFY_API_BASE}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  if (!response.ok) {
    let detail = "";
    try {
      detail = await response.text();
    } catch {
      // ignore
    }
    throw new Error(
      `Netlify API error: ${response.status} ${response.statusText}${
        detail ? ` - ${detail}` : ""
      }`,
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

interface NetlifySiteResponse {
  id: string;
  name: string;
  url?: string;
  ssl_url?: string;
  admin_url?: string;
  build_settings?: {
    repo_url?: string;
    cmd?: string;
    dir?: string;
  };
}

interface NetlifyDeployResponse {
  id: string;
  state: string;
  created_at?: string;
  deploy_ssl_url?: string;
  ssl_url?: string;
  url?: string;
  context?: string;
}

async function validateNetlifyToken(token: string): Promise<boolean> {
  try {
    await netlifyApi(token, "/user");
    return true;
  } catch (error) {
    logger.error("Error validating Netlify token:", error);
    return false;
  }
}

async function getNetlifySites(token: string): Promise<NetlifySiteResponse[]> {
  return netlifyApi<NetlifySiteResponse[]>(token, "/sites?filter=all");
}

/**
 * Map a Netlify deploy state to the same uppercase state vocabulary the Vercel
 * UI already understands (READY / BUILDING / ERROR), so the connector UI can be
 * shared verbatim.
 */
function mapDeployState(state: string | undefined): string {
  switch ((state || "").toLowerCase()) {
    case "ready":
      return "READY";
    case "error":
    case "failed":
      return "ERROR";
    case "new":
    case "pending_review":
    case "accepted":
    case "enqueued":
    case "building":
    case "uploading":
    case "uploaded":
    case "preparing":
    case "prepared":
    case "processing":
      return "BUILDING";
    default:
      return (state || "unknown").toUpperCase();
  }
}

/**
 * Detect sensible Netlify build settings (build command + publish dir) from the
 * app's framework, analogous to Vercel's framework detection.
 */
function detectBuildSettings(appPath: string): { cmd: string; dir: string } {
  const fallback = { cmd: "npm run build", dir: "dist" };
  try {
    if (
      fs.existsSync(path.join(appPath, "next.config.js")) ||
      fs.existsSync(path.join(appPath, "next.config.mjs")) ||
      fs.existsSync(path.join(appPath, "next.config.ts"))
    ) {
      return { cmd: "npm run build", dir: ".next" };
    }
    if (
      fs.existsSync(path.join(appPath, "nuxt.config.js")) ||
      fs.existsSync(path.join(appPath, "nuxt.config.ts"))
    ) {
      return { cmd: "npm run build", dir: "dist" };
    }
    if (
      fs.existsSync(path.join(appPath, "astro.config.js")) ||
      fs.existsSync(path.join(appPath, "astro.config.mjs")) ||
      fs.existsSync(path.join(appPath, "astro.config.ts"))
    ) {
      return { cmd: "npm run build", dir: "dist" };
    }

    const packageJsonPath = path.join(appPath, "package.json");
    if (fs.existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
      const deps = {
        ...packageJson.dependencies,
        ...packageJson.devDependencies,
      };
      if (deps.next) return { cmd: "npm run build", dir: ".next" };
      if (deps["react-scripts"]) return { cmd: "npm run build", dir: "build" };
      if (deps.gatsby) return { cmd: "npm run build", dir: "public" };
      if (deps.vite) return { cmd: "npm run build", dir: "dist" };
    }
    return fallback;
  } catch (error) {
    logger.error("Error detecting Netlify build settings:", error);
    return fallback;
  }
}

/**
 * Run a shell command (e.g. the build) in the app directory. Mirrors the shell
 * runner used by the local-agent deploy tool, but self-contained here.
 */
function runBuildCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ exitCode: number; output: string; timedOut: boolean }> {
  const isWin = process.platform === "win32";
  const file = isWin ? "cmd.exe" : "/bin/sh";
  const args = isWin ? ["/c", command] : ["-c", command];

  return new Promise((resolve) => {
    let output = "";
    let completed = false;
    const proc = spawn(file, args, {
      cwd,
      stdio: "pipe",
      env: { ...process.env },
      windowsHide: true,
    });

    const append = (chunk: Buffer) => {
      output += chunk.toString();
      // Keep memory bounded for very chatty builds.
      if (output.length > 200_000) {
        output = output.slice(-200_000);
      }
    };

    const timer = setTimeout(() => {
      if (completed) return;
      completed = true;
      proc.kill("SIGKILL");
      resolve({ exitCode: 124, output, timedOut: true });
    }, timeoutMs);

    proc.stdout?.on("data", append);
    proc.stderr?.on("data", append);
    proc.on("close", (code) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      resolve({ exitCode: code ?? 0, output, timedOut: false });
    });
    proc.on("error", (error) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      resolve({
        exitCode: 1,
        output: `${output}\n[spawn error] ${error.message}`,
        timedOut: false,
      });
    });
  });
}

interface CollectedFile {
  absPath: string;
  /** Web path with a leading slash, e.g. "/assets/index.js". */
  webPath: string;
  sha1: string;
}

/** Recursively collect every file under `dir` with its SHA1 digest. */
function collectFiles(dir: string, baseDir: string = dir): CollectedFile[] {
  const result: CollectedFile[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...collectFiles(abs, baseDir));
    } else if (entry.isFile()) {
      const buffer = fs.readFileSync(abs);
      const sha1 = crypto.createHash("sha1").update(buffer).digest("hex");
      const rel = path.relative(baseDir, abs).split(path.sep).join("/");
      result.push({ absPath: abs, webPath: `/${rel}`, sha1 });
    }
  }
  return result;
}

interface NetlifyDeployCreateResponse {
  id: string;
  state?: string;
  required?: string[];
  ssl_url?: string;
  deploy_ssl_url?: string;
  url?: string;
}

/**
 * Deploy a built directory straight to a Netlify site using the file-digest
 * deploy API (the same mechanism the Netlify CLI uses). This needs only the
 * access token — no GitHub App, deploy keys, or Netlify-side CI build.
 */
async function digestDeploy(
  token: string,
  siteId: string,
  publishDir: string,
): Promise<{ deployId: string; sslUrl: string | null }> {
  const files = collectFiles(publishDir);
  if (files.length === 0) {
    throw new OrianBuilderError(
      `Build output directory is empty: ${publishDir}`,
      OrianBuilderErrorKind.Precondition,
    );
  }

  // 1. Tell Netlify the full file manifest (path -> sha1).
  const fileManifest: Record<string, string> = {};
  for (const f of files) {
    fileManifest[f.webPath] = f.sha1;
  }

  const deploy = await netlifyApi<NetlifyDeployCreateResponse>(
    token,
    `/sites/${siteId}/deploys`,
    { method: "POST", body: { files: fileManifest } },
  );

  // 2. Upload every file Netlify says it still needs.
  const requiredDigests = new Set(deploy.required ?? []);
  const filesToUpload = files.filter((f) => requiredDigests.has(f.sha1));

  for (const f of filesToUpload) {
    const encodedPath = f.webPath
      .split("/")
      .map((seg) => encodeURIComponent(seg))
      .join("/");
    const response = await fetch(
      `${NETLIFY_API_BASE}/deploys/${deploy.id}/files${encodedPath}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/octet-stream",
        },
        body: fs.readFileSync(f.absPath),
      },
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Failed to upload ${f.webPath}: ${response.status} ${response.statusText}${
          detail ? ` - ${detail}` : ""
        }`,
      );
    }
  }

  return {
    deployId: deploy.id,
    sslUrl: deploy.ssl_url || deploy.deploy_ssl_url || deploy.url || null,
  };
}

/** Poll a Netlify deploy until it reaches a terminal state (ready/error). */
async function waitForDeployReady(
  token: string,
  deployId: string,
  timeoutMs: number,
): Promise<{ state: string; sslUrl: string | null; error: string | null }> {
  const deadline = Date.now() + timeoutMs;
  let lastState = "uploading";
  while (Date.now() <= deadline) {
    const deploy = await netlifyApi<
      NetlifyDeployResponse & { error_message?: string; ssl_url?: string }
    >(token, `/deploys/${deployId}`);
    lastState = deploy.state || lastState;
    if (mapDeployState(lastState) === "READY") {
      return {
        state: lastState,
        sslUrl: deploy.ssl_url || deploy.deploy_ssl_url || deploy.url || null,
        error: null,
      };
    }
    if (mapDeployState(lastState) === "ERROR") {
      return {
        state: lastState,
        sslUrl: null,
        error: deploy.error_message || "Netlify build/deploy failed.",
      };
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return {
    state: lastState,
    sslUrl: null,
    error: "Timed out waiting for Netlify deploy to finish.",
  };
}

// --- IPC Handlers ---

async function handleSaveNetlifyToken(
  _event: IpcMainInvokeEvent,
  { token }: SaveNetlifyAccessTokenParams,
): Promise<void> {
  logger.debug("Saving Netlify access token");

  if (!token || token.trim() === "") {
    throw new OrianBuilderError(
      "Access token is required.",
      OrianBuilderErrorKind.Auth,
    );
  }

  try {
    const isValid = await validateNetlifyToken(token.trim());
    if (!isValid) {
      throw new Error(
        "Invalid access token. Please check your token and try again.",
      );
    }

    writeSettings({
      netlifyAccessToken: {
        value: token.trim(),
      },
    });

    logger.log("Successfully saved Netlify access token.");
  } catch (error: any) {
    logger.error("Error saving Netlify token:", error);
    throw new OrianBuilderError(
      `Failed to save access token: ${error.message}`,
      OrianBuilderErrorKind.Auth,
    );
  }
}

async function handleListNetlifySites(): Promise<NetlifySite[]> {
  try {
    const settings = readSettings();
    const accessToken = settings.netlifyAccessToken?.value;
    if (!accessToken) {
      throw new OrianBuilderError(
        "Not authenticated with Netlify.",
        OrianBuilderErrorKind.Auth,
      );
    }

    const sites = await getNetlifySites(accessToken);

    return sites.map((site) => ({
      id: site.id,
      name: site.name,
      framework: site.build_settings?.cmd || null,
    }));
  } catch (err: any) {
    if (err instanceof OrianBuilderError) throw err;
    logger.error("[Netlify Handler] Failed to list sites:", err);
    throw new Error(err.message || "Failed to list Netlify sites.");
  }
}

async function handleIsSiteAvailable(
  _event: IpcMainInvokeEvent,
  { name }: IsNetlifySiteAvailableParams,
): Promise<{ available: boolean; error?: string }> {
  try {
    const settings = readSettings();
    const accessToken = settings.netlifyAccessToken?.value;
    if (!accessToken) {
      return { available: false, error: "Not authenticated with Netlify." };
    }

    const sites = await getNetlifySites(accessToken);
    const siteExists = sites.some((site) => site.name === name);

    return {
      available: !siteExists,
      error: siteExists ? "Site name is not available." : undefined,
    };
  } catch (err: any) {
    return { available: false, error: err.message || "Unknown error" };
  }
}

async function handleCreateSite(
  _event: IpcMainInvokeEvent,
  params: CreateNetlifySiteParams,
): Promise<void> {
  await createAndLinkNetlifySite(params);
}

/**
 * Creates a Netlify site, builds the app locally, and deploys the built output
 * directly to Netlify via the file-digest deploy API (the same path the Netlify
 * CLI uses). Unlike GitHub-CI builds, this works with only the access token —
 * no Netlify GitHub App, deploy keys, or repo linkage required. This is what
 * makes Netlify deploys actually succeed, mirroring how Vercel "just works".
 */
export async function createAndLinkNetlifySite({
  name,
  appId,
}: CreateNetlifySiteParams): Promise<void> {
  const settings = readSettings();
  const accessToken = settings.netlifyAccessToken?.value;
  if (!accessToken) {
    throw new OrianBuilderError(
      "Not authenticated with Netlify.",
      OrianBuilderErrorKind.Auth,
    );
  }

  let createdSiteId: string | null = null;

  try {
    logger.info(`Creating Netlify site: ${name} for app ${appId}`);

    const app = await db.query.apps.findFirst({ where: eq(apps.id, appId) });
    if (!app) {
      throw new OrianBuilderError(
        "App not found.",
        OrianBuilderErrorKind.NotFound,
      );
    }

    const appPath = getOrianBuilderAppPath(app.path);
    const { cmd, dir } = detectBuildSettings(appPath);

    // 1. Build the app locally (install deps first if needed).
    const hasNodeModules = fs.existsSync(path.join(appPath, "node_modules"));
    const buildCommand = hasNodeModules
      ? cmd
      : `npm install --no-audit --no-fund && ${cmd}`;
    logger.info(`Building app for Netlify deploy: ${buildCommand}`);
    const build = await runBuildCommand(buildCommand, appPath, 600_000);
    if (build.exitCode !== 0) {
      const tail = build.output.slice(-1500);
      throw new OrianBuilderError(
        `Build failed (exit code ${build.exitCode}). Make sure the app builds ` +
          `locally.\n\n${tail}`,
        OrianBuilderErrorKind.External,
      );
    }

    const publishDir = path.join(appPath, dir);
    if (!fs.existsSync(publishDir)) {
      throw new OrianBuilderError(
        `Build succeeded but the publish directory "${dir}" was not found. ` +
          `Check your build output directory.`,
        OrianBuilderErrorKind.Precondition,
      );
    }

    // 2. Resolve the target site: re-deploy to the already-linked site if the
    //    app has one, otherwise create a brand-new site (name only — no repo/CI).
    let siteId = app.netlifySiteId;
    let siteFallbackUrl: string | null = app.netlifyDeploymentUrl ?? null;
    if (!siteId) {
      let site: NetlifySiteResponse;
      try {
        site = await netlifyApi<NetlifySiteResponse>(accessToken, "/sites", {
          method: "POST",
          body: { name },
        });
      } catch (err: any) {
        // Netlify subdomains are globally unique across ALL Netlify accounts,
        // so a name can collide even though it's free in the current account
        // (which is all our availability check can see). Surface a clear,
        // actionable message instead of the raw "422 ... subdomain must be
        // unique" payload.
        const msg = String(err?.message ?? "");
        if (/subdomain/i.test(msg) && /must be unique|already/i.test(msg)) {
          throw new OrianBuilderError(
            `The site name "${name}" is already taken on Netlify. ` +
              `Site names must be unique across all of Netlify — please choose ` +
              `a different name and try again.`,
            OrianBuilderErrorKind.Precondition,
          );
        }
        throw err;
      }
      if (!site.id) {
        throw new OrianBuilderError(
          "Failed to create site: No site ID returned.",
          OrianBuilderErrorKind.External,
        );
      }
      // Only a site WE created this run should be rolled back on failure.
      createdSiteId = site.id;
      siteId = site.id;
      siteFallbackUrl = toHttpsUrl(site.ssl_url || site.url);
      await updateAppNetlifySite({
        appId,
        siteId: site.id,
        siteName: site.name,
        deploymentUrl: siteFallbackUrl,
      });
    }

    // 3. Digest-deploy the built files and wait for it to go live.
    logger.info(`Deploying ${publishDir} to Netlify site ${siteId}`);
    const { deployId } = await digestDeploy(accessToken, siteId, publishDir);
    const result = await waitForDeployReady(accessToken, deployId, 300_000);

    if (result.error) {
      throw new OrianBuilderError(result.error, OrianBuilderErrorKind.External);
    }

    const liveUrl = toHttpsUrl(result.sslUrl || siteFallbackUrl);
    await db
      .update(apps)
      .set({ netlifyDeploymentUrl: liveUrl })
      .where(eq(apps.id, appId));

    logger.info(`Successfully deployed Netlify site ${siteId}: ${liveUrl}`);
  } catch (err: any) {
    // Roll back the half-created link + delete the orphaned Netlify site so the
    // name frees up and the user can retry cleanly.
    if (createdSiteId) {
      try {
        await netlifyApi(accessToken, `/sites/${createdSiteId}`, {
          method: "DELETE",
        });
      } catch {
        // best effort
      }
      try {
        await db
          .update(apps)
          .set({
            netlifySiteId: null,
            netlifySiteName: null,
            netlifyDeploymentUrl: null,
          })
          .where(eq(apps.id, appId));
      } catch {
        // best effort
      }
    }

    if (err instanceof OrianBuilderError) throw err;
    logger.error("[Netlify Handler] Failed to create/deploy site:", err);
    throw new Error(err.message || "Failed to create Netlify site.");
  }
}

async function handleConnectToExistingSite(
  _event: IpcMainInvokeEvent,
  { siteId, appId }: ConnectToExistingNetlifySiteParams,
): Promise<void> {
  try {
    const settings = readSettings();
    const accessToken = settings.netlifyAccessToken?.value;
    if (!accessToken) {
      throw new OrianBuilderError(
        "Not authenticated with Netlify.",
        OrianBuilderErrorKind.Auth,
      );
    }

    logger.info(
      `Connecting to existing Netlify site: ${siteId} for app ${appId}`,
    );

    const site = await netlifyApi<NetlifySiteResponse>(
      accessToken,
      `/sites/${siteId}`,
    );

    if (!site || !site.id) {
      throw new OrianBuilderError(
        "Site not found. Please check the site.",
        OrianBuilderErrorKind.NotFound,
      );
    }

    await updateAppNetlifySite({
      appId,
      siteId: site.id,
      siteName: site.name,
      deploymentUrl: toHttpsUrl(site.ssl_url || site.url),
    });

    logger.info(`Successfully connected to Netlify site: ${site.id}`);
  } catch (err: any) {
    if (err instanceof OrianBuilderError) throw err;
    logger.error("[Netlify Handler] Failed to connect to existing site:", err);
    throw new Error(err.message || "Failed to connect to existing site.");
  }
}

async function handleGetNetlifyDeployments(
  _event: IpcMainInvokeEvent,
  { appId }: GetNetlifyDeploymentsParams,
): Promise<NetlifyDeployment[]> {
  try {
    const settings = readSettings();
    const accessToken = settings.netlifyAccessToken?.value;
    if (!accessToken) {
      throw new OrianBuilderError(
        "Not authenticated with Netlify.",
        OrianBuilderErrorKind.Auth,
      );
    }

    const app = await db.query.apps.findFirst({ where: eq(apps.id, appId) });
    if (!app || !app.netlifySiteId) {
      throw new OrianBuilderError(
        "App is not linked to a Netlify site.",
        OrianBuilderErrorKind.Precondition,
      );
    }

    logger.info(
      `Getting deployments for Netlify site: ${app.netlifySiteId} for app ${appId}`,
    );

    const deploys = await netlifyApi<NetlifyDeployResponse[]>(
      accessToken,
      `/sites/${app.netlifySiteId}/deploys?per_page=5`,
    );

    // Keep the stored production URL fresh from the latest ready deploy.
    const readyProduction = deploys.find(
      (d) => mapDeployState(d.state) === "READY" && d.context === "production",
    );
    if (readyProduction) {
      const newUrl = toHttpsUrl(
        readyProduction.deploy_ssl_url ||
          readyProduction.ssl_url ||
          readyProduction.url,
      );
      if (newUrl && newUrl !== app.netlifyDeploymentUrl) {
        await db
          .update(apps)
          .set({ netlifyDeploymentUrl: newUrl })
          .where(eq(apps.id, appId));
      }
    }

    return deploys.map((deploy) => ({
      uid: deploy.id,
      url: toHost(deploy.deploy_ssl_url || deploy.ssl_url || deploy.url) || "",
      state: deploy.state || "unknown",
      createdAt: deploy.created_at ? Date.parse(deploy.created_at) : 0,
      target:
        deploy.context === "production"
          ? "production"
          : deploy.context || "preview",
      readyState: mapDeployState(deploy.state),
    }));
  } catch (err: any) {
    if (err instanceof OrianBuilderError) throw err;
    logger.error("[Netlify Handler] Failed to get deployments:", err);
    throw new Error(err.message || "Failed to get Netlify deployments.");
  }
}

async function handleDisconnectNetlifySite(
  _event: IpcMainInvokeEvent,
  { appId }: DisconnectNetlifySiteParams,
): Promise<void> {
  logger.log(`Disconnecting Netlify site for appId: ${appId}`);

  const app = await db.query.apps.findFirst({ where: eq(apps.id, appId) });
  if (!app) {
    throw new OrianBuilderError(
      "App not found",
      OrianBuilderErrorKind.NotFound,
    );
  }

  await db
    .update(apps)
    .set({
      netlifySiteId: null,
      netlifySiteName: null,
      netlifyDeploymentUrl: null,
    })
    .where(eq(apps.id, appId));
}

// --- Registration ---
export function registerNetlifyHandlers() {
  // DO NOT LOG this handler because tokens are sensitive
  createTypedHandler(netlifyContracts.saveToken, async (event, params) => {
    await handleSaveNetlifyToken(event, params);
  });

  createTypedHandler(netlifyContracts.listSites, async () => {
    return handleListNetlifySites();
  });

  createTypedHandler(
    netlifyContracts.isSiteAvailable,
    async (event, params) => {
      return handleIsSiteAvailable(event, params);
    },
  );

  createTypedHandler(netlifyContracts.createSite, async (event, params) => {
    await handleCreateSite(event, params);
  });

  createTypedHandler(
    netlifyContracts.connectExistingSite,
    async (event, params) => {
      await handleConnectToExistingSite(event, params);
    },
  );

  createTypedHandler(netlifyContracts.getDeployments, async (event, params) => {
    return handleGetNetlifyDeployments(event, params);
  });

  createTypedHandler(netlifyContracts.disconnect, async (event, params) => {
    await handleDisconnectNetlifySite(event, params);
  });

  logger.debug("Registered Netlify IPC handlers");
}

export async function updateAppNetlifySite({
  appId,
  siteId,
  siteName,
  deploymentUrl,
}: {
  appId: number;
  siteId: string;
  siteName: string;
  deploymentUrl?: string | null;
}): Promise<void> {
  await db
    .update(schema.apps)
    .set({
      netlifySiteId: siteId,
      netlifySiteName: siteName,
      netlifyDeploymentUrl: deploymentUrl,
    })
    .where(eq(schema.apps.id, appId));
}
