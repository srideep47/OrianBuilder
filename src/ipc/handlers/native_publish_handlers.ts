import fs from "node:fs";
import path from "node:path";
import log from "electron-log";
import { eq } from "drizzle-orm";

import { db } from "../../db";
import { apps } from "../../db/schema";
import { getOrianBuilderAppPath } from "@/paths/paths";
import { createTypedHandler } from "./base";
import { miscContracts } from "../types/misc";
import {
  OrianBuilderError,
  OrianBuilderErrorKind,
} from "@/errors/orianbuilder_error";
import { execGit } from "../utils/git_utils";
import { getOrchestrator } from "@/main/ipc/utils/model_orchestrator";
import { initMediaDispatcher } from "@/main/ipc/utils/media_dispatcher";

const logger = log.scope("native_publish_handlers");

const NATIVE_SITE_DIR = "native-download-site";
const NATIVE_DOWNLOADS_DIR = "downloads";

// Paths that should never end up in a git push. GitHub blocks files over
// 100 MB; the binaries that the agent's package_native_artifact produces
// (Electron installers especially) routinely break that limit. node_modules
// also frequently contains 100+ MB binaries (electron.exe, native bindings).
// Keeping these out of git is non-negotiable; the static download page lives
// in the rest of native-download-site/, which we DO want pushed for Vercel.
const PUBLISH_GITIGNORE_ENTRIES = [
  "# OrianBuilder publish guards — never ship large binaries through git.",
  "# Native installers are uploaded to GitHub Releases by the publish flow.",
  "node_modules/",
  "dist/",
  "dist_electron/",
  "out/",
  "release/",
  "build/",
  "native-download-site/downloads/",
  "native-download-site/*.exe",
  "native-download-site/*.msi",
  "native-download-site/*.dmg",
  "native-download-site/*.apk",
  "native-download-site/*.AppImage",
  "native-download-site/*.deb",
  ".env",
  ".env.local",
];
// Subset above used by `git rm --cached` to untrack already-committed paths.
const PUBLISH_UNTRACK_PATHS = [
  "node_modules",
  "dist",
  "dist_electron",
  "out",
  "release",
  "build",
  "native-download-site/downloads",
];
// Binary file extensions that should never be committed under native-download-site/.
const NATIVE_SITE_BINARY_EXTS = new Set([
  ".exe",
  ".msi",
  ".dmg",
  ".apk",
  ".appimage",
  ".deb",
]);

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Adds publish-guard entries to .gitignore and untracks any already-staged
 * large binaries. Idempotent. Exported so main-process tools (e.g. the agent's
 * `github_pr autopilot` flow) can run the same self-heal before pushing,
 * without going through the IPC layer.
 */
export async function preparePublishGitignoreForAppPath(
  appPath: string,
): Promise<{ gitignoreUpdated: boolean; untrackedPaths: string[] }> {
  const gitignorePath = path.join(appPath, ".gitignore");
  const existing = fs.existsSync(gitignorePath)
    ? fs.readFileSync(gitignorePath, "utf-8")
    : "";
  const existingLines = new Set(
    existing
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#")),
  );
  const missingEntries = PUBLISH_GITIGNORE_ENTRIES.filter((entry) => {
    if (entry.startsWith("#")) return false;
    return !existingLines.has(entry.trim());
  });

  let gitignoreUpdated = false;
  if (missingEntries.length > 0) {
    const header = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    const block =
      `${header}\n# --- OrianBuilder publish guards (auto-managed) ---\n` +
      PUBLISH_GITIGNORE_ENTRIES.filter(
        (entry) => entry.startsWith("#") || !existingLines.has(entry.trim()),
      ).join("\n") +
      "\n";
    fs.writeFileSync(gitignorePath, existing + block, "utf-8");
    gitignoreUpdated = true;
  }

  const untrackedPaths: string[] = [];
  for (const relPath of PUBLISH_UNTRACK_PATHS) {
    try {
      const result = await execGit(
        ["rm", "-r", "--cached", "--ignore-unmatch", "--", relPath],
        appPath,
      );
      if (result.exitCode === 0) {
        const removedLineCount = result.stdout
          .split(/\r?\n/)
          .filter((line) => line.startsWith("rm ")).length;
        if (removedLineCount > 0) {
          untrackedPaths.push(relPath);
          logger.info(
            `Untracked ${removedLineCount} file(s) under ${relPath} at ${appPath}.`,
          );
        }
      } else {
        logger.warn(
          `git rm --cached ${relPath} exited ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`,
        );
      }
    } catch (err: any) {
      logger.warn(
        `git rm --cached ${relPath} threw: ${err?.message ?? String(err)}`,
      );
    }
  }

  // Also untrack any binary files already committed directly under native-download-site/
  // (agent sometimes copies installer there instead of under downloads/).
  try {
    const lsResult = await execGit(
      ["ls-files", "--", "native-download-site"],
      appPath,
    );
    if (lsResult.exitCode === 0) {
      const committedFiles = lsResult.stdout
        .split(/\r?\n/)
        .map((f) => f.trim())
        .filter((f) => f.length > 0);
      for (const relFile of committedFiles) {
        const ext = path.extname(relFile).toLowerCase();
        if (!NATIVE_SITE_BINARY_EXTS.has(ext)) continue;
        try {
          const rmResult = await execGit(
            ["rm", "--cached", "--ignore-unmatch", "--", relFile],
            appPath,
          );
          if (rmResult.exitCode === 0 && rmResult.stdout.includes("rm ")) {
            untrackedPaths.push(relFile);
            logger.info(
              `Untracked binary ${relFile} from native-download-site/ at ${appPath}.`,
            );
          }
        } catch (err: any) {
          logger.warn(
            `git rm --cached ${relFile} threw: ${err?.message ?? String(err)}`,
          );
        }
      }
    }
  } catch (err: any) {
    logger.warn(
      `git ls-files native-download-site threw: ${err?.message ?? String(err)}`,
    );
  }

  return { gitignoreUpdated, untrackedPaths };
}

