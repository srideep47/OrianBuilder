import { execFile } from "node:child_process";
import { promisify } from "node:util";
import log from "electron-log";
import type { GpuInfo, HardwareProfile } from "@/main/hardware/types";

const execFileAsync = promisify(execFile);
const logger = log.scope("vram-accounting");

/** Parse a number value out of arbitrary stdout. Returns 0 on failure. */
function safeInt(s: string | undefined | null): number {
  if (!s) return 0;
  const n = parseInt(s.trim(), 10);
  return isNaN(n) ? 0 : n;
}

async function getNvidiaUsedMb(): Promise<number> {
  try {
    const { stdout } = await execFileAsync(
      "nvidia-smi",
      ["--query-gpu=memory.used", "--format=csv,noheader,nounits"],
      { timeout: 5000 },
    );
    // multi-GPU returns one line per GPU — take the max for "primary" usage
    const used = stdout
      .split(/\r?\n/)
      .map(safeInt)
      .filter((n) => n > 0);
    return used.length === 0 ? 0 : Math.max(...used);
  } catch (err) {
    logger.debug("nvidia-smi memory.used unavailable:", err);
    return 0;
  }
}

/**
 * Parses rocm-smi output. Format varies by version, but `--showmeminfo vram`
 * typically prints:
 *   GPU[0]: VRAM Total Used Memory (B): 1234567890
 * We extract that decimal byte count and convert to MB.
 */
function parseRocmVramUsedBytes(stdout: string): number {
  const m = stdout.match(/VRAM Total Used Memory\s*\(B\):\s*(\d+)/i);
  if (!m) return 0;
  const bytes = parseInt(m[1], 10);
  return isNaN(bytes) ? 0 : Math.round(bytes / (1024 * 1024));
}

async function getRocmUsedMb(): Promise<number> {
  try {
    const { stdout } = await execFileAsync(
      "rocm-smi",
      ["--showmeminfo", "vram"],
      { timeout: 5000 },
    );
    return parseRocmVramUsedBytes(stdout);
  } catch (err) {
    logger.debug("rocm-smi memory query unavailable:", err);
    return 0;
  }
}

async function getAmdUsedMbWindows(): Promise<number> {
  // AMD on Windows: rocm-smi is rare outside ROCm SDK installs, so we use
  // the same Windows perf-counter path as Intel. typeperf gives live
  // dedicated VRAM in use across all discrete GPU adapters.
  const usedMb = await getRocmUsedMb();
  if (usedMb > 0) return usedMb;
  return getWindowsGpuDedicatedUsedMb();
}

function parseTypeperfCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === "," && !inQuotes) {
      values.push(current);
      current = "";
    } else current += ch;
  }
  values.push(current);
  return values.map((v) => v.trim());
}

/**
 * Pure helper: given typeperf CSV stdout for
 *   \GPU Adapter Memory(*)\Dedicated Usage
 * returns the total dedicated usage in MB. Returns 0 on parse failure.
 *
 * Exported for unit tests.
 */
export function parseTypeperfGpuDedicatedMb(stdout: string): number {
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('"'));
  if (lines.length < 2) return 0;
  const headers = parseTypeperfCsvLine(lines[0]);
  const values = parseTypeperfCsvLine(lines[1]);
  let totalBytes: number | null = null;
  let summedBytes = 0;
  for (let i = 1; i < headers.length; i++) {
    const header = headers[i].toLowerCase();
    if (!header.endsWith("\\dedicated usage")) continue;
    const value = Number(values[i]) || 0;
    if (header.includes("\\gpu adapter memory(_total)\\")) {
      totalBytes = value;
    } else {
      summedBytes += value;
    }
  }
  const bytes = totalBytes ?? summedBytes;
  return Math.round(bytes / (1024 * 1024));
}

async function getWindowsGpuDedicatedUsedMb(): Promise<number> {
  try {
    const { stdout } = await execFileAsync(
      "typeperf",
      ["\\GPU Adapter Memory(*)\\Dedicated Usage", "-sc", "1"],
      { timeout: 5000 },
    );
    return parseTypeperfGpuDedicatedMb(stdout);
  } catch (err) {
    logger.debug("typeperf GPU dedicated usage unavailable:", err);
    return 0;
  }
}

async function getIntelUsedMbWindows(): Promise<number> {
  // Intel's UMD doesn't expose a per-process VRAM counter, but the Windows
  // performance counter \GPU Adapter Memory(*)\Dedicated Usage reports
  // current per-adapter dedicated VRAM usage. This works for Intel Arc
  // (discrete) as well as integrated UHD/Iris where "dedicated" is
  // effectively the carved-out VRAM allocation.
  return getWindowsGpuDedicatedUsedMb();
}

async function getAppleUsedMb(): Promise<number> {
  try {
    const { stdout } = await execFileAsync("vm_stat", [], { timeout: 5000 });
    // vm_stat reports page counts; macOS default page size is 16384 on Apple
    // Silicon and 4096 on Intel. We probe explicitly when possible.
    let pageSize = 16384;
    try {
      const pagesizeOutput = await execFileAsync("pagesize", [], {
        timeout: 5000,
      });
      pageSize = safeInt(pagesizeOutput.stdout) || pageSize;
    } catch {
      /* keep default */
    }

    const matchActive = stdout.match(/Pages active:\s+(\d+)/);
    const matchWired = stdout.match(/Pages wired down:\s+(\d+)/);
    const active = matchActive ? parseInt(matchActive[1], 10) : 0;
    const wired = matchWired ? parseInt(matchWired[1], 10) : 0;
    const bytes = (active + wired) * pageSize;
    return Math.round(bytes / (1024 * 1024));
  } catch (err) {
    logger.debug("vm_stat unavailable:", err);
    return 0;
  }
}

/**
 * Returns the current VRAM usage in MB for the given vendor/OS combination.
 * Returns 0 when no reliable counter is available — callers must handle this
 * as "unknown" rather than "actually zero".
 */
export async function getCurrentVramUsageMb(
  vendor: GpuInfo["vendor"],
  os: HardwareProfile["os"],
): Promise<number> {
  if (vendor === "nvidia") return getNvidiaUsedMb();
  if (vendor === "amd" && os === "windows") return getAmdUsedMbWindows();
  if (vendor === "amd") return getRocmUsedMb();
  if (vendor === "intel" && os === "windows") return getIntelUsedMbWindows();
  if (vendor === "apple" && os === "macos") return getAppleUsedMb();
  return 0;
}

/**
 * Returns the approximate available VRAM in MB given a hardware profile.
 * On unified-memory systems (Apple Silicon) this returns totalRamMb - usedMb
 * since there's no separate VRAM pool.
 */
export async function getAvailableVramMb(
  profile: HardwareProfile,
): Promise<number> {
  if (!profile.primaryGpu) return 0;
  const used = await getCurrentVramUsageMb(
    profile.primaryGpu.vendor,
    profile.os,
  );
  if (profile.primaryGpu.vendor === "apple") {
    // Unified memory pool — approximate "free RAM" as available VRAM.
    return Math.max(0, profile.totalRamMb - used);
  }
  return Math.max(0, profile.primaryGpu.vramMb - used);
}

// Re-exported for tests
export { parseRocmVramUsedBytes };
