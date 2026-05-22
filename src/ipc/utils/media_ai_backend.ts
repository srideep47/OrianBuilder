import { app } from "electron";
import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import path from "path";
import log from "electron-log";
import type { MediaAiModelId, MediaAiStatus } from "../types/media_ai";
import type { HardwareProfile } from "@/main/hardware/types";

/** Cached hardware profile pointer. Set by initMediaAiHardware(profile). */
let cachedHardwareProfile: HardwareProfile | null = null;

/** Inject the resolved hardware profile so the Python subprocess can read
 *  ORIANBUILDER_HARDWARE_BACKEND / ORIANBUILDER_GPU_VRAM_MB. Call this once at
 *  startup after the hardware module has computed the profile. */
export function initMediaAiHardware(profile: HardwareProfile | null): void {
  cachedHardwareProfile = profile;
}

const logger = log.scope("media_ai_backend");

const SERVER_URL = "http://127.0.0.1:8000";
const MODEL_LABELS: Record<MediaAiModelId, string> = {
  text: "Phi-3 text model",
  image: "Stable Diffusion image model",
  audio: "SpeechT5 audio models",
  video: "Text-to-video model",
  "image-sd-turbo": "SD Turbo (image)",
  "image-z-image-turbo": "Z Image Turbo (image)",
  whisper: "Whisper Base (transcription)",
};

let pythonServer: ChildProcess | null = null;
let lastLog: string | undefined;

export function resolveMediaAiBackendPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "mediaai-backend", "backend");
  }
  return path.join(app.getAppPath(), "mediaai-backend", "backend");
}

function getMediaAiDataPaths() {
  const root = path.join(app.getPath("userData"), "mediaai");
  return {
    root,
    modelsPath: path.join(root, "models"),
    outputsPath: path.join(root, "outputs"),
    hfCachePath: path.join(root, "models", "huggingface"),
  };
}

function getVenvPath() {
  return path.join(getMediaAiDataPaths().root, ".venv");
}

function getGpuMarkerPath() {
  return path.join(getMediaAiDataPaths().root, ".gpu-backend.json");
}

function readGpuMarker(): string | undefined {
  try {
    const raw = fs.readFileSync(getGpuMarkerPath(), "utf8");
    const parsed = JSON.parse(raw) as { backend?: string };
    return parsed.backend ?? undefined;
  } catch {
    return undefined;
  }
}

