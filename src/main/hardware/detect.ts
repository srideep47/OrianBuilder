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
    // "AMD Radeon(TM) Graphics" — the trademark symbol sits between "radeon" and
    // "graphics", so a plain substring check fails. Use a regex that allows any
    // parenthesised token (e.g. "(TM)", "(R)") in between.
    const isRadeonGraphics = /radeon\s*(?:\([^)]*\)\s*)?graphics/i.test(name);
    // RDNA-era APU graphics: "890M", "780M", "760M", "740M" — 3-4 digit number ending in M
    // without a preceding "RX" which marks discrete cards (RX 6800, RX 7900 XTX, etc.)
    const isRdnaIgpu = /\b\d{3,4}m\b/.test(n) && !/ rx /.test(n);
    return (
      isRadeonGraphics ||
      (n.includes("vega") && !n.includes("rx vega")) ||
      isRdnaIgpu
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
    // WMI AdapterRAM is a 32-bit field — any GPU with >4 GB VRAM overflows
    // and returns exactly 4294967296 (0x100000000). Set to 0 so that
    // overrideNvidiaVram() can replace it with the real value from nvidia-smi,
    // and if nvidia-smi is absent the Python backend falls back to torch.
    const vramMb =
      isNaN(adapterRamBytes) || adapterRamBytes >= 4294967296
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
  // Allow Vulkan for AMD GPUs (including iGPUs like 890M — capable RDNA silicon).
  // Only block Intel integrated GPUs from Vulkan (HD/UHD are too weak for LLM inference).
  if (has("vulkan") && profile.primaryGpu) {
    const isIntelIgpu =
      profile.primaryGpu.vendor === "intel" && profile.primaryGpu.isIntegrated;
    if (!isIntelIgpu) return "vulkan";
  }
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
        // Same 32-bit overflow as wmic: AdapterRAM >= 4 GB means the field
        // saturated; use 0 so nvidia-smi/torch can supply the real value.
        const adapterRam = item.AdapterRAM ?? 0;
        const vramMb =
          adapterRam >= 4294967296 ? 0 : Math.round(adapterRam / (1024 * 1024));
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

  // nvidia-smi ships with the CUDA toolkit, not the driver — so plenty of
  // NVIDIA users don't have it on PATH despite having a working CUDA driver.
  // Detect the driver directly by probing nvcuda.dll, which is installed by
  // every modern GeForce driver. PyTorch wheels (cu128) bundle their own CUDA
  // runtime, so the driver alone is enough for GPU inference.
  if (!hasCuda && gpus.some((g) => g.vendor === "nvidia")) {
    const sysRoot = process.env["SystemRoot"] ?? "C:\\Windows";
    try {
      await fs.promises.access(path.join(sysRoot, "System32", "nvcuda.dll"));
      backends.add("cuda");
    } catch {
      /* nvcuda.dll not present — no NVIDIA driver, leave cuda out */
    }
  }

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

// ─── Linux detection ──────────────────────────────────────────────────────────

/**
 * Parses the output of:
 *   lspci -vmm -nn
 * which produces one "record" per device separated by blank lines:
 *   Slot:    01:00.0
 *   Class:   VGA compatible controller [0300]
 *   Vendor:  NVIDIA Corporation [10de]
 *   Device:  AD102 [GeForce RTX 4090] [2684]
 *
 * Returns GPU records only (Class is VGA/3D/Display).
 * Pure function — exported for tests.
 */
export function parseLspciVmm(stdout: string): GpuInfo[] {
  const records = stdout.split(/\r?\n\r?\n/);
  const gpus: GpuInfo[] = [];
  for (const record of records) {
    const fields: Record<string, string> = {};
    for (const line of record.split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z]+):\s*(.+)$/);
      if (m) fields[m[1]] = m[2].trim();
    }
    const klass = fields["Class"] ?? "";
    if (
      !/VGA compatible controller|3D controller|Display controller/i.test(klass)
    ) {
      continue;
    }
    const vendorField = fields["Vendor"] ?? "";
    const deviceField = fields["Device"] ?? "";
    // Prefer "Vendor Device" so we get e.g. "NVIDIA Corporation AD102 [GeForce RTX 4090]"
    const name = [vendorField, deviceField]
      .filter(Boolean)
      .join(" ")
      .replace(/\s+\[[0-9a-f]{4}\]/g, "")
      .trim();
    if (!name) continue;
    const vendor = detectGpuVendor(name);
    gpus.push({
      vendor,
      model: name,
      vramMb: 0, // overridden below by nvidia-smi/rocm-smi when available
      isIntegrated: detectIsIntegrated(name, vendor),
    });
  }
  return gpus;
}

