import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import log from "electron-log";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { apps, chats, designSessions } from "@/db/schema";
import { flowContracts, flowEvents } from "@/ipc/types/intent";
import type {
  PipelineProgress,
  CommandIntent,
  CapabilityId,
  MediaReplyAsset,
  MediaReplyResult,
} from "@/ipc/types/intent";
import { safeSend } from "@/ipc/utils/safe_sender";
import { createLoggedTypedHandler } from "./base";
import { parseIntent } from "@/main/flow/intent_parser";
import { runFlow, resumeFlow } from "@/main/flow/flow_runner";
import {
  setFlowReviewer,
  createLlmFlowReviewer,
} from "@/main/flow/flow_review";
import { listResumableFlowRuns } from "@/main/flow/flow_run_store";
import {
  listCapabilities,
  setBuildExecutor,
  setDesignExecutor,
  setNewsExecutor,
  setThreeDExecutor,
  setTrackingExecutor,
} from "@/main/flow/capability_registry";
import { getModelLeaseManager, type ModelSpec } from "@/main/flow/model_lease";
import { getCachedHardwareProfile } from "@/main/hardware/detect";
import { getAvailableVramMb } from "@/main/ipc/utils/vram_accounting";
import { ORIANBUILDER_MEDIA_DIR_NAME } from "@/ipc/utils/media_path_utils";
import {
  selectProfileForVram,
  applySelectionToProfile,
  type HardwareModelProfile,
} from "@/main/flow/model_profiles";
import { getModelGate } from "@/main/flow/model_gate";
import {
  runPipeline,
  type PipelineWorkers,
  type PhaseRecord,
} from "@/main/flow/pipeline_orchestrator";
import {
  resolveSelection,
  resolveDownloadPlan,
} from "@/shared/orion_media_catalog";
import { markFactoryBuildChat } from "@/main/flow/factory_build_registry";
import { readSettings } from "@/main/settings";
import { createMediaAssetWorker } from "@/main/flow/asset_worker";
import { generateAssetManifest } from "@/main/flow/asset_planner";
import {
  configureModelGateHooks,
  defaultGenerateText,
  backendThreeDGenerator,
  getLastLlmModelId,
} from "@/main/flow/pipeline_wiring";
import { dispatchMediaGeneration } from "@/main/ipc/utils/media_dispatcher";
import type { PipelineRunResult } from "@/ipc/types/intent";
import {
  getMediaAiBackendStatus,
  startMediaAiBackend,
  downloadMediaAiModels,
} from "@/ipc/utils/media_ai_backend";
import {
  watchdogBackend,
  WATCHDOG_DEFAULT_HOST,
  WATCHDOG_DEFAULT_PORT,
} from "@/main/watchdog/backend_process";
import { isSetupComplete as isWatchdogSetupComplete } from "@/main/watchdog/venv_installer";
import { EMBEDDED_BASE_URL } from "@/ipc/utils/embedded_inference_server";
import { getOrianBuilderAppPath, isAppLocationAccessible } from "@/paths/paths";
import { getTemplateRuntimeCommands } from "./app/app_runtime_commands";
import { createFromTemplate } from "./createFromTemplate";
import { gitAdd, gitCommit, gitInit } from "@/ipc/utils/git_utils";
import { DEFAULT_TEMPLATE_ID } from "@/shared/templates";

const logger = log.scope("flow_handlers");
const handle = createLoggedTypedHandler(logger);

/** Build a filesystem-safe, unique app name from a free-text goal. */
function deriveAppName(goal: string): string {
  const base =
    goal
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .split("-")
      .slice(0, 4)
      .join("-") || "app";
  let name = `orion-${base}`;
  let suffix = 1;
  // Ensure both the DB name and the on-disk path are free.
  while (fs.existsSync(getOrianBuilderAppPath(name))) {
    name = `orion-${base}-${++suffix}`;
  }
  return name;
}

