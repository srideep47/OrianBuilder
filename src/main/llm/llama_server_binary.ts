/**
 * Binary discovery for the llama-server child process.
 *
 * We ship prebuilt llama.cpp binaries under `resources/llama-server/<variant>/`
 * via electron-builder. The variant directory is chosen at runtime based on
 * the hardware profile (CUDA on NVIDIA, Vulkan on AMD/Intel on Windows, Metal
 * on Apple Silicon, CPU as the safe fallback).
 *
 * Layout:
 *   resources/llama-server/win-cuda/llama-server.exe
 *   resources/llama-server/win-vulkan/llama-server.exe
 *   resources/llama-server/win-cpu/llama-server.exe
 *   resources/llama-server/linux-cuda/llama-server
 *   resources/llama-server/linux-vulkan/llama-server
 *   resources/llama-server/linux-cpu/llama-server
 *   resources/llama-server/mac-metal/llama-server
 *
 * Override with the LLAMA_SERVER_PATH env var (absolute path to the binary)
 * for development or custom builds.
 */

import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import log from "electron-log";
import { app } from "electron";

const execFileAsync = promisify(execFile);
const logger = log.scope("llama-binary");

import type { HardwareProfile, LlmBackend } from "@/main/hardware/types";

export type LlamaServerVariant =
  | "win-cuda"
  | "win-vulkan"
  | "win-cpu"
  | "linux-cuda"
  | "linux-vulkan"
  | "linux-cpu"
  | "mac-metal";

export function pickLlamaServerVariant(
  profile: Pick<HardwareProfile, "os" | "bestLlmBackend">,
): LlamaServerVariant {
  const backend: LlmBackend = profile.bestLlmBackend;
  switch (profile.os) {
    case "windows":
      if (backend === "cuda") return "win-cuda";
      if (backend === "vulkan" || backend === "rocm") return "win-vulkan";
      return "win-cpu";
    case "linux":
      if (backend === "cuda") return "linux-cuda";
      if (backend === "vulkan" || backend === "rocm") return "linux-vulkan";
      return "linux-cpu";
    case "macos":
      return "mac-metal";
  }
}

function getBinaryName(): string {
  return process.platform === "win32" ? "llama-server.exe" : "llama-server";
}

/**
 * Candidate directories to search, in order. The first one that holds the
 * variant-specific binary wins.
 *
 * Packaged builds: Electron Forge copies `resources/llama-server/` into
 *   `<resourcesPath>/llama-server/` (extraResource keeps the trailing path
 *   segment, not the leading `resources/`).
 *
 * Dev builds: walk up from the bundle (.vite/build/main-*.js → project root)
 *   and from `app.getAppPath()` to handle both Forge-dev and direct-vite runs.
 */
function candidateRoots(): string[] {
  // User-data dir is always checked first — holds runtime-downloaded binaries.
  const userDataRoot = path.join(app.getPath("userData"), "llama-server");

  if (app.isPackaged) {
    return [userDataRoot, path.join(process.resourcesPath, "llama-server")];
  }
  // In dev with electron-forge + vite, __dirname is <projectRoot>/.vite/build,
  // so two levels up is the project root.
  const fromDirname = path.resolve(__dirname, "..", "..");
  const fromAppPath = app.getAppPath();
  const fromCwd = process.cwd();
  const roots = new Set<string>([fromDirname, fromAppPath, fromCwd]);
  const devRoots = Array.from(roots).map((root) =>
    path.join(root, "resources", "llama-server"),
  );
  return [userDataRoot, ...devRoots];
}

export interface LlamaServerBinaryLocation {
  path: string;
  variant: LlamaServerVariant | "override";
  source: "env-override" | "bundled";
}

/**
 * Resolve the absolute path of the llama-server binary to invoke.
 *
 * Throws if no binary is found — callers should surface this as a user-facing
 * error pointing them at the binary acquisition docs.
 */
export function resolveLlamaServerBinaryByVariant(
  variant: LlamaServerVariant,
): LlamaServerBinaryLocation {
  const binaryName = getBinaryName();
  const attempted: string[] = [];
  for (const root of candidateRoots()) {
    const candidate = path.join(root, variant, binaryName);
    attempted.push(candidate);
    if (fs.existsSync(candidate)) {
      return { path: candidate, variant, source: "bundled" };
    }
  }
  throw new Error(
    `llama-server binary not found for variant "${variant}". Tried:\n  ` +
      attempted.join("\n  ") +
      `\nSet the LLAMA_SERVER_PATH env var to an absolute path, or run ` +
      `\`scripts/download-llama-server\` to fetch binaries into resources/llama-server/.`,
  );
}

