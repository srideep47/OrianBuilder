import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import log from "electron-log";
import type {
  GpuInfo,
  GpuVendor,
  HardwareProfile,
  InferenceBackend,
  LlmBackend,
  MediaBackend,
} from "./types";

const execFileAsync = promisify(execFile);
const logger = log.scope("hardware-detect");

// ─── Pure helpers (exported for testing) ─────────────────────────────────────

export function detectGpuVendor(name: string): GpuVendor {
  const n = name.toLowerCase();
  if (
    n.includes("nvidia") ||
    n.includes("geforce") ||
    n.includes("quadro") ||
    n.includes("tesla") ||
    n.includes("rtx") ||
    n.includes("gtx")
  )
    return "nvidia";
  if (
    n.includes("amd") ||
    n.includes("radeon") ||
    n.includes("firepro") ||
    n.includes("instinct")
  )
    return "amd";
  if (
    n.includes("intel") ||
    n.includes("arc ") ||
    n.includes("iris") ||
    n.includes("hd graphics") ||
    n.includes("uhd graphics")
  )
    return "intel";
  if (n.includes("apple")) return "apple";
  return "unknown";
}

export function detectIsIntegrated(name: string, vendor: GpuVendor): boolean {
  const n = name.toLowerCase();
  if (vendor === "apple") return true;
  if (vendor === "intel") return !n.includes("arc ");
  if (vendor === "amd") {
    return (
      n.includes("radeon graphics") ||
      (n.includes("vega") && !n.includes("rx vega"))
    );
  }
  return false;
}

/**
 * Parses the CSV output of:
 *   wmic path win32_videocontroller get name,adapterram /format:csv
 *
 * Format (wmic /format:csv emits a leading blank line, then a header row,
 * then one CSV row per controller):
 *   Node,AdapterRAM,Name
 *   HOST,4294967296,NVIDIA GeForce RTX 4090
 *   HOST,0,Microsoft Basic Display Adapter
 */
export function parseWmicGpuOutput(csv: string): GpuInfo[] {
  const lines = csv
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return [];

  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const adapterRamIdx = header.indexOf("adapterram");
  const nameIdx = header.indexOf("name");
  if (nameIdx === -1) return [];

  const gpus: GpuInfo[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (cols.length <= nameIdx) continue;
    const name = cols[nameIdx]?.trim();
    if (!name) continue;
    // Skip Microsoft Basic Display / null adapters
    if (/microsoft basic display|basic render driver/i.test(name)) continue;
    const adapterRamBytes =
      adapterRamIdx >= 0 ? parseInt(cols[adapterRamIdx]?.trim() ?? "0", 10) : 0;
    const vramMb = isNaN(adapterRamBytes)
      ? 0
      : Math.round(adapterRamBytes / (1024 * 1024));
    const vendor = detectGpuVendor(name);
    gpus.push({
      vendor,
      model: name,
      vramMb,
      isIntegrated: detectIsIntegrated(name, vendor),
    });
  }
  return gpus;
}

/**
 * Parses the output of:
 *   nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
 * One line per GPU like:  "NVIDIA GeForce RTX 4090, 24564 MiB"
 */
export function parseNvidiaSmiOutput(
  csv: string,
): Array<Pick<GpuInfo, "model" | "vramMb">> {
  return csv
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(",").map((p) => p.trim());
      const model = parts[0] ?? "";
      const memStr = parts[1] ?? "";
      const memMb = parseInt(memStr, 10);
      return { model, vramMb: isNaN(memMb) ? 0 : memMb };
    })
    .filter((g) => g.model.length > 0);
}

export function selectPrimaryGpu(gpus: GpuInfo[]): GpuInfo | null {
  if (gpus.length === 0) return null;
  const discrete = gpus.filter((g) => !g.isIntegrated);
  const pool = discrete.length > 0 ? discrete : gpus;
  return pool.reduce((best, g) => (g.vramMb > best.vramMb ? g : best), pool[0]);
}

export function selectBestLlmBackend(
  profile: Pick<HardwareProfile, "primaryGpu" | "availableBackends" | "arch">,
): LlmBackend {
  const vendor = profile.primaryGpu?.vendor;
  const has = (b: InferenceBackend) => profile.availableBackends.includes(b);
  if (vendor === "nvidia" && has("cuda")) return "cuda";
  if (vendor === "apple" && profile.arch === "arm64" && has("metal"))
    return "metal";
  if (vendor === "amd" && has("rocm")) return "rocm";
  if (has("vulkan") && profile.primaryGpu && !profile.primaryGpu.isIntegrated)
    return "vulkan";
  if (has("cuda")) return "cuda";
  if (has("metal")) return "metal";
  return "cpu";
}