// Probe the venv's site-packages to detect GPU-capable packages already installed.
// Handles existing installs that pre-date the marker file.
function detectGpuBackendFromVenv(): string | undefined {
  const venvPath = getVenvPath();
  // Windows: Lib/site-packages; Unix: lib/python3.x/site-packages
  let sitePackages = path.join(venvPath, "Lib", "site-packages");
  if (!fs.existsSync(sitePackages)) {
    const libDir = path.join(venvPath, "lib");
    if (fs.existsSync(libDir)) {
      const pyDir = fs.readdirSync(libDir).find((d) => d.startsWith("python"));
      if (pyDir) sitePackages = path.join(libDir, pyDir, "site-packages");
    }
  }
  if (!fs.existsSync(sitePackages)) return undefined;
  try {
    const entries = fs.readdirSync(sitePackages);
    // CUDA torch dist-info contains "+cu" in version string (e.g. torch-2.7.0+cu128.dist-info)
    if (entries.some((e) => e.startsWith("torch-") && e.includes("+cu"))) {
      return "cuda";
    }
    // DirectML: onnxruntime-directml installs an onnxruntime_directml package
    if (entries.some((e) => e.startsWith("onnxruntime_directml"))) {
      return "directml";
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function writeGpuMarker(backend: string): void {
  try {
    fs.writeFileSync(
      getGpuMarkerPath(),
      JSON.stringify({ backend, installedAt: new Date().toISOString() }),
    );
  } catch {
    // non-fatal
  }
}

function deleteGpuMarker(): void {
  try {
    if (fs.existsSync(getGpuMarkerPath())) fs.unlinkSync(getGpuMarkerPath());
  } catch {
    // non-fatal
  }
}

function getVenvPythonPath() {
  const venvPath = getVenvPath();
  return process.platform === "win32"
    ? path.join(venvPath, "Scripts", "python.exe")
    : path.join(venvPath, "bin", "python");
}

function getPythonCommand() {
  return fs.existsSync(getVenvPythonPath()) ? getVenvPythonPath() : "python";
}

function getBackendEnvironment(): NodeJS.ProcessEnv {
  const backendPath = resolveMediaAiBackendPath();
  const { modelsPath, outputsPath, hfCachePath } = getMediaAiDataPaths();
  return {
    ...process.env,
    PYTHONPATH: backendPath,
    OMNIGEN_MODELS_DIR: modelsPath,
    OMNIGEN_OUTPUTS_DIR: outputsPath,
    OMNIGEN_HF_CACHE_DIR: hfCachePath,
    HF_HOME: hfCachePath,
    ORIANBUILDER_HARDWARE_BACKEND:
      cachedHardwareProfile?.bestMediaBackend ?? "cpu",
    ORIANBUILDER_GPU_VRAM_MB: String(
      cachedHardwareProfile?.primaryGpu?.vramMb ?? 0,
    ),
    ORIANBUILDER_GPU_VENDOR:
      cachedHardwareProfile?.primaryGpu?.vendor ?? "unknown",
    // Full-bandwidth HuggingFace downloads via both Xet and hf_transfer.
    HF_XET_HIGH_PERFORMANCE: "1",
    HF_HUB_ENABLE_HF_TRANSFER: "1",
  };
}

function trimOutput(output: string) {
  const maxLength = 12000;
  return output.length > maxLength
    ? `${output.slice(0, maxLength)}\n... output truncated ...`
    : output;
}

const ACE_STEP_GIT_URL = "git+https://github.com/ace-step/ACE-Step-1.5.git";

function getAceStepRuntimePackages(_effectiveBackend: string): string[] {
  return [
    "diffusers>=0.37.0",
    "transformers>=4.51.0,<4.58.0",
    "accelerate>=1.12.0",
    "loguru>=0.7.3",
    "einops>=0.8.1",
    "vector-quantize-pytorch>=1.27.15",
    "toml>=0.10.2",
    "diskcache>=5.6.3",
    "typer-slim>=0.21.1",
    "pytorch-wavelets>=1.3.0",
    "PyWavelets>=1.9.0",
    "peft>=0.18.0",
    "lycoris-lora",
    "lightning>=2.0.0",
    "setuptools<72",
  ];
}

// numba requires LLVM, torchcodec requires FFMPEG, torchao has Windows gaps —
// install separately so a failure here doesn't block the whole setup.
function getAceStepOptionalPackages(effectiveBackend: string): string[] {
  if (["directml", "mps", "metal"].includes(effectiveBackend)) return [];
  return ["torchao>=0.16.0,<0.17.0", "numba>=0.63.1", "torchcodec>=0.9.1"];
}

async function installAceStepRuntime(
  pythonPath: string,
  backendPath: string,
  effectiveBackend: string,
): Promise<string> {
  const runtimeInstall = await runCommand(
    pythonPath,
    ["-m", "pip", "install", ...getAceStepRuntimePackages(effectiveBackend)],
    { cwd: backendPath, timeoutMs: 45 * 60 * 1000 },
  );

  // Optional: numba (audio DSP), torchao (INT8 quantization), torchcodec
  // (video/audio codecs). These can fail on Windows without the right native
  // toolchain. Core music generation works without them.
  let optionalInstall = "";
  const optionalPkgs = getAceStepOptionalPackages(effectiveBackend);
  if (optionalPkgs.length > 0) {
    try {
      optionalInstall = await runCommand(
        pythonPath,
        ["-m", "pip", "install", ...optionalPkgs],
        { cwd: backendPath, timeoutMs: 20 * 60 * 1000 },
      );
    } catch (err) {
      const msg =
        err instanceof Error ? err.message.split("\n")[0] : String(err);
      optionalInstall = `Note: optional packages skipped (${msg}). Quantization and some audio effects unavailable, but core music generation still works.`;
      logger.warn("Optional ACE-Step packages failed to install:", err);
    }
  }

  const packageInstall = await runCommand(
    pythonPath,
    ["-m", "pip", "install", "--upgrade", "--no-deps", ACE_STEP_GIT_URL],
    { cwd: backendPath, timeoutMs: 30 * 60 * 1000 },
  );

  return `${runtimeInstall}\n${optionalInstall}\n${packageInstall}`;
}

function appendLog(chunk: Buffer | string) {
  const value = chunk.toString();
  lastLog = trimOutput(`${lastLog ?? ""}${value}`);
}

function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: getBackendEnvironment(),
      shell: false,
      windowsHide: true,
    });

    let output = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Command timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);

    child.stdout?.on("data", (data) => {
      output += data.toString();
      appendLog(data);
    });
    child.stderr?.on("data", (data) => {
      output += data.toString();
      appendLog(data);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(trimOutput(output));
        return;
      }
      reject(
        new Error(trimOutput(output || `Command exited with code ${code}`)),
      );
    });
  });
}