function ensureDesignSessionsTable(): void {
  db.$client.exec(`
    CREATE TABLE IF NOT EXISTS design_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      title TEXT NOT NULL,
      skill_id TEXT,
      design_system_id TEXT,
      messages_json TEXT NOT NULL DEFAULT '[]',
      current_artifact TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function titleFromGoal(goal: string): string {
  const normalized = goal.trim().replace(/\s+/g, " ");
  if (!normalized) return "Orion design";
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

function buildDesignArtifactHtml(goal: string, prompt: string): string {
  const safeGoal = escapeHtml(goal);
  const safePrompt = escapeHtml(prompt);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeGoal}</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0e1117;
      --panel: #151a23;
      --muted: #8b95a7;
      --text: #f5f7fb;
      --accent: #4ea1ff;
      --accent-2: #2bd4a7;
      --line: rgba(255, 255, 255, 0.1);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      width: min(1120px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 40px 0;
    }
    .shell {
      display: grid;
      grid-template-columns: 260px 1fr;
      gap: 16px;
      min-height: 680px;
    }
    .sidebar,
    .canvas,
    .card {
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 8px;
    }
    .sidebar {
      padding: 18px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .brand { font-size: 18px; font-weight: 700; }
    .nav {
      display: grid;
      gap: 8px;
      margin-top: 10px;
    }
    .nav div {
      border-radius: 6px;
      padding: 10px 12px;
      color: var(--muted);
      background: rgba(255, 255, 255, 0.03);
    }
    .nav div:first-child {
      color: var(--text);
      background: rgba(78, 161, 255, 0.16);
    }
    .canvas {
      padding: 24px;
      display: grid;
      gap: 16px;
      align-content: start;
    }
    .hero {
      min-height: 210px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 24px;
      background:
        linear-gradient(135deg, rgba(78, 161, 255, 0.18), rgba(43, 212, 167, 0.08)),
        #111722;
      display: grid;
      align-content: end;
      gap: 10px;
    }
    .eyebrow {
      color: var(--accent-2);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0;
      text-transform: uppercase;
    }
    h1 {
      margin: 0;
      max-width: 760px;
      font-size: 42px;
      line-height: 1.05;
      letter-spacing: 0;
    }
    p {
      margin: 0;
      color: var(--muted);
      line-height: 1.55;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 12px;
    }
    .card {
      padding: 16px;
      min-height: 132px;
    }
    .card strong {
      display: block;
      margin-bottom: 8px;
    }
    .prompt {
      border-left: 3px solid var(--accent);
      padding: 12px 14px;
      background: rgba(255, 255, 255, 0.04);
      border-radius: 6px;
      color: var(--muted);
    }
    @media (max-width: 760px) {
      main { width: min(100vw - 20px, 560px); padding: 20px 0; }
      .shell { grid-template-columns: 1fr; }
      .grid { grid-template-columns: 1fr; }
      h1 { font-size: 30px; }
    }
  </style>
</head>
<body>
  <main>
    <section class="shell" aria-label="Generated Design Studio artifact">
      <aside class="sidebar">
        <div class="brand">Orion Design</div>
        <p>Generated from the unified command flow.</p>
        <nav class="nav" aria-label="Screen outline">
          <div>Overview</div>
          <div>Primary workflow</div>
          <div>Content states</div>
          <div>Responsive behavior</div>
        </nav>
      </aside>
      <section class="canvas">
        <div class="hero">
          <div class="eyebrow">Design direction</div>
          <h1>${safeGoal}</h1>
          <p>Translate this into the app build with practical layout, clear hierarchy, accessible controls, and production-ready responsive behavior.</p>
        </div>
        <div class="grid">
          <article class="card">
            <strong>Primary surface</strong>
            <p>Keep the main workflow visible immediately, with action controls close to the user's current task.</p>
          </article>
          <article class="card">
            <strong>State coverage</strong>
            <p>Include empty, loading, success, failure, and in-progress states without changing the layout size.</p>
          </article>
          <article class="card">
            <strong>Implementation notes</strong>
            <p>Use constrained widths, stable grid tracks, and compact controls that match the existing product style.</p>
          </article>
        </div>
        <div class="prompt">${safePrompt}</div>
      </section>
    </section>
  </main>
</body>
</html>`;
}

async function prepareDesignArtifact(params: {
  goal: string;
  prompt: string;
  appId?: number;
  appPath?: string;
  mediaDir: string;
}): Promise<Record<string, unknown>> {
  await fs.promises.mkdir(params.mediaDir, { recursive: true });
  const artifactPath = path.join(
    params.mediaDir,
    `flow-design-${Date.now()}-${crypto.randomBytes(6).toString("hex")}.html`,
  );
  const artifactHtml = buildDesignArtifactHtml(params.goal, params.prompt);
  await fs.promises.writeFile(artifactPath, artifactHtml, "utf-8");

  ensureDesignSessionsTable();
  const messages = [
    {
      id: crypto.randomUUID(),
      role: "user" as const,
      content: params.prompt,
    },
    {
      id: crypto.randomUUID(),
      role: "assistant" as const,
      content: "Generated a Design Studio artifact for the Orion command flow.",
      artifactHtml,
    },
  ];
  const [row] = await db
    .insert(designSessions)
    .values({
      title: titleFromGoal(params.goal),
      skillId: "frontend-design",
      designSystemId: null,
      messagesJson: messages,
      currentArtifact: artifactHtml,
    })
    .returning();

  logger.info(`design artifact ready: session=${row.id} path=${artifactPath}`);
  return {
    runDesign: true,
    designSessionId: row.id,
    artifactPath,
    artifactHtml,
    appId: params.appId,
    appPath: params.appPath,
    summary: "Generated Design Studio artifact for downstream build.",
  };
}

function timeoutSignal(ms: number): AbortSignal {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), ms).unref?.();
  return ctrl.signal;
}

async function responseTextOrStatus(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  return text || `HTTP ${response.status} ${response.statusText}`;
}