export function selectBestMediaBackend(
  profile: Pick<
    HardwareProfile,
    "primaryGpu" | "availableBackends" | "arch" | "os"
  >,
): MediaBackend {
  const vendor = profile.primaryGpu?.vendor;
  const has = (b: InferenceBackend) => profile.availableBackends.includes(b);
  if (vendor === "nvidia" && has("cuda")) return "cuda";
  if (vendor === "apple" && profile.arch === "arm64" && has("metal"))
    return "metal";
  if (vendor === "amd" && profile.os === "windows" && has("directml"))
    return "directml";
  if (vendor === "amd" && profile.os === "linux" && has("rocm")) return "rocm";
  if (vendor === "intel" && has("openvino")) return "openvino";
  if (has("cuda")) return "cuda";
  if (has("metal")) return "metal";
  if (has("directml")) return "directml";
  if (has("openvino")) return "openvino";
  return "cpu";
}

// ─── Windows detection ────────────────────────────────────────────────────────

async function detectWindowsGpusWmic(): Promise<GpuInfo[]> {
  try {
    const { stdout } = await execFileAsync(
      "wmic",
      [
        "path",
        "win32_videocontroller",
        "get",
        "name,adapterram",
        "/format:csv",
      ],
      { timeout: 15000 },
    );
    return parseWmicGpuOutput(stdout);
  } catch (err) {
    logger.warn("wmic GPU query failed:", err);
    return [];
  }
}

async function detectWindowsGpusPowerShell(): Promise<GpuInfo[]> {
  try {
    const script =
      "(Get-CimInstance -ClassName Win32_VideoController | Select-Object Name,AdapterRAM) | ConvertTo-Json -Compress";
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NonInteractive", "-NoProfile", "-Command", script],
      { timeout: 15000 },
    );
    const raw: unknown = JSON.parse(stdout.trim());
    const items: Array<{ Name?: string; AdapterRAM?: number }> = Array.isArray(
      raw,
    )
      ? (raw as Array<{ Name?: string; AdapterRAM?: number }>)
      : [raw as { Name?: string; AdapterRAM?: number }];

    return items
      .filter((item) => !!item.Name)
      .filter(
        (item) =>
          !/microsoft basic display|basic render driver/i.test(item.Name ?? ""),
      )
      .map((item): GpuInfo => {
        const name = item.Name!;
        const vramMb = Math.round((item.AdapterRAM ?? 0) / (1024 * 1024));
        const vendor = detectGpuVendor(name);
        return {
          vendor,
          model: name,
          vramMb,
          isIntegrated: detectIsIntegrated(name, vendor),
        };
      });
  } catch (err) {
    logger.warn("PowerShell GPU detection failed:", err);
    return [];
  }
}

async function overrideNvidiaVram(gpus: GpuInfo[]): Promise<void> {
  if (!gpus.some((g) => g.vendor === "nvidia")) return;
  try {
    const { stdout } = await execFileAsync(
      "nvidia-smi",
      ["--query-gpu=name,memory.total", "--format=csv,noheader"],
      { timeout: 10000 },
    );
    const parsed = parseNvidiaSmiOutput(stdout);
    const nvidiaGpus = gpus.filter((g) => g.vendor === "nvidia");
    for (let i = 0; i < parsed.length && i < nvidiaGpus.length; i++) {
      if (parsed[i].vramMb > 0) nvidiaGpus[i].vramMb = parsed[i].vramMb;
      if (parsed[i].model) nvidiaGpus[i].model = parsed[i].model;
    }
  } catch {
    /* nvidia-smi not on PATH — keep WMI values */
  }
}

async function detectWindowsGpus(): Promise<GpuInfo[]> {
  // wmic is the spec primary; PowerShell CIM is a fallback for Win 11 22H2+ where wmic was removed.
  let gpus = await detectWindowsGpusWmic();
  if (gpus.length === 0) gpus = await detectWindowsGpusPowerShell();
  await overrideNvidiaVram(gpus);
  return gpus;
}