type PythonInvocation = {
  command: string;
  args: string[];
  displayName: string;
};

type PythonVersion = {
  major: number;
  minor: number;
  label: string;
};

function parsePythonVersion(output: string): PythonVersion | null {
  const match = output.match(/Python\s+(\d+)\.(\d+)(?:\.\d+)?/i);
  if (!match) return null;
  const major = parseInt(match[1], 10);
  const minor = parseInt(match[2], 10);
  return { major, minor, label: `Python ${major}.${minor}` };
}

function isMusicPythonVersionSupported(version: PythonVersion): boolean {
  return version.major === 3 && version.minor >= 11 && version.minor <= 12;
}

async function getVenvPythonVersion(
  cwd: string,
): Promise<PythonVersion | null> {
  const pythonPath = getVenvPythonPath();
  if (!fs.existsSync(pythonPath)) return null;

  const out = await runCommand(pythonPath, ["--version"], {
    cwd,
    timeoutMs: 8000,
  });
  return parsePythonVersion(out);
}

async function assertVenvPythonCompatible(cwd: string): Promise<void> {
  const version = await getVenvPythonVersion(cwd);
  if (!version || isMusicPythonVersionSupported(version)) return;

  throw new Error(
    `Existing Media AI Python environment uses ${version.label}, but Music AI requires Python 3.11 or 3.12. ` +
      "Reset Music Runtime, or run setup again so OrianBuilder can recreate it with Python 3.11 or 3.12.",
  );
}

async function ensureCompatibleMediaAiVenv(cwd: string): Promise<string> {
  let note = "";
  const pythonPath = getVenvPythonPath();
  if (fs.existsSync(pythonPath)) {
    const version = await getVenvPythonVersion(cwd);
    if (version && !isMusicPythonVersionSupported(version)) {
      stopMediaAiBackend();
      await fs.promises.rm(getVenvPath(), { recursive: true, force: true });
      deleteGpuMarker();
      note =
        `Removed existing Media AI environment using ${version.label}; ` +
        "recreating with Python 3.11/3.12 for Music AI.";
      logger.warn(note);
    }
  }

  if (!fs.existsSync(getVenvPythonPath())) {
    const systemPython = await findCompatibleSystemPython(cwd);
    await runCommand(
      systemPython.command,
      [...systemPython.args, "-m", "venv", getVenvPath()],
      {
        cwd,
        timeoutMs: 5 * 60 * 1000,
      },
    );
    note = note
      ? `${note}\nCreated Media AI environment with ${systemPython.displayName}.`
      : `Created Media AI environment with ${systemPython.displayName}.`;
  }

  await assertVenvPythonCompatible(cwd);
  return note;
}

function systemPythonCandidates(): PythonInvocation[] {
  const candidates: PythonInvocation[] =
    process.platform === "win32"
      ? [
          { command: "py", args: ["-3.12"], displayName: "py -3.12" },
          { command: "py", args: ["-3.11"], displayName: "py -3.11" },
          { command: "python", args: [], displayName: "python" },
          { command: "python3", args: [], displayName: "python3" },
        ]
      : [
          { command: "python3.12", args: [], displayName: "python3.12" },
          { command: "python3.11", args: [], displayName: "python3.11" },
          { command: "python3", args: [], displayName: "python3" },
          { command: "python", args: [], displayName: "python" },
        ];
  return candidates;
}

async function findCompatibleSystemPython(
  cwd: string,
): Promise<PythonInvocation> {
  let incompatibleVersion: string | null = null;
  for (const candidate of systemPythonCandidates()) {
    try {
      const out = await runCommand(
        candidate.command,
        [...candidate.args, "--version"],
        {
          cwd,
          timeoutMs: 8000,
        },
      );
      const version = parsePythonVersion(out);
      if (version) {
        if (isMusicPythonVersionSupported(version)) {
          return candidate;
        }
        incompatibleVersion = version.label;
      }
    } catch {
      // ENOENT or non-zero exit: try next command.
    }
  }
  if (incompatibleVersion) {
    throw new Error(
      `${incompatibleVersion} found but Music AI requires Python 3.11 or 3.12. ` +
        "Install Python 3.11 or 3.12 and make sure the Python launcher can find it.",
    );
  }
  throw new Error(
    "Python 3.11 or 3.12 not found in PATH. " +
      "Install Python 3.11 or 3.12 from https://www.python.org/downloads/ " +
      "and make sure to check 'Add Python to PATH' during installation.",
  );
}