async function ensureMediaBackendReadyForFlow(): Promise<{
  ready: boolean;
  serverUrl: string;
  reason?: string;
  setupRoute?: string;
}> {
  let status = await getMediaAiBackendStatus();
  if (!status.backendAvailable) {
    return {
      ready: false,
      serverUrl: status.serverUrl,
      reason: "Media AI backend files are missing.",
      setupRoute: "/mediaai",
    };
  }
  if (!status.depsInstalled) {
    return {
      ready: false,
      serverUrl: status.serverUrl,
      reason: "Media AI Python dependencies are not installed.",
      setupRoute: "/mediaai",
    };
  }
  if (!status.healthy) {
    await startMediaAiBackend();
    const started = Date.now();
    while (Date.now() - started < 30_000) {
      status = await getMediaAiBackendStatus();
      if (status.healthy) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  status = await getMediaAiBackendStatus();
  if (!status.healthy) {
    return {
      ready: false,
      serverUrl: status.serverUrl,
      reason: status.lastLog ?? "Media AI backend did not become healthy.",
      setupRoute: "/mediaai",
    };
  }
  return { ready: true, serverUrl: status.serverUrl };
}

async function prepareThreeDAsset(params: {
  goal: string;
  prompt: string;
  imagePath?: string;
  appId?: number;
  appPath?: string;
  mediaDir: string;
}): Promise<Record<string, unknown>> {
  if (!params.imagePath) {
    return {
      run3d: false,
      setupRequired: false,
      reason: "3D asset generation needs a reference image step first.",
      prompt: params.prompt,
    };
  }

  const backend = await ensureMediaBackendReadyForFlow();
  if (!backend.ready) {
    return {
      run3d: false,
      setupRequired: true,
      setupRoute: backend.setupRoute,
      reason: backend.reason,
      sourceImagePath: params.imagePath,
    };
  }

  const diag = await fetch(`${backend.serverUrl}/v1/generate/3d/diagnostics`, {
    signal: timeoutSignal(15_000),
  }).catch((err) => {
    throw new Error(
      `Unable to check 3D runtime diagnostics: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  });
  if (!diag.ok) {
    return {
      run3d: false,
      setupRequired: true,
      setupRoute: "/3dassets",
      reason: await responseTextOrStatus(diag),
      sourceImagePath: params.imagePath,
    };
  }
  const diagnostic = (await diag.json()) as {
    tsr_importable?: boolean;
    skimage_importable?: boolean;
    trimesh_importable?: boolean;
    error?: string | null;
  };
  if (
    !diagnostic.tsr_importable ||
    !diagnostic.skimage_importable ||
    !diagnostic.trimesh_importable
  ) {
    return {
      run3d: false,
      setupRequired: true,
      setupRoute: "/3dassets",
      reason:
        diagnostic.error ??
        "The 3D runtime is not installed. Install 3D Runtime from the 3D Assets workflow.",
      sourceImagePath: params.imagePath,
    };
  }

  const imageBytes = await fs.promises.readFile(params.imagePath);
  const imageArrayBuffer = imageBytes.buffer.slice(
    imageBytes.byteOffset,
    imageBytes.byteOffset + imageBytes.byteLength,
  ) as ArrayBuffer;
  const form = new FormData();
  form.append(
    "image",
    new Blob([imageArrayBuffer]),
    path.basename(params.imagePath) || "reference.png",
  );
  form.append("mesh_resolution", "192");
  form.append("foreground_ratio", "0.85");

  const meshResponse = await fetch(`${backend.serverUrl}/v1/generate/3d`, {
    method: "POST",
    body: form,
    signal: timeoutSignal(10 * 60_000),
  });
  if (!meshResponse.ok) {
    return {
      run3d: false,
      setupRequired: true,
      setupRoute: "/3dassets",
      reason: await responseTextOrStatus(meshResponse),
      sourceImagePath: params.imagePath,
    };
  }
  const mesh = (await meshResponse.json()) as {
    model_url: string;
    tier?: string;
  };
  const glbResponse = await fetch(`${backend.serverUrl}${mesh.model_url}`, {
    signal: timeoutSignal(60_000),
  });
  if (!glbResponse.ok) {
    throw new Error(`Failed to fetch generated GLB: ${glbResponse.status}`);
  }

  await fs.promises.mkdir(params.mediaDir, { recursive: true });
  const outputPath = path.join(
    params.mediaDir,
    `flow-3d-${Date.now()}-${crypto.randomBytes(6).toString("hex")}.glb`,
  );
  const glbBytes = Buffer.from(await glbResponse.arrayBuffer());
  await fs.promises.writeFile(outputPath, glbBytes);
  return {
    run3d: true,
    outputPath,
    sourceImagePath: params.imagePath,
    modelType: "3d",
    tier: mesh.tier ?? null,
    appId: params.appId,
    appPath: params.appPath,
  };
}

interface NewsFeed {
  url: string;
  source: string;
}

const NEWS_FEEDS: Record<string, NewsFeed[]> = {
  top: [
    { url: "https://feeds.bbci.co.uk/news/rss.xml", source: "BBC" },
    { url: "https://www.theguardian.com/world/rss", source: "The Guardian" },
  ],
  ai: [
    {
      url: "https://techcrunch.com/category/artificial-intelligence/feed/",
      source: "TechCrunch AI",
    },
    {
      url: "https://www.technologyreview.com/feed/",
      source: "MIT Technology Review",
    },
  ],
  technology: [
    { url: "https://techcrunch.com/feed/", source: "TechCrunch" },
    { url: "https://www.theverge.com/rss/index.xml", source: "The Verge" },
    {
      url: "https://feeds.bbci.co.uk/news/technology/rss.xml",
      source: "BBC Tech",
    },
  ],
  business: [
    {
      url: "https://feeds.bbci.co.uk/news/business/rss.xml",
      source: "BBC Business",
    },
    {
      url: "https://www.cnbc.com/id/10001147/device/rss/rss.html",
      source: "CNBC",
    },
  ],
  science: [
    {
      url: "https://feeds.bbci.co.uk/news/science_and_environment/rss.xml",
      source: "BBC Science",
    },
    {
      url: "https://www.wired.com/feed/category/science/latest/rss",
      source: "Wired Science",
    },
  ],
};

function chooseNewsCategory(query: string, category?: string): string {
  const lower = `${category ?? ""} ${query}`.toLowerCase();
  if (lower.includes("ai") || lower.includes("artificial intelligence")) {
    return "ai";
  }
  if (lower.includes("tech") || lower.includes("technology")) {
    return "technology";
  }
  if (lower.includes("business") || lower.includes("market")) {
    return "business";
  }
  if (lower.includes("science")) return "science";
  return "top";
}

function stripHtml(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchNewsFeed(feed: NewsFeed): Promise<
  Array<{
    title: string;
    link?: string;
    source: string;
    published?: string;
    summary?: string;
  }>
> {
  const url = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(
    feed.url,
  )}`;
  const response = await fetch(url, { signal: timeoutSignal(20_000) });
  if (!response.ok) return [];
  const data = (await response.json()) as {
    items?: Array<{
      title?: string;
      link?: string;
      pubDate?: string;
      description?: string;
      content?: string;
    }>;
  };
  return (data.items ?? [])
    .filter((item) => typeof item.title === "string" && item.title.trim())
    .slice(0, 8)
    .map((item) => ({
      title: item.title!.trim(),
      link: item.link,
      source: feed.source,
      published: item.pubDate,
      summary: stripHtml(item.description ?? item.content ?? "").slice(0, 280),
    }));
}

async function researchNews(params: {
  goal: string;
  query: string;
  category?: string;
  mediaDir: string;
}): Promise<Record<string, unknown>> {
  const category = chooseNewsCategory(params.query, params.category);
  const feeds = NEWS_FEEDS[category] ?? NEWS_FEEDS.top;
  const settled = await Promise.allSettled(feeds.map(fetchNewsFeed));
  const stories = settled
    .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
    .filter((story, index, all) => {
      const first = all.findIndex(
        (candidate) =>
          candidate.title.toLowerCase() === story.title.toLowerCase(),
      );
      return first === index;
    })
    .slice(0, 10);

  await fs.promises.mkdir(params.mediaDir, { recursive: true });
  const artifactPath = path.join(
    params.mediaDir,
    `flow-news-${Date.now()}-${crypto.randomBytes(6).toString("hex")}.json`,
  );
  await fs.promises.writeFile(
    artifactPath,
    JSON.stringify({ query: params.query, category, stories }, null, 2),
    "utf-8",
  );

  return {
    runNews: true,
    category,
    count: stories.length,
    stories,
    artifactPath,
  };
}

function extractUrl(prompt: string, explicitUrl?: string): string | undefined {
  if (explicitUrl?.trim()) return explicitUrl.trim();
  return prompt.match(/https?:\/\/[^\s"'<>]+/)?.[0];
}

async function ensureWatchdogRunning(): Promise<{
  ready: boolean;
  baseUrl?: string;
  reason?: string;
  setupRoute?: string;
}> {
  if (!isWatchdogSetupComplete()) {
    return {
      ready: false,
      reason: "Watchdog is not set up yet.",
      setupRoute: "/watchdog",
    };
  }
  let status = watchdogBackend.getStatus();
  if (!status.running) {
    await watchdogBackend.start({
      host: WATCHDOG_DEFAULT_HOST,
      port: WATCHDOG_DEFAULT_PORT,
      llmBaseUrl: EMBEDDED_BASE_URL,
      llmModel: "embedded",
    });
    status = watchdogBackend.getStatus();
  }
  if (!status.running || !status.host || !status.port) {
    return {
      ready: false,
      reason: status.lastError ?? "Watchdog backend did not start.",
      setupRoute: "/watchdog",
    };
  }
  return { ready: true, baseUrl: `http://${status.host}:${status.port}` };
}

async function watchdogRequest<T>(
  baseUrl: string,
  endpoint: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
    signal: timeoutSignal(60_000),
  });
  if (!response.ok) {
    throw new Error(await responseTextOrStatus(response));
  }
  return (await response.json()) as T;
}

async function runTracking(params: {
  goal: string;
  prompt: string;
  kind: "website" | "price";
  url?: string;
  targetPrice?: number;
}): Promise<Record<string, unknown>> {
  const url = extractUrl(params.prompt, params.url);
  if (!url) {
    return {
      runTracking: false,
      setupRequired: false,
      reason: "No URL was found in the tracking request.",
      kind: params.kind,
    };
  }

  const watchdog = await ensureWatchdogRunning();
  if (!watchdog.ready || !watchdog.baseUrl) {
    return {
      runTracking: false,
      setupRequired: true,
      setupRoute: watchdog.setupRoute,
      reason: watchdog.reason,
      kind: params.kind,
      url,
    };
  }

  try {
    if (params.kind === "website") {
      const tracked = await watchdogRequest<Record<string, unknown>>(
        watchdog.baseUrl,
        "/websites",
        { method: "POST", body: JSON.stringify({ url }) },
      );
      return { runTracking: true, kind: params.kind, url, tracked };
    }

    const tracked = await watchdogRequest<Record<string, unknown>>(
      watchdog.baseUrl,
      "/products",
      {
        method: "POST",
        body: JSON.stringify({
          url,
          target_price: params.targetPrice ?? null,
        }),
      },
    );
    return {
      runTracking: true,
      kind: params.kind,
      url,
      targetPrice: params.targetPrice ?? null,
      tracked,
    };
  } catch (err) {
    return {
      runTracking: false,
      setupRequired: false,
      reason: err instanceof Error ? err.message : String(err),
      kind: params.kind,
      url,
    };
  }
}

function configureModelLeaseHooks(): void {
  getModelLeaseManager().setHooks({
    availableVramMb: async () => {
      try {
        const profile = await getCachedHardwareProfile();
        const free = await getAvailableVramMb(profile);
        return free > 0 ? free : 65536;
      } catch (err) {
        logger.warn(
          "VRAM probe failed; treating model lease budget as unknown",
          err,
        );
        return 65536;
      }
    },
    load: async (spec: ModelSpec) => {
      logger.info(
        `reserve model lease ${spec.key} (${Math.round(spec.vramMb)} MB)`,
      );
    },
    unload: async (key: string) => {
      logger.info(`release model lease ${key}`);
    },
  });
}

/**
 * Create a fresh OrianBuilder app (scaffold + git) so a from-scratch build
 * command has a workspace. Mirrors the createApp handler's sequence using the
 * same shared building blocks, but is intentionally self-contained so the
 * critical createApp handler is left untouched. Only reached on the no-appId
 * build path. Returns the new app id + chat id.
 */
async function bootstrapAppForFlow(
  goal: string,
): Promise<{ appId: number; chatId: number }> {
  const name = deriveAppName(goal);
  const fullAppPath = getOrianBuilderAppPath(name);

  if (!isAppLocationAccessible(fullAppPath)) {
    throw new Error(
      `Cannot create app at ${fullAppPath}; check your custom apps folder setting.`,
    );
  }

  const runtimeCommands = getTemplateRuntimeCommands(DEFAULT_TEMPLATE_ID);
  const [app] = await db
    .insert(apps)
    .values({
      name,
      path: name,
      installCommand: runtimeCommands.installCommand,
      startCommand: runtimeCommands.startCommand,
    })
    .returning();

  const [chat] = await db
    .insert(chats)
    .values({ appId: app.id, chatMode: "build" })
    .returning();

  await createFromTemplate({ fullAppPath, templateId: DEFAULT_TEMPLATE_ID });

  await gitInit({ path: fullAppPath, ref: "main" });
  await gitAdd({ path: fullAppPath, filepath: "." });
  const commitHash = await gitCommit({
    path: fullAppPath,
    message: "Init OrianBuilder app (Orion flow)",
  });
  await db
    .update(chats)
    .set({ initialCommitHash: commitHash })
    .where(eq(chats.id, chat.id));

  logger.info(`bootstrapped app "${name}" (id=${app.id}) for flow build`);
  return { appId: app.id, chatId: chat.id };
}

/**
 * Prepare a build handoff: ensure there's an app + a fresh chat to build in,
 * then return a descriptor the renderer uses to launch the autonomous Autopilot
 * agent-build (the proven single-prompt builder). Assets produced by earlier
 * flow steps are folded into the build goal so the agent incorporates them.
 */
async function prepareBuildHandoff(params: {
  goal: string;
  appId?: number;
  mediaRefs: string[];
}): Promise<Record<string, unknown>> {
  // No app context: bootstrap a fresh app to build into (from-scratch path).
  let appId = params.appId;
  let chatId: number;
  let createdApp = false;
  if (appId == null) {
    const created = await bootstrapAppForFlow(params.goal);
    appId = created.appId;
    chatId = created.chatId;
    createdApp = true;
  } else {
    const [chat] = await db
      .insert(chats)
      .values({ appId, chatMode: "build" })
      .returning();
    chatId = chat.id;
  }

  const buildGoal = params.mediaRefs.length
    ? `${params.goal}\n\nIncorporate these already-generated assets and design artifacts (copy file assets into the project where useful, and implement the design artifact direction):\n${params.mediaRefs
        .map((p) => `- ${p}`)
        .join("\n")}`
    : params.goal;

  logger.info(
    `build handoff ready: app=${appId} chat=${chatId} createdApp=${createdApp}`,
  );
  return { runBuild: true, appId, chatId, createdApp, buildGoal };
}

/** Total GPU VRAM (MB) for profile selection; 0 when no GPU is detected. */
async function detectTotalVramMb(): Promise<number> {
  try {
    const profile = await getCachedHardwareProfile();
    return profile?.primaryGpu?.vramMb ?? 0;
  } catch (err) {
    logger.warn("VRAM detect failed; assuming 0", err);
    return 0;
  }
}

/**
 * Run the orchestrated pipeline for one prompt: plan (LLM → asset manifest) →
 * batch-generate assets by modality (LLM unloaded, one pipeline resident at a
 * time) → structural verify → return a build handoff so the renderer launches
 * the Autopilot coding pass against the now-generated assets.
 */
/**
 * Pre-download the weights for the user's selected media models that aren't
 * present yet. Returns a "download" phase record for the run summary. Never
 * throws: a failed/partial download is non-fatal (generation falls back to a
 * placeholder), so the prompt is never lost. Runtime-install models (3D TripoSR,
 * music ACE-Step) ship with the media backend setup and fetch weights on first
 * use — they're surfaced here but not auto-installed mid-run.
 */
async function predownloadSelectedModels(
  selection: ReturnType<typeof resolveSelection>,
  backendReady: boolean,
  emit?: (e: PipelineProgress) => void,
): Promise<PhaseRecord> {
  if (!backendReady) {
    emit?.({
      kind: "download",
      label: "Media backend not ready",
      detail: "skipping pre-download; assets may fall back to placeholders",
      status: "partial",
    });
    return {
      phase: "download",
      status: "partial",
      detail: "media backend not ready; skipped pre-download",
    };
  }
  try {
    emit?.({
      kind: "download",
      label: "Checking selected media models",
      status: "running",
    });
    const status = await getMediaAiBackendStatus();
    const downloaded = new Set(
      status.models.filter((m) => m.downloaded).map((m) => m.id),
    );
    const plan = resolveDownloadPlan(selection, downloaded);
    const notes: string[] = [];

    if (plan.models.length > 0) {
      logger.info(`pre-downloading selected models: ${plan.models.join(", ")}`);
      emit?.({
        kind: "download",
        label: `Downloading ${plan.models.join(", ")}`,
        detail: "this can take a while on first use",
        status: "running",
      });
      // Forward the raw download log lines so the UI shows live progress.
      await downloadMediaAiModels(plan.models, (chunk) => {
        const line = chunk
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)
          .pop();
        if (line) emit?.({ kind: "log", label: "download", detail: line });
      });
      emit?.({
        kind: "download",
        label: `Downloaded ${plan.models.join(", ")}`,
        status: "ok",
      });
      notes.push(`downloaded ${plan.models.join(", ")}`);
    } else {
      emit?.({
        kind: "download",
        label: "Selected model weights present",
        status: "ok",
      });
      notes.push("selected weights present");
    }
    if (plan.runtimes.length > 0) {
      emit?.({
        kind: "download",
        label: `${plan.runtimes.join("/")} runtime installs on first use`,
        status: "partial",
      });
      notes.push(`${plan.runtimes.join("/")} runtime installs on first use`);
    }
    return { phase: "download", status: "ok", detail: notes.join("; ") };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn(`pre-download failed (non-fatal): ${detail}`);
    emit?.({
      kind: "download",
      label: "Pre-download issue",
      detail,
      status: "partial",
    });
    return {
      phase: "download",
      status: "partial",
      detail: `pre-download issue: ${detail}`,
    };
  }
}

async function runOrionPipeline(params: {
  text: string;
  appId?: number;
  emit?: (e: PipelineProgress) => void;
}): Promise<PipelineRunResult> {
  const emit = params.emit;
  // Resolve the user's per-modality model selection (Apps-screen config box) and
  // bake it into the hardware profile, so generation uses the chosen models.
  // Unset selections fall back to the profile defaults.
  const selection = resolveSelection(readSettings().orionMediaModels);
  const profile = applySelectionToProfile(
    selectProfileForVram(await detectTotalVramMb()),
    selection,
  );
  configureModelGateHooks();

  // Auto-start the Media AI backend so local image/video/music/3D can actually
  // run. Without this, asset generation silently degrades to placeholders
  // ("local media backend not running"). Non-blocking: if it can't be made
  // ready, the dispatcher's placeholder fallback still keeps the build moving.
  const mediaBackend = await ensureMediaBackendReadyForFlow();
  if (!mediaBackend.ready) {
    logger.warn(
      `media backend not ready (${mediaBackend.reason ?? "unknown"}); media assets will fall back to placeholders. Set it up at ${mediaBackend.setupRoute ?? "/mediaai"}.`,
    );
  }

  // Pre-download any selected media-model weights that aren't present yet, BEFORE
  // planning, so the run proceeds straight through once they're ready. The prompt
  // is never lost; failures are non-fatal (generation falls back to placeholder).
  const downloadPhase = await predownloadSelectedModels(
    selection,
    mediaBackend.ready,
    emit,
  );

  // Ensure a workspace + build chat exist; resolve the app's media dir.
  let appId = params.appId;
  let chatId: number;
  if (appId == null) {
    const created = await bootstrapAppForFlow(params.text);
    appId = created.appId;
    chatId = created.chatId;
  } else {
    const [chat] = await db
      .insert(chats)
      .values({ appId, chatMode: "build" })
      .returning();
    chatId = chat.id;
  }
  const appRow = await db.query.apps.findFirst({ where: eq(apps.id, appId) });
  const appPath = appRow ? getOrianBuilderAppPath(appRow.path) : undefined;
  const mediaDir = appPath
    ? path.join(appPath, ORIANBUILDER_MEDIA_DIR_NAME)
    : path.join(getOrianBuilderAppPath("orion-flow"), "media");
  await fs.promises.mkdir(mediaDir, { recursive: true });

  const workers: PipelineWorkers = {
    planCode: async ({ buildId, goal }) =>
      generateAssetManifest({
        buildId,
        goal,
        profile,
        generate: defaultGenerateText,
      }),
    generateAsset: createMediaAssetWorker({
      dispatch: dispatchMediaGeneration,
      generate3d: backendThreeDGenerator,
    }),
    // Phase C (structural verify): the conductor already set each asset's
    // status. Failed assets get one regen pass; after that we proceed so the
    // build is never blocked. (Vision-based verification is a later addition.)
    verifyFix: async ({ manifest, attempt }) => {
      const failed = manifest.assets
        .filter((a) => a.status === "failed")
        .map((a) => a.id);
      if (failed.length === 0) {
        return { ok: true, report: "all assets generated" };
      }
      if (attempt >= 2) {
        return {
          ok: true,
          report: `proceeding with ${failed.length} unfilled asset(s)`,
        };
      }
      return {
        ok: false,
        regenAssetIds: failed,
        report: `regenerating ${failed.length} failed asset(s)`,
      };
    },
  };

  const result = await runPipeline({
    goal: params.text,
    appId,
    appPath,
    mediaDir,
    profile,
    gate: getModelGate(),
    workers,
    llmModelId: getLastLlmModelId(),
    maxVerifyAttempts: 2,
    onProgress: emit,
  });

  // Collect the produced asset files (done or placeholder) for the build to use.
  const assetPaths: string[] = [];
  for (const asset of result.manifest.assets) {
    if (asset.status === "done" || asset.status === "placeholder") {
      assetPaths.push(path.join(mediaDir, asset.targetFilename));
    }
  }

  const buildGoal = assetPaths.length
    ? `${params.text}\n\nThese media assets have already been generated for this build — reference/copy them into the project at the paths the app expects:\n${assetPaths
        .map((p) => `- ${p}`)
        .join("\n")}`
    : params.text;

  logger.info(
    `orion pipeline ${result.buildId} → ${result.status}; assets done=${result.assetSummary.done} ph=${result.assetSummary.placeholder} failed=${result.assetSummary.failed}; handing off build app=${appId} chat=${chatId}`,
  );

  // Mark this build chat so the Autopilot coding pass does NOT generate media
  // itself — the pipeline already produced the assets with the LLM unloaded.
  // Generating media during coding would load a media model alongside the
  // resident LLM and run out of RAM/VRAM (the exact OOM we hit).
  markFactoryBuildChat(chatId);

  return {
    buildId: result.buildId,
    status: result.status,
    phases: [downloadPhase, ...result.phases],
    assetSummary: result.assetSummary,
    verifyAttempts: result.verifyAttempts,
    assetPaths,
    runBuild: result.status !== "failed",
    appId,
    chatId,
    buildGoal,
    reason: result.status === "failed" ? "planning phase failed" : undefined,
  };
}

/** Resolve the device model profile with the user's per-modality selection
 *  baked in (selected models + best per-stage settings). */
async function resolveMediaProfile(): Promise<HardwareModelProfile> {
  const selection = resolveSelection(readSettings().orionMediaModels);
  return applySelectionToProfile(
    selectProfileForVram(await detectTotalVramMb()),
    selection,
  );
}

/** Capability → coarse media kind + default mime, for the chat reply. */
const MEDIA_REPLY_KINDS: Partial<
  Record<CapabilityId, { kind: MediaReplyAsset["kind"]; mimeType: string }>
> = {
  generate_image: { kind: "image", mimeType: "image/png" },
  generate_video: { kind: "video", mimeType: "video/mp4" },
  generate_audio: { kind: "audio", mimeType: "audio/wav" },
  generate_music: { kind: "audio", mimeType: "audio/wav" },
  generate_3d_asset: { kind: "model", mimeType: "model/gltf-binary" },
};

/** Path of `abs` relative to `appPath` (forward slashes), or undefined if it
 *  escapes the app dir / no app path is known (chat can't resolve it then). */
function toAppRelativePath(
  appPath: string | undefined,
  abs: string,
): string | undefined {
  if (!appPath) return undefined;
  const rel = path.relative(appPath, abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
  return rel.split(path.sep).join("/");
}

/**
 * Generate the media for a parsed media-only intent and return descriptors the
 * renderer renders inline as a chat reply. Uses the user's selected model per
 * modality at the device's best settings (the profile), writing files under the
 * intent's app dir so the chat's orian-media:// protocol can resolve them.
 */
async function runOrionMediaReply(
  intent: CommandIntent,
): Promise<MediaReplyResult> {
  // Best-effort: bring the local media backend up so generation isn't degraded.
  const backend = await ensureMediaBackendReadyForFlow();
  if (!backend.ready) {
    logger.warn(
      `media backend not ready (${backend.reason ?? "unknown"}); media may fall back. Set it up at ${backend.setupRoute ?? "/mediaai"}.`,
    );
  }

  const mediaProfile = await resolveMediaProfile();
  const flow = await runFlow(intent, { mediaProfile });

  let appPath: string | undefined;
  if (intent.appId != null) {
    const appRow = await db.query.apps.findFirst({
      where: eq(apps.id, intent.appId),
    });
    appPath = appRow ? getOrianBuilderAppPath(appRow.path) : undefined;
  }

  // The prompt for each rendered asset comes from the intent step's input.
  const promptByStepId = new Map(
    intent.steps.map((s) => [
      s.id,
      typeof s.input.prompt === "string" ? s.input.prompt : undefined,
    ]),
  );

  const assets: MediaReplyAsset[] = [];
  for (const step of flow.steps) {
    const meta = MEDIA_REPLY_KINDS[step.capability];
    if (!meta) continue; // non-media step (e.g. a design artifact) — skip

    const out = step.output;
    const prompt = promptByStepId.get(step.stepId) || intent.goal;

    if (step.status === "failed") {
      assets.push({
        capability: step.capability,
        kind: meta.kind,
        mimeType: meta.mimeType,
        prompt,
        error: step.error ?? `${step.capability} failed`,
      });
      continue;
    }
    if (out.setupRequired === true) {
      assets.push({
        capability: step.capability,
        kind: meta.kind,
        mimeType: meta.mimeType,
        prompt,
        error: typeof out.reason === "string" ? out.reason : "setup required",
        setupRoute:
          typeof out.setupRoute === "string" ? out.setupRoute : "/mediaai",
      });
      continue;
    }

    const abs = typeof out.outputPath === "string" ? out.outputPath : undefined;
    if (!abs) continue; // skipped / produced no file
    assets.push({
      capability: step.capability,
      kind: meta.kind,
      mimeType: meta.mimeType,
      prompt,
      absolutePath: abs,
      relativePath: toAppRelativePath(appPath, abs),
      durationMs: step.durationMs,
    });
  }

  logger.info(
    `orion media reply: ${assets.length} asset(s) for "${intent.goal}" (status=${flow.status})`,
  );
  return { status: flow.status, assets };
}

export function registerFlowHandlers(): void {
  configureModelLeaseHooks();
  // Wire the build_app capability to the Autopilot agent-build handoff.
  setBuildExecutor(prepareBuildHandoff);
  setDesignExecutor(prepareDesignArtifact);
  setThreeDExecutor(prepareThreeDAsset);
  setNewsExecutor(researchNews);
  setTrackingExecutor(runTracking);
  // Mid-flow review checkpoints: at each modality-batch boundary the selected
  // model may repair the prompts of still-pending steps (never fails a flow).
  setFlowReviewer(createLlmFlowReviewer(defaultGenerateText));

  handle(flowContracts.parseCommand, async (_event, { text, appId }) => {
    return parseIntent(text, appId);
  });

  handle(flowContracts.runFlow, async (_event, intent) => {
    const mediaProfile = await resolveMediaProfile();
    return runFlow(intent, { mediaProfile });
  });

  handle(flowContracts.runCommand, async (_event, { text, appId }) => {
    const intent = await parseIntent(text, appId);
    const mediaProfile = await resolveMediaProfile();
    return runFlow(intent, { mediaProfile });
  });

  handle(flowContracts.listCapabilities, async () => {
    return listCapabilities();
  });

  handle(flowContracts.runPipeline, async (event, { text, appId }) => {
    const sender = event.sender;
    const emit = (payload: PipelineProgress) =>
      safeSend(sender, flowEvents.pipelineProgress.channel, payload);
    return runOrionPipeline({ text, appId, emit });
  });

  handle(flowContracts.generateMedia, async (_event, { intent }) => {
    return runOrionMediaReply(intent);
  });

  handle(flowContracts.listResumableFlows, async () => {
    return listResumableFlowRuns();
  });

  handle(flowContracts.resumeFlow, async (_event, { flowId }) => {
    const mediaProfile = await resolveMediaProfile();
    return resumeFlow(flowId, { mediaProfile });
  });
}
