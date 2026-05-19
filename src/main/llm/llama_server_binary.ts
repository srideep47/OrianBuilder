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
import { app } from "electron";

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