export function resolveLlamaServerBinary(
  profile: Pick<HardwareProfile, "os" | "bestLlmBackend">,
): LlamaServerBinaryLocation {
  const envOverride = process.env.LLAMA_SERVER_PATH;
  if (envOverride && fs.existsSync(envOverride)) {
    return {
      path: envOverride,
      variant: "override",
      source: "env-override",
    };
  }

  const variant = pickLlamaServerVariant(profile);
  const binaryName = getBinaryName();
  const attempted: string[] = [];
  for (const root of candidateRoots()) {
    const candidate = path.join(root, variant, binaryName);
    attempted.push(candidate);
    if (fs.existsSync(candidate)) {
      return { path: candidate, variant, source: "bundled" };
    }
  }

  throw new Error(
    `llama-server binary not found for variant "${variant}". Tried:\n  ` +
      attempted.join("\n  ") +
      `\nSet the LLAMA_SERVER_PATH env var to an absolute path, or run ` +
      `\`scripts/download-llama-server\` to fetch binaries into resources/llama-server/.`,
  );
}

/**
 * Runs `llama-server --list-devices` and returns the exact device identifier
 * (e.g. "Vulkan0", "Vulkan1") for the GPU whose name best matches `gpuModel`.
 *
 * llama-server --list-devices output looks like:
 *   Vulkan0 (NVIDIA GeForce RTX 4080 Super, VRAM: 16376 MiB, UMA: 0)
 *   Vulkan1 (AMD Radeon(TM) 890M, VRAM: 8192 MiB, UMA: 1)
 *
 * The --device flag only accepts these identifiers — vendor names like "AMD"
 * are rejected. Returns undefined when no match is found or the binary does
 * not support --list-devices.
 */
export async function findVulkanDeviceName(
  binaryPath: string,
  gpuModel: string,
): Promise<string | undefined> {
  let output = "";
  try {
    // --list-devices prints the list then exits; exit code varies by version
    // so we capture stdout+stderr regardless of success/failure.
    const result = await execFileAsync(binaryPath, ["--list-devices"], {
      timeout: 8000,
    });
    output = `${result.stdout}\n${result.stderr}`;
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string };
    output = `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
  }

  if (!output.trim()) return undefined;

  // Normalize: strip trademark symbols, collapse whitespace, lower-case.
  const norm = (s: string) =>
    s
      .replace(/[™®©()®™]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();

  const normalizedModel = norm(gpuModel);

  // Extract the significant tokens from the GPU model name (skip short/generic words)
  const SKIP = new Set(["amd", "nvidia", "intel", "arc", "the", "and"]);
  const keywords = normalizedModel
    .split(" ")
    .filter((w) => w.length >= 3 && !SKIP.has(w));

  logger.info(
    `[device-match] Looking for "${gpuModel}" in --list-devices output. Keywords: [${keywords.join(", ")}]`,
  );

  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const normalizedLine = norm(line);

    // Score: count how many keywords appear in this line.
    const matchCount = keywords.filter((k) =>
      normalizedLine.includes(k),
    ).length;
    const threshold = Math.max(1, Math.ceil(keywords.length * 0.5));
    if (matchCount < threshold) continue;

    // Format A: "  Vulkan0: AMD Radeon(TM) Graphics (33608 MiB, 31927 MiB free)"
    //           "  Vulkan0 (AMD Radeon(TM) 890M, VRAM: ...)"
    //           "  CUDA0 (NVIDIA GeForce RTX 4080 Super, ...)"
    // The colon-separated form is the live format observed from the bundled binary.
    const matchA = line.trim().match(/^([A-Za-z]+\d+)\s*[:\s(,]/);
    if (matchA) {
      logger.info(
        `[device-match] Matched "${line.trim()}" → device "${matchA[1]}"`,
      );
      return matchA[1];
    }

    // Format B: "ggml_vulkan: 0 = AMD Radeon(TM) 890M | ..."
    const matchB = line.match(/:\s*(\d+)\s*=/);
    if (matchB) {
      const deviceId = `Vulkan${matchB[1]}`;
      logger.info(
        `[device-match] Matched "${line.trim()}" → device "${deviceId}"`,
      );
      return deviceId;
    }
  }

  logger.warn(
    `[device-match] No Vulkan device found matching "${gpuModel}" in --list-devices output`,
  );
  return undefined;
}
