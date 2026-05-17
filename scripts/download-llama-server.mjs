#!/usr/bin/env node
/**
 * Fetch llama-server binaries from llama.cpp's GitHub releases into
 * resources/llama-server/<variant>/.
 *
 * Usage:
 *   node scripts/download-llama-server.mjs              # all platforms
 *   node scripts/download-llama-server.mjs --here       # current OS/arch only
 *   node scripts/download-llama-server.mjs --tag b4400  # pin to a specific release
 *
 * The release naming is `llama-<tag>-bin-<platform>-<variant>.zip` for
 * Windows/Linux, `llama-<tag>-bin-macos-arm64.zip` for macOS. The script
 * unpacks each zip and copies just the llama-server binary into the right
 * variant subdir; the rest of llama.cpp's binaries are discarded.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import os from "node:os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const targetRoot = path.join(projectRoot, "resources", "llama-server");

const RELEASE_OWNER = "ggerganov";
const RELEASE_REPO = "llama.cpp";

/**
 * For each variant, list the assets that must be unpacked into its directory.
 *
 * `preferredAssets` is the prioritized list of substring-match candidates for
 * the MAIN llama-server archive (each entry is a list of substrings that all
 * have to appear in the filename, anchored by `llama-` to avoid picking up
 * sidecar packages like `cudart-llama-bin-...`).
 *
 * `companionAssets` are additional archives whose contents must sit next to
 * llama-server.exe — most importantly the CUDA runtime DLLs (cudart-*) which
 * the CUDA build dynamically links against.
 */
const VARIANT_PATTERNS = {
  "win-cuda": {
    // Prefer the cu12 build — wider driver compatibility than cu13.
    // The "!cudart" exclusion keeps us off the runtime-only sidecar archive.
    preferredAssets: [
      ["llama-", "bin-win-cuda-12", "x64.zip", "!cudart"],
      ["llama-", "bin-win-cuda-13", "x64.zip", "!cudart"],
      ["llama-", "bin-win-cuda", "x64.zip", "!cudart"],
    ],
    companionAssets: [
      // CUDA runtime DLLs; pick the matching major version.
      ["cudart-llama-bin-win-cuda-12", "x64.zip"],
      ["cudart-llama-bin-win-cuda-13", "x64.zip"],
      ["cudart-llama-bin-win-cuda", "x64.zip"],
    ],
  },
  "win-vulkan": {
    preferredAssets: [["llama-", "bin-win-vulkan", "x64.zip"]],
    companionAssets: [],
  },
  "win-cpu": {
    preferredAssets: [
      ["llama-", "bin-win-cpu", "x64.zip"],
      ["llama-", "bin-win-avx2", "x64.zip"],
    ],
    companionAssets: [],
  },
  // Linux + macOS prebuilts come and go in upstream releases — when the
  // matching asset is missing we log a clear "compile your own" hint and
  // leave the variant dir empty.
  "linux-cuda": {
    preferredAssets: [["llama-", "bin-linux-cuda", "x64"]],
    companionAssets: [],
  },
  "linux-vulkan": {
    preferredAssets: [["llama-", "bin-linux-vulkan", "x64"]],
    companionAssets: [],
  },
  "linux-cpu": {
    preferredAssets: [
      ["llama-", "bin-ubuntu", "x64.zip"],
      ["llama-", "bin-linux-cpu", "x64.zip"],
    ],
    companionAssets: [],
  },
  "mac-metal": {
    preferredAssets: [["llama-", "bin-macos", "arm64.zip"]],
    companionAssets: [],
  },
};

/**
 * The "current" platform's set of variants. `--here` downloads all of them
 * so the binary discovery code in llama_server_binary.ts can pick whichever
 * matches the hardware profile at runtime (CUDA vs Vulkan vs CPU).
 */
function detectCurrentVariants() {
  const platform = process.platform;
  if (platform === "darwin") return ["mac-metal"];
  if (platform === "linux") return ["linux-cuda", "linux-vulkan", "linux-cpu"];
  if (platform === "win32") return ["win-cuda", "win-vulkan", "win-cpu"];
  throw new Error(`Unsupported platform: ${platform}`);
}

function parseArgs(argv) {
  const args = { here: false, tag: null, variants: null };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--here") args.here = true;
    else if (arg === "--tag") args.tag = argv[++i];
    else if (arg === "--variants")
      args.variants = argv[++i]?.split(",") ?? null;
  }
  return args;
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "orianbuilder-llama-server-downloader",
      Accept: "application/vnd.github+json",
    },
  });
  if (!res.ok) {
    throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function fetchToFile(url, destPath) {
  const res = await fetch(url, {
    headers: { "User-Agent": "orianbuilder-llama-server-downloader" },
    redirect: "follow",
  });
  if (!res.ok || !res.body) {
    throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  }
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(destPath));
}

function unzip(archivePath, destDir) {
  return new Promise((resolve, reject) => {
    if (process.platform === "win32") {
      // PowerShell ships everywhere — avoid requiring a separate unzip binary.
      const child = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${destDir}' -Force`,
        ],
        { stdio: "inherit" },
      );
      child.on("exit", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`Expand-Archive exited ${code}`)),
      );
      return;
    }
    const child = spawn("unzip", ["-o", "-q", archivePath, "-d", destDir], {
      stdio: "inherit",
    });
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`unzip exited ${code}`)),
    );
  });
}