// Verify system Python is available and compatible with ACE-Step 1.5.
async function checkSystemPython(cwd: string): Promise<void> {
  await findCompatibleSystemPython(cwd);
}

async function isBackendHealthy() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(`${SERVER_URL}/health`, {
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Public re-exports so other utilities (e.g. the orchestrator's media
 *  dispatcher) can probe and call the Python backend. */
export const MEDIA_AI_SERVER_URL = SERVER_URL;
export const isMediaAiBackendHealthy = isBackendHealthy;

// HuggingFace Hub stores repos under <HF_HOME>/hub/models--<org>--<model>/.
// "stabilityai/sd-turbo" → "models--stabilityai--sd-turbo"
function hfHubRepoDir(repoId: string): string {
  return `models--${repoId.replace("/", "--")}`;
}

// Map of per-tier download IDs to their HuggingFace repo IDs. Used to probe
// the HF hub cache when the script-based marker file is absent (e.g. the
// model was auto-downloaded by diffusers on first generation run).
const TIER_HF_REPOS: Partial<Record<MediaAiModelId, string>> = {
  "image-sd-turbo": "stabilityai/sd-turbo",
  "image-z-image-turbo": "Tongyi-MAI/Z-Image-Turbo",
  whisper: "Systran/faster-whisper-base",
};

function isTierInHfCache(id: MediaAiModelId, hfCachePath: string): boolean {
  const repo = TIER_HF_REPOS[id];
  if (!repo) return false;

  const hubDir = path.join(hfCachePath, "hub", hfHubRepoDir(repo));
  if (fs.existsSync(hubDir)) {
    // The hub dir exists; verify it has at least a snapshots sub-directory
    // so we don't count an empty/partial directory as downloaded.
    const snapshotsDir = path.join(hubDir, "snapshots");
    if (fs.existsSync(snapshotsDir)) {
      const snaps = fs.readdirSync(snapshotsDir);
      if (snaps.length > 0) return true;
    }
  }

  // Also check the local_dir path used by download_models.py's snapshot_download.
  const localDir = path.join(hfCachePath, "snapshots", repo.replace("/", "__"));
  return fs.existsSync(localDir);
}

export function writeModelMarker(id: MediaAiModelId, modelsPath: string): void {
  const markerDir = path.join(modelsPath, ".model-markers");
  fs.mkdirSync(markerDir, { recursive: true });
  const markerPath = path.join(markerDir, `${id}.json`);
  if (!fs.existsSync(markerPath)) {
    fs.writeFileSync(
      markerPath,
      JSON.stringify({
        modelGroup: id,
        downloadedAt: new Date().toISOString(),
        paths: [],
      }),
    );
  }
}

export async function getMediaAiBackendStatus(): Promise<MediaAiStatus> {
  const backendPath = resolveMediaAiBackendPath();
  const requirementsPath = path.join(backendPath, "requirements.txt");
  const { modelsPath, outputsPath, hfCachePath } = getMediaAiDataPaths();
  const markerDir = path.join(modelsPath, ".model-markers");

  const models = (Object.keys(MODEL_LABELS) as MediaAiModelId[]).map((id) => {
    const markerPath = path.join(markerDir, `${id}.json`);
    const hasMarker = fs.existsSync(markerPath);
    // Also accept models that diffusers downloaded automatically during a
    // previous generation — they live in the HF hub cache even without a
    // script-written marker file. Write the marker lazily so future checks
    // are fast (file-stat only, no directory scan).
    const inHfCache = !hasMarker && isTierInHfCache(id, hfCachePath);
    if (inHfCache) writeModelMarker(id, modelsPath);
    return {
      id,
      label: MODEL_LABELS[id],
      downloaded: hasMarker || inHfCache,
      markerPath,
    };
  });

  return {
    backendPath,
    backendAvailable: fs.existsSync(path.join(backendPath, "app", "main.py")),
    serverUrl: SERVER_URL,
    running: pythonServer !== null,
    healthy: await isBackendHealthy(),
    venvPath: getVenvPath(),
    pythonPath: getPythonCommand(),
    venvExists: fs.existsSync(getVenvPythonPath()),
    requirementsPath,
    requirementsAvailable: fs.existsSync(requirementsPath),
    modelsPath,
    outputsPath,
    models,
    lastLog,
    gpuBackendInstalled: (() => {
      let gpu = readGpuMarker();
      if (!gpu) {
        gpu = detectGpuBackendFromVenv();
        if (gpu) writeGpuMarker(gpu); // lazily persist so future reads are fast
      }
      return gpu;
    })(),
  };
}

/** Returns the requirements-{backend}.txt filename to use for the given media
 *  backend. Falls back to requirements-cpu.txt if the vendor-specific file
 *  does not exist on disk yet. */
export function resolveRequirementsFile(
  backend: HardwareProfile["bestMediaBackend"] | string,
): string {
  const backendPath = resolveMediaAiBackendPath();
  const candidate = path.join(backendPath, `requirements-${backend}.txt`);
  if (fs.existsSync(candidate)) return candidate;
  const fallback = path.join(backendPath, "requirements-cpu.txt");
  if (fs.existsSync(fallback)) return fallback;
  // Legacy monolithic requirements.txt still works as last-ditch fallback.
  return path.join(backendPath, "requirements.txt");
}

/** Installs the per-vendor requirements file matching the given backend.
 *  When no backend is supplied, uses the cached hardware profile's
 *  bestMediaBackend, defaulting to "cpu". */
export async function installMediaAiDependenciesForBackend(
  backend?: string,
): Promise<string> {
  const backendPath = resolveMediaAiBackendPath();
  const { root, modelsPath, outputsPath, hfCachePath } = getMediaAiDataPaths();
  await fs.promises.mkdir(root, { recursive: true });
  await fs.promises.mkdir(modelsPath, { recursive: true });
  await fs.promises.mkdir(outputsPath, { recursive: true });
  await fs.promises.mkdir(hfCachePath, { recursive: true });

  const venvSetup = await ensureCompatibleMediaAiVenv(backendPath);

  const pythonPath = getVenvPythonPath();
  const effectiveBackend =
    backend ?? cachedHardwareProfile?.bestMediaBackend ?? "cpu";
  const requirementsFile = resolveRequirementsFile(effectiveBackend);

  logger.info(
    `Installing media AI dependencies for backend "${effectiveBackend}" from ${requirementsFile}`,
  );

  const pipUpgrade = await runCommand(
    pythonPath,
    ["-m", "pip", "install", "--upgrade", "pip"],
    { cwd: backendPath, timeoutMs: 10 * 60 * 1000 },
  );

  // Step 1: base packages (uvicorn, fastapi) — always first so server can start.
  const baseRequirementsFile = path.join(backendPath, "requirements-base.txt");
  let baseInstall = "";
  if (
    fs.existsSync(baseRequirementsFile) &&
    baseRequirementsFile !== requirementsFile
  ) {
    try {
      baseInstall = await runCommand(
        pythonPath,
        ["-m", "pip", "install", "-r", baseRequirementsFile],
        { cwd: backendPath, timeoutMs: 15 * 60 * 1000 },
      );
    } catch (err) {
      baseInstall = `Warning: some base packages failed: ${err instanceof Error ? err.message : String(err)}`;
      logger.warn("Some base requirements failed:", err);
    }
  }

  // Step 2: core ML packages individually — ensures diffusers/onnxruntime/optimum
  // are present even if the full backend requirements abort on a problem package
  // (xformers often fails on Windows Python 3.12+).
  // optimum is required by the image service (ORTStableDiffusionPipeline) on ALL backends.
  const corePackages =
    effectiveBackend === "directml"
      ? [
          "hf_transfer>=0.1.4",
          "diffusers>=0.32.0",
          "transformers>=4.45.0",
          "accelerate>=0.30.0",
          "onnxruntime-directml>=1.18.0",
          "optimum>=1.19.0",
          "sentencepiece>=0.2.0",
          "imageio>=2.34.0",
          "imageio-ffmpeg>=0.5.0",
        ]
      : [
          "hf_transfer>=0.1.4",
          "diffusers>=0.32.0",
          "transformers>=4.45.0",
          "accelerate>=0.30.0",
          "onnxruntime>=1.18.0",
          "optimum>=1.19.0",
          "sentencepiece>=0.2.0",
          "imageio>=2.34.0",
          "imageio-ffmpeg>=0.5.0",
        ];

  // For CUDA backend, install torch with GPU support explicitly before other
  // packages so CPU-only torch from PyPI is never picked up by accident.
  // --upgrade --force-reinstall handles the "I had CPU torch from a previous
  // failed install" case — pip skips reinstall otherwise even though the
  // existing wheel has no CUDA support.
  if (effectiveBackend === "cuda") {
    await runCommand(
      pythonPath,
      [
        "-m",
        "pip",
        "install",
        "--upgrade",
        "--force-reinstall",
        "torch>=2.3.0",
        "torchvision>=0.18.0",
        "--index-url",
        "https://download.pytorch.org/whl/cu128",
      ],
      { cwd: backendPath, timeoutMs: 30 * 60 * 1000 },
    );
  }

  let coreInstall = "";
  if (corePackages.length > 0) {
    coreInstall = await runCommand(
      pythonPath,
      ["-m", "pip", "install", ...corePackages],
      { cwd: backendPath, timeoutMs: 30 * 60 * 1000 },
    );
  }

  // Step 3: full backend requirements (torch, xformers, TTS etc.) — may fail
  // on some packages but core image/audio gen already works from steps 1-2.
  let requirementsInstall = "";
  try {
    requirementsInstall = await runCommand(
      pythonPath,
      ["-m", "pip", "install", "-r", requirementsFile],
      { cwd: backendPath, timeoutMs: 90 * 60 * 1000 },
    );
  } catch (err) {
    requirementsInstall = `Warning: some packages failed to install: ${err instanceof Error ? err.message : String(err)}`;
    logger.warn("Some backend requirements failed to install:", err);
  }

  const aceStepInstall = await installAceStepRuntime(
    pythonPath,
    backendPath,
    effectiveBackend,
  );

  if (effectiveBackend !== "cpu") {
    writeGpuMarker(effectiveBackend);
  }

  return trimOutput(
    `${venvSetup}\n${pipUpgrade}\n${baseInstall}\n${coreInstall}\n${requirementsInstall}\n${aceStepInstall}`,
  );
}

export async function installMediaAiDependencies() {
  const backendPath = resolveMediaAiBackendPath();
  const { root, modelsPath, outputsPath, hfCachePath } = getMediaAiDataPaths();
  await fs.promises.mkdir(root, { recursive: true });
  await fs.promises.mkdir(modelsPath, { recursive: true });
  await fs.promises.mkdir(outputsPath, { recursive: true });
  await fs.promises.mkdir(hfCachePath, { recursive: true });

  const venvSetup = await ensureCompatibleMediaAiVenv(backendPath);

  const pythonPath = getVenvPythonPath();
  const pipUpgrade = await runCommand(
    pythonPath,
    ["-m", "pip", "install", "--upgrade", "pip"],
    { cwd: backendPath, timeoutMs: 10 * 60 * 1000 },
  );

  // Step 1: base packages so server can start regardless of what follows.
  const baseRequirementsFile = path.join(backendPath, "requirements-base.txt");
  let baseInstall = "";
  if (fs.existsSync(baseRequirementsFile)) {
    baseInstall = await runCommand(
      pythonPath,
      ["-m", "pip", "install", "-r", baseRequirementsFile],
      { cwd: backendPath, timeoutMs: 15 * 60 * 1000 },
    );
  }

  // Step 2: core ML packages so image generation works even if the full
  // requirements install aborts on a problem package like xformers.
  // optimum is always required by the image service (ORTStableDiffusionPipeline).
  const coreInstall = await runCommand(
    pythonPath,
    [
      "-m",
      "pip",
      "install",
      "diffusers>=0.32.0",
      "transformers>=4.45.0",
      "accelerate>=0.30.0",
      "onnxruntime>=1.18.0",
      "optimum>=1.19.0",
      "sentencepiece>=0.2.0",
      "imageio>=2.34.0",
      "imageio-ffmpeg>=0.5.0",
    ],
    { cwd: backendPath, timeoutMs: 30 * 60 * 1000 },
  );

  // Step 3: full requirements — allowed to partially fail.
  let requirementsInstall = "";
  try {
    requirementsInstall = await runCommand(
      pythonPath,
      [
        "-m",
        "pip",
        "install",
        "-r",
        path.join(backendPath, "requirements.txt"),
      ],
      { cwd: backendPath, timeoutMs: 90 * 60 * 1000 },
    );
  } catch (err) {
    requirementsInstall = `Warning: some packages failed to install: ${err instanceof Error ? err.message : String(err)}`;
    logger.warn("Some legacy requirements failed to install:", err);
  }

  const aceStepInstall = await installAceStepRuntime(
    pythonPath,
    backendPath,
    cachedHardwareProfile?.bestMediaBackend ?? "cpu",
  );

  return trimOutput(
    `${venvSetup}\n${pipUpgrade}\n${baseInstall}\n${coreInstall}\n${requirementsInstall}\n${aceStepInstall}`,
  );
}

let activeDownloadProcess: ChildProcess | null = null;

export function cancelMediaAiDownload(): void {
  if (activeDownloadProcess) {
    activeDownloadProcess.kill("SIGTERM");
    activeDownloadProcess = null;
    logger.info("Active media-AI download cancelled");
  }
}

export function isMediaAiDownloadActive(): boolean {
  return activeDownloadProcess !== null;
}

export async function downloadMediaAiModels(
  models: MediaAiModelId[],
): Promise<string> {
  const backendPath = resolveMediaAiBackendPath();
  const scriptPath = path.join(backendPath, "scripts", "download_models.py");
  const env = getBackendEnvironment();

  return new Promise<string>((resolve, reject) => {
    const child = spawn(getPythonCommand(), [scriptPath, ...models], {
      cwd: backendPath,
      env,
      shell: false,
      windowsHide: true,
    });
    activeDownloadProcess = child;
    appendLog(`Starting download: ${models.join(", ")}\n`);

    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      appendLog(text);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      appendLog(text);
    });
    child.on("close", (code) => {
      activeDownloadProcess = null;
      if (code === 0 || code === null) {
        resolve(trimOutput(output));
      } else {
        reject(
          new Error(
            `Download exited with code ${code}:\n${trimOutput(output)}`,
          ),
        );
      }
    });
    child.on("error", (err) => {
      activeDownloadProcess = null;
      reject(err);
    });
  });
}