async function resolveAppPath(appId: number): Promise<string> {
  const app = await db.query.apps.findFirst({ where: eq(apps.id, appId) });
  if (!app) {
    throw new OrianBuilderError(
      `App not found: ${appId}`,
      OrianBuilderErrorKind.NotFound,
    );
  }
  return getOrianBuilderAppPath(app.path);
}

export function registerNativePublishHandlers() {
  createTypedHandler(
    miscContracts.preparePublishGitignore,
    async (_, { appId }) => {
      const appPath = await resolveAppPath(appId);
      return preparePublishGitignoreForAppPath(appPath);
    },
  );

  createTypedHandler(
    miscContracts.listNativeDownloads,
    async (_, { appId }) => {
      const appPath = await resolveAppPath(appId);
      const sitePath = path.join(appPath, NATIVE_SITE_DIR);
      const downloadsPath = path.join(sitePath, NATIVE_DOWNLOADS_DIR);

      if (!fs.existsSync(downloadsPath)) {
        return {
          exists: false,
          siteRelativePath: NATIVE_SITE_DIR,
          downloadsRelativePath: `${NATIVE_SITE_DIR}/${NATIVE_DOWNLOADS_DIR}`,
          files: [],
        };
      }

      const entries = fs.readdirSync(downloadsPath, { withFileTypes: true });
      const files = entries
        .filter((entry) => entry.isFile())
        .map((entry) => {
          const absolutePath = path.join(downloadsPath, entry.name);
          const stats = fs.statSync(absolutePath);
          return {
            name: entry.name,
            sizeBytes: stats.size,
            absolutePath,
          };
        })
        .sort((a, b) => b.sizeBytes - a.sizeBytes);

      return {
        exists: files.length > 0,
        siteRelativePath: NATIVE_SITE_DIR,
        downloadsRelativePath: `${NATIVE_SITE_DIR}/${NATIVE_DOWNLOADS_DIR}`,
        files,
      };
    },
  );

  createTypedHandler(
    miscContracts.applyNativeReleaseLinks,
    async (_, { appId, releaseHtmlUrl, tag, links, pruneLocalDownloads }) => {
      const appPath = await resolveAppPath(appId);
      const sitePath = path.join(appPath, NATIVE_SITE_DIR);

      if (!fs.existsSync(sitePath)) {
        throw new OrianBuilderError(
          `Native download site missing at ${NATIVE_SITE_DIR}/ — package the app first.`,
          OrianBuilderErrorKind.Precondition,
        );
      }
      if (links.length === 0) {
        throw new OrianBuilderError(
          "No release links supplied for the native download page.",
          OrianBuilderErrorKind.Validation,
        );
      }

      // Rewrite native-download-site/index.html so download buttons point at
      // GitHub Releases instead of the local binaries we used to ship inside
      // the Vercel deploy.
      const primary = links[0];
      const platformLabel = (() => {
        const lowered = primary.name.toLowerCase();
        if (lowered.endsWith(".apk")) return "Android APK";
        if (lowered.endsWith(".exe") || lowered.endsWith(".msi"))
          return "Windows installer";
        if (lowered.endsWith(".dmg")) return "macOS app";
        if (lowered.endsWith(".appimage") || lowered.endsWith(".deb"))
          return "Linux app";
        return "Download";
      })();

      const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(platformLabel)} — ${escapeHtml(tag)}</title>
    <style>
      :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f4f7fb; color: #151923; }
      main { width: min(92vw, 680px); padding: 32px; background: #fff; border: 1px solid #d8e0eb; border-radius: 8px; box-shadow: 0 24px 70px rgba(31, 41, 55, .12); }
      h1 { margin: 0 0 10px; font-size: clamp(2rem, 5vw, 3rem); letter-spacing: 0; }
      p { margin: 0 0 24px; color: #5d6878; line-height: 1.6; }
      a.primary { display: inline-flex; align-items: center; justify-content: center; min-height: 48px; padding: 0 20px; border-radius: 8px; background: #111827; color: white; text-decoration: none; font-weight: 700; }
      ul { margin: 24px 0 0; padding: 0; list-style: none; display: grid; gap: 10px; }
      li { display: flex; justify-content: space-between; gap: 16px; padding: 12px 0; border-top: 1px solid #e5eaf1; }
      li a { color: #1d4ed8; font-weight: 650; text-decoration: none; }
      .size { color: #6b7280; white-space: nowrap; }
      .release { margin-top: 24px; font-size: 14px; color: #6b7280; }
      .release a { color: #1d4ed8; }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(platformLabel)}</h1>
      <p>Latest build <strong>${escapeHtml(tag)}</strong>. Hosted on GitHub Releases.</p>
      <a class="primary" href="${escapeHtml(primary.url)}">Download ${escapeHtml(primary.name)}</a>
      <ul>
        ${links
          .map(
            (link) =>
              `<li><a href="${escapeHtml(link.url)}">${escapeHtml(link.name)}</a><span class="size">${escapeHtml(formatBytes(link.sizeBytes))}</span></li>`,
          )
          .join("\n        ")}
      </ul>
      <p class="release">All builds: <a href="${escapeHtml(releaseHtmlUrl)}">${escapeHtml(releaseHtmlUrl)}</a></p>
    </main>
  </body>
</html>
`;

      const indexHtmlPath = path.join(sitePath, "index.html");
      fs.writeFileSync(indexHtmlPath, html, "utf-8");

      // Strip the local binaries — the Vercel deploy no longer needs them.
      if (pruneLocalDownloads !== false) {
        const downloadsPath = path.join(sitePath, NATIVE_DOWNLOADS_DIR);
        if (fs.existsSync(downloadsPath)) {
          fs.rmSync(downloadsPath, { recursive: true, force: true });
        }
      }

      // Write a project-root vercel.json so Vercel serves the static download
      // site instead of trying to build the source repo as a normal web app.
      const rootVercelJsonPath = path.join(appPath, "vercel.json");
      // Use "" (empty string) not null for build/install commands.
      // null = Vercel default (may auto-detect Next.js/etc and run a build).
      // ""  = explicit no-op: skip build step entirely for this static site.
      const rootVercelJson = {
        $schema: "https://openapi.vercel.sh/vercel.json",
        framework: null,
        buildCommand: "",
        installCommand: "",
        outputDirectory: NATIVE_SITE_DIR,
        cleanUrls: true,
      };
      fs.writeFileSync(
        rootVercelJsonPath,
        JSON.stringify(rootVercelJson, null, 2) + "\n",
        "utf-8",
      );

      logger.info(
        `Applied native release links for app ${appId} (${links.length} assets, tag=${tag}).`,
      );

      return {
        indexHtmlRelativePath: `${NATIVE_SITE_DIR}/index.html`,
        rootVercelJsonRelativePath: "vercel.json",
      };
    },
  );

  createTypedHandler(
    miscContracts.generateMediaForApp,
    async (_, { appId, modelType, prompt, requestId }) => {
      const started = Date.now();
      const app = await db.query.apps.findFirst({ where: eq(apps.id, appId) });
      if (!app) {
        return {
          success: false,
          durationMs: 0,
          error: `App not found: ${appId}`,
        };
      }
      const appPath = getOrianBuilderAppPath(app.path);
      const mediaDir = path.join(appPath, ".orianbuilder", "media");
      await fs.promises.mkdir(mediaDir, { recursive: true });
      const ext = modelType === "video" ? "mp4" : "wav";
      const ts = Date.now();
      const sanitized =
        prompt
          .slice(0, 24)
          .replace(/[^a-zA-Z0-9]/g, "_")
          .toLowerCase() || modelType;
      const fileName = `${modelType}_${sanitized}_${ts}.${ext}`;
      const outputPath = path.join(mediaDir, fileName);

      initMediaDispatcher();

      const result = await getOrchestrator().runMediaGeneration({
        modelType,
        prompt,
        outputPath,
        options: { requestId },
      });

      if (!result.success) {
        return {
          success: false,
          durationMs: Date.now() - started,
          error: result.error ?? `${modelType} generation failed`,
        };
      }

      return {
        success: true,
        fileName,
        filePath: outputPath,
        appPath: app.path,
        appId: app.id,
        appName: app.name,
        durationMs: Date.now() - started,
      };
    },
  );
}