async function checkCmdAvailable(
  cmd: string,
  args: string[],
): Promise<boolean> {
  try {
    await execFileAsync(cmd, args, { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function detectWindowsBackends(
  gpus: GpuInfo[],
): Promise<InferenceBackend[]> {
  const [hasCuda, hasVulkan, hasRocm, hasOpenVINO] = await Promise.all([
    checkCmdAvailable("nvidia-smi", ["-L"]),
    checkCmdAvailable("vulkaninfo", ["--summary"]),
    checkCmdAvailable("rocm-smi", ["--version"]),
    checkCmdAvailable("mo", ["--version"]),
  ]);

  const backends = new Set<InferenceBackend>(["cpu"]);
  if (hasCuda) backends.add("cuda");
  if (hasVulkan) backends.add("vulkan");
  if (hasRocm) backends.add("rocm");
  if (hasOpenVINO) backends.add("openvino");

  const releaseParts = os.release().split(".");
  const build = parseInt(releaseParts[2] ?? "0", 10);
  if (!isNaN(build) && build >= 18362) backends.add("directml");

  if (!hasOpenVINO && gpus.some((g) => g.vendor === "intel")) {
    const sysRoot = process.env["SystemRoot"] ?? "C:\\Windows";
    try {
      await fs.promises.access(path.join(sysRoot, "System32", "igdext64.dll"));
      backends.add("openvino");
    } catch {
      /* DLL not present */
    }
  }

  return Array.from(backends);
}

// ─── macOS detection ──────────────────────────────────────────────────────────

async function detectMacOsGpus(): Promise<GpuInfo[]> {
  try {
    const { stdout } = await execFileAsync(
      "system_profiler",
      ["SPDisplaysDataType", "-json"],
      { timeout: 20000 },
    );
    const data = JSON.parse(stdout) as {
      SPDisplaysDataType?: Array<Record<string, string>>;
    };
    const items = data.SPDisplaysDataType ?? [];

    return items.map((item): GpuInfo => {
      const name = item["sppci_model"] ?? item["_name"] ?? "Unknown GPU";
      const vendor = detectGpuVendor(name);
      const isIntegrated = detectIsIntegrated(name, vendor);

      let vramMb = 0;
      const vramStr =
        item["spdisplays_vram"] ?? item["spdisplays_vram_shared"] ?? "";
      const m = vramStr.match(/(\d+)\s*(GB|MB|GiB|MiB)/i);
      if (m) {
        vramMb = parseInt(m[1], 10);
        if (/^(gb|gib)$/i.test(m[2])) vramMb *= 1024;
      }

      return { vendor, model: name, vramMb, isIntegrated };
    });
  } catch (err) {
    logger.warn("system_profiler GPU query failed:", err);
    return [];
  }
}

function detectMacOsBackends(): InferenceBackend[] {
  const backends: InferenceBackend[] = ["cpu"];
  if (process.arch === "arm64") backends.push("metal");
  return backends;
}

// ─── CPU detection (all platforms) ───────────────────────────────────────────

function detectCpuInfo(): HardwareProfile["cpu"] {
  const cpus = os.cpus();
  const model = cpus[0]?.model ?? "Unknown CPU";
  const logicalCores = cpus.length;
  const cores = Math.max(1, Math.ceil(logicalCores / 2));

  const m = model.toLowerCase();
  let vendor: HardwareProfile["cpu"]["vendor"] = "unknown";
  if (m.includes("intel")) vendor = "intel";
  else if (m.includes("amd")) vendor = "amd";
  else if (m.includes("apple")) vendor = "apple";

  return { vendor, model, cores, logicalCores };
}

// ─── Main detection entry point ───────────────────────────────────────────────

let cachedProfile: HardwareProfile | null = null;

export async function detectHardwareProfile(): Promise<HardwareProfile> {
  const platform = process.platform;
  const arch: HardwareProfile["arch"] =
    process.arch === "arm64" ? "arm64" : "x64";
  const osName: HardwareProfile["os"] =
    platform === "win32"
      ? "windows"
      : platform === "darwin"
        ? "macos"
        : "linux";

  const cpu = detectCpuInfo();
  const totalRamMb = Math.round(os.totalmem() / (1024 * 1024));

  let gpus: GpuInfo[] = [];
  let availableBackends: InferenceBackend[] = ["cpu"];

  if (platform === "win32") {
    gpus = await detectWindowsGpus();
    availableBackends = await detectWindowsBackends(gpus);
  } else if (platform === "darwin") {
    [gpus, availableBackends] = await Promise.all([
      detectMacOsGpus(),
      Promise.resolve(detectMacOsBackends()),
    ]);
  }

  const primaryGpu = selectPrimaryGpu(gpus);
  const partial = { primaryGpu, availableBackends, arch, os: osName };
  const bestLlmBackend = selectBestLlmBackend(partial);
  const bestMediaBackend = selectBestMediaBackend(partial);

  const profile: HardwareProfile = {
    os: osName,
    arch,
    cpu,
    gpus,
    primaryGpu,
    totalRamMb,
    availableBackends,
    bestLlmBackend,
    bestMediaBackend,
  };

  cachedProfile = profile;
  logger.info(
    `Hardware: ${osName}/${arch}, GPU: ${primaryGpu?.model ?? "none"}, LLM: ${bestLlmBackend}, Media: ${bestMediaBackend}`,
  );
  return profile;
}

export async function getCachedHardwareProfile(): Promise<HardwareProfile> {
  return cachedProfile ?? detectHardwareProfile();
}

/** Spec-named aliases */
export const detectHardware = detectHardwareProfile;
export const refreshProfile = detectHardwareProfile;
export const getCachedProfile = getCachedHardwareProfile;