async function ensureBaseRequirements(): Promise<void> {
  const backendPath = resolveMediaAiBackendPath();
  const pythonPath = getPythonCommand();

  try {
    await runCommand(pythonPath, ["-c", "import uvicorn"], {
      cwd: backendPath,
      timeoutMs: 10_000,
    });
  } catch {
    logger.warn("uvicorn not found in venv — installing base requirements...");
    const baseRequirementsFile = path.join(
      backendPath,
      "requirements-base.txt",
    );
    if (fs.existsSync(baseRequirementsFile)) {
      await runCommand(
        pythonPath,
        ["-m", "pip", "install", "-r", baseRequirementsFile],
        { cwd: backendPath, timeoutMs: 15 * 60 * 1000 },
      );
    }
  }

  // python-multipart is required by FastAPI for File/Form uploads (transcription).
  // Check and install separately so existing venvs without it get auto-fixed.
  try {
    await runCommand(pythonPath, ["-c", "import multipart"], {
      cwd: backendPath,
      timeoutMs: 10_000,
    });
  } catch {
    logger.warn("python-multipart not found — installing...");
    await runCommand(
      pythonPath,
      ["-m", "pip", "install", "python-multipart>=0.0.9"],
      { cwd: backendPath, timeoutMs: 5 * 60 * 1000 },
    );
  }

  // diffusers is the core ML dep for all image/video generation. Auto-install
  // if missing so an existing venv that only has uvicorn still gets generation.
  try {
    await runCommand(pythonPath, ["-c", "import diffusers"], {
      cwd: backendPath,
      timeoutMs: 10_000,
    });
  } catch {
    logger.warn("diffusers not found — installing core ML packages...");
    try {
      await runCommand(
        pythonPath,
        [
          "-m",
          "pip",
          "install",
          "diffusers>=0.32.0",
          "transformers>=4.45.0",
          "accelerate>=0.30.0",
          "hf_transfer>=0.1.4",
          "sentencepiece>=0.2.0",
        ],
        { cwd: backendPath, timeoutMs: 30 * 60 * 1000 },
      );
    } catch (err) {
      logger.warn("Core ML package install failed (non-fatal):", err);
    }
  }
}