/**
 * Match a release asset by required substrings. Fragments prefixed with `!`
 * are *exclusions* — the asset name must NOT contain them (useful to filter
 * sidecar packages like `cudart-llama-bin-...` that otherwise alias the main
 * binary archive's pattern).
 */
function assetMatches(name, fragments) {
  const lower = name.toLowerCase();
  for (const fragment of fragments) {
    if (fragment.startsWith("!")) {
      if (lower.includes(fragment.slice(1).toLowerCase())) return false;
    } else if (!lower.includes(fragment.toLowerCase())) {
      return false;
    }
  }
  return true;
}

function pickAsset(release, preferredAssets) {
  const assets = release.assets ?? [];
  for (const fragments of preferredAssets) {
    for (const asset of assets) {
      if (assetMatches(asset.name, fragments)) return asset;
    }
  }
  return null;
}

function findBinaryInDir(rootDir, binaryName) {
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name === binaryName) {
        return full;
      }
    }
  }
  return null;
}

async function fetchAndUnpack(asset, unpackedDir, tmpDir) {
  const archivePath = path.join(tmpDir, asset.name);
  await fetchToFile(asset.browser_download_url, archivePath);
  await unzip(archivePath, unpackedDir);
}

async function copyAllFilesFromDir(sourceDir, targetDir, predicate) {
  await fs.promises.mkdir(targetDir, { recursive: true });
  const stack = [sourceDir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry.isFile() && (!predicate || predicate(entry.name))) {
        await fs.promises.copyFile(full, path.join(targetDir, entry.name));
      }
    }
  }
}

async function downloadVariant(release, variant) {
  const spec = VARIANT_PATTERNS[variant];
  if (!spec) {
    console.warn(`Unknown variant: ${variant} — skipping`);
    return false;
  }
  const mainAsset = pickAsset(release, spec.preferredAssets);
  if (!mainAsset) {
    console.warn(
      `[${variant}] no matching asset in release ${release.tag_name}. ` +
        `Compile llama-server yourself and set LLAMA_SERVER_PATH, or place ` +
        `the binary at resources/llama-server/${variant}/.`,
    );
    return false;
  }

  const binaryName = variant.startsWith("win-")
    ? "llama-server.exe"
    : "llama-server";
  const targetDir = path.join(targetRoot, variant);
  const targetBinary = path.join(targetDir, binaryName);

  console.log(
    `[${variant}] ${mainAsset.name} → ${path.relative(projectRoot, targetBinary)}`,
  );

  const tmpDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), `llama-server-${variant}-`),
  );
  const unpackedDir = path.join(tmpDir, "unpacked");
  await fs.promises.mkdir(unpackedDir, { recursive: true });

  try {
    await fetchAndUnpack(mainAsset, unpackedDir, tmpDir);
    const found = findBinaryInDir(unpackedDir, binaryName);
    if (!found) {
      console.warn(
        `[${variant}] "${binaryName}" not found inside ${mainAsset.name}; skipping.`,
      );
      return false;
    }

    // Copy llama-server binary plus every sidecar DLL/.so from the same
    // archive subdir (llama.dll, ggml.dll, etc. on Windows; libllama.so on
    // Linux). llama-server links against these dynamically.
    const binarySourceDir = path.dirname(found);
    await copyAllFilesFromDir(binarySourceDir, targetDir, (name) => {
      const lower = name.toLowerCase();
      return (
        name === binaryName ||
        lower.endsWith(".dll") ||
        lower.endsWith(".so") ||
        lower.endsWith(".dylib") ||
        lower.endsWith(".metallib")
      );
    });

    if (process.platform !== "win32") {
      await fs.promises.chmod(targetBinary, 0o755);
    }

    // Companion assets (typically CUDA runtime DLLs that the main archive
    // doesn't include but the binary needs at load time). We pick at most
    // one asset per fragment list and dedupe across lists.
    const downloadedCompanions = new Set();
    for (const fragments of spec.companionAssets) {
      const companion = pickAsset(release, [fragments]);
      if (!companion || downloadedCompanions.has(companion.id)) continue;
      downloadedCompanions.add(companion.id);
      console.log(`[${variant}] (companion) ${companion.name}`);
      const companionUnpacked = path.join(
        tmpDir,
        `companion-${companion.name}`,
      );
      await fs.promises.mkdir(companionUnpacked, { recursive: true });
      await fetchAndUnpack(companion, companionUnpacked, tmpDir);
      await copyAllFilesFromDir(companionUnpacked, targetDir, (name) =>
        name.toLowerCase().endsWith(".dll"),
      );
    }
    return true;
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  }
}

async function main() {
  const args = parseArgs(process.argv);

  const releaseUrl = args.tag
    ? `https://api.github.com/repos/${RELEASE_OWNER}/${RELEASE_REPO}/releases/tags/${args.tag}`
    : `https://api.github.com/repos/${RELEASE_OWNER}/${RELEASE_REPO}/releases/latest`;
  const release = await fetchJson(releaseUrl);
  console.log(`Using llama.cpp release ${release.tag_name}`);

  const wantedVariants =
    args.variants ??
    (args.here ? detectCurrentVariants() : Object.keys(VARIANT_PATTERNS));

  let downloaded = 0;
  let skipped = 0;
  for (const variant of wantedVariants) {
    try {
      const ok = await downloadVariant(release, variant);
      if (ok) downloaded += 1;
      else skipped += 1;
    } catch (err) {
      console.error(`[${variant}] failed:`, err);
      skipped += 1;
    }
  }

  console.log(`Done. ${downloaded} downloaded, ${skipped} skipped.`);
  if (downloaded === 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