async function detectLinuxGpus(): Promise<GpuInfo[]> {
  let gpus: GpuInfo[] = [];
  try {
    const { stdout } = await execFileAsync("lspci", ["-vmm", "-nn"], {
      timeout: 10000,
    });
    gpus = parseLspciVmm(stdout);
  } catch (err) {
    logger.warn("lspci GPU enumeration failed:", err);
  }

  // Override Nvidia VRAM via nvidia-smi (also corrects model name)
  await overrideNvidiaVram(gpus);

  // For AMD GPUs, try to populate VRAM from /sys/class/drm or rocm-smi.
  if (gpus.some((g) => g.vendor === "amd")) {
    try {
      const { stdout } = await execFileAsync(
        "rocm-smi",
        ["--showmeminfo", "vram", "--csv"],
        { timeout: 5000 },
      );
      // Format: device,VRAM Total Memory (B),VRAM Total Used Memory (B)
      const lines = stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.toLowerCase().startsWith("device"));
      const amdGpus = gpus.filter((g) => g.vendor === "amd");
      for (let i = 0; i < lines.length && i < amdGpus.length; i++) {
        const parts = lines[i].split(",");
        const totalBytes = parseInt(parts[1] ?? "0", 10);
        if (!isNaN(totalBytes) && totalBytes > 0) {
          amdGpus[i].vramMb = Math.round(totalBytes / (1024 * 1024));
        }
      }
    } catch {
      /* rocm-smi not installed — leave AMD VRAM at 0 */
    }
  }

  return gpus;
}

async function detectLinuxBackends(
  gpus: GpuInfo[] = [],
): Promise<InferenceBackend[]> {
  const [hasCuda, hasRocm, hasVulkan, hasOpenVINO] = await Promise.all([
    checkCmdAvailable("nvidia-smi", ["-L"]),
    checkCmdAvailable("rocm-smi", ["--version"]),
    checkCmdAvailable("vulkaninfo", ["--summary"]),
    checkCmdAvailable("mo", ["--version"]),
  ]);
  const backends = new Set<InferenceBackend>(["cpu"]);
  if (hasCuda) backends.add("cuda");
  if (hasRocm) backends.add("rocm");
  if (hasVulkan) backends.add("vulkan");
  if (hasOpenVINO) backends.add("openvino");

  // Same nvidia-smi caveat as Windows: nvidia-smi can be missing even when the
  // NVIDIA driver is installed. Probe libcuda.so.1 which the driver ships.
  if (!hasCuda && gpus.some((g) => g.vendor === "nvidia")) {
    for (const candidate of [
      "/usr/lib/x86_64-linux-gnu/libcuda.so.1",
      "/usr/lib64/libcuda.so.1",
      "/usr/lib/libcuda.so.1",
    ]) {
      try {
        await fs.promises.access(candidate);
        backends.add("cuda");
        break;
      } catch {
        /* try next candidate */
      }
    }
  }

  // DirectML and Metal are not available on Linux.
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
  } else if (platform === "linux") {
    gpus = await detectLinuxGpus();
    availableBackends = await detectLinuxBackends(gpus);
  }

  // AMD iGPUs use UMA (shared system RAM). WMI AdapterRAM returns 0 or a tiny
  // fixed value — the real accessible VRAM is half the system RAM (matching what
  // the Vulkan driver reports). We cap at 32 GB so the layer calculator stays sane.
  for (const gpu of gpus) {
    if (gpu.vendor === "amd" && gpu.isIntegrated && gpu.vramMb === 0) {
      gpu.vramMb = Math.min(Math.round(totalRamMb / 2), 32768);
    }
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