export async function startMediaAiBackend() {
  const backendPath = resolveMediaAiBackendPath();
  if (pythonServer) {
    return;
  }
  if (!fs.existsSync(path.join(backendPath, "app", "main.py"))) {
    logger.warn(
      `Media AI backend not found at ${backendPath}; skipping auto-start.`,
    );
    return;
  }

  const { modelsPath, outputsPath, hfCachePath } = getMediaAiDataPaths();
  fs.mkdirSync(modelsPath, { recursive: true });
  fs.mkdirSync(outputsPath, { recursive: true });
  fs.mkdirSync(hfCachePath, { recursive: true });

  await ensureBaseRequirements();

  pythonServer = spawn(
    getPythonCommand(),
    ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8000"],
    {
      cwd: backendPath,
      shell: false,
      windowsHide: true,
      env: getBackendEnvironment(),
    },
  );

  pythonServer.stdout?.on("data", (data) => {
    appendLog(data);
    logger.info(`Media AI Backend: ${data}`);
  });
  pythonServer.stderr?.on("data", (data) => {
    appendLog(data);
    logger.error(`Media AI Error: ${data}`);
  });
  pythonServer.on("error", (err) => {
    logger.error("Failed to start Media AI backend:", err);
  });
  pythonServer.on("close", (code) => {
    logger.info(`Media AI backend exited with code ${code}`);
    pythonServer = null;
  });
}

export function stopMediaAiBackend() {
  if (!pythonServer) {
    return;
  }
  logger.info("Stopping Media AI backend...");
  pythonServer.kill();
  pythonServer = null;
}

export async function deleteMediaAiModel(
  modelId: MediaAiModelId,
): Promise<void> {
  const { modelsPath, hfCachePath } = getMediaAiDataPaths();

  // Remove marker file
  const markerPath = path.join(modelsPath, ".model-markers", `${modelId}.json`);
  if (fs.existsSync(markerPath)) {
    fs.unlinkSync(markerPath);
    logger.info(`Deleted model marker: ${markerPath}`);
  }

  // Remove HF cache directory for this model
  const repo = TIER_HF_REPOS[modelId];
  if (repo) {
    const hubDir = path.join(hfCachePath, "hub", hfHubRepoDir(repo));
    if (fs.existsSync(hubDir)) {
      fs.rmSync(hubDir, { recursive: true, force: true });
      logger.info(`Deleted HF hub cache: ${hubDir}`);
    }
    const snapshotLocalDir = path.join(
      hfCachePath,
      "snapshots",
      repo.replace("/", "__"),
    );
    if (fs.existsSync(snapshotLocalDir)) {
      fs.rmSync(snapshotLocalDir, { recursive: true, force: true });
      logger.info(`Deleted snapshot local dir: ${snapshotLocalDir}`);
    }
  }
}

/** Nukes the Python venv so the next install starts from a clean slate. The
 *  downloaded model weights under <userData>/mediaai/models/huggingface are
 *  preserved — they're disk-heavy and unchanged by a venv wipe. */
export async function resetMediaAiSetup(opts?: {
  alsoDeleteModels?: boolean;
}): Promise<{ removed: string[] }> {
  stopMediaAiBackend();
  cancelMediaAiDownload();

  const venvPath = getVenvPath();
  const { modelsPath } = getMediaAiDataPaths();
  const removed: string[] = [];

  if (fs.existsSync(venvPath)) {
    await fs.promises.rm(venvPath, { recursive: true, force: true });
    removed.push(venvPath);
    logger.info(`Removed venv at ${venvPath}`);
  }

  if (opts?.alsoDeleteModels) {
    if (fs.existsSync(modelsPath)) {
      await fs.promises.rm(modelsPath, { recursive: true, force: true });
      removed.push(modelsPath);
      logger.info(`Removed models at ${modelsPath}`);
    }
  } else {
    // Always wipe the per-model marker files so the Media AI UI re-checks the
    // HF cache instead of trusting stale markers from a broken install.
    const markerDir = path.join(modelsPath, ".model-markers");
    if (fs.existsSync(markerDir)) {
      await fs.promises.rm(markerDir, { recursive: true, force: true });
      removed.push(markerDir);
    }
  }

  deleteGpuMarker();
  lastLog = undefined;
  return { removed };
}

export async function checkMediaAiPythonAvailable(): Promise<{
  available: boolean;
  version: string | null;
  error: string | null;
}> {
  const backendPath = resolveMediaAiBackendPath();
  try {
    await checkSystemPython(backendPath);
    // If we get here, Python is available. Get the version string.
    for (const cmd of ["python", "python3"]) {
      try {
        const out = await runCommand(cmd, ["--version"], {
          cwd: backendPath,
          timeoutMs: 5000,
        });
        const m = out.match(/Python\s+(\d+\.\d+(?:\.\d+)?)/i);
        return { available: true, version: m?.[1] ?? null, error: null };
      } catch {
        continue;
      }
    }
    return { available: true, version: null, error: null };
  } catch (err) {
    return {
      available: false,
      version: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
