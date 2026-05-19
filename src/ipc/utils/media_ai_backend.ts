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

// Verify system Python is available and is 3.10+
async function checkSystemPython(cwd: string): Promise<void> {
  for (const cmd of ["python", "python3"]) {
    try {
      const out = await runCommand(cmd, ["--version"], {
        cwd,
        timeoutMs: 8000,
      });
      const m = out.match(/Python\s+(\d+)\.(\d+)/i);
      if (m) {
        const major = parseInt(m[1], 10);
        const minor = parseInt(m[2], 10);
        if (major < 3 || (major === 3 && minor < 10)) {
          throw new Error(
            `Python ${major}.${minor} found but 3.10+ is required. ` +
              `Download from https://www.python.org/downloads/`,
          );
        }
        return; // found and valid
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("3.10+")) throw err;
      // ENOENT or non-zero exit — try next command
    }
  }
  throw new Error(
    "Python 3.10+ not found in PATH. " +
      "Install it from https://www.python.org/downloads/ " +
      "and make sure to check 'Add Python to PATH' during installation.",
  );
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

  await checkSystemPython(backendPath);

  if (!fs.existsSync(getVenvPythonPath())) {
    await runCommand("python", ["-m", "venv", getVenvPath()], {
      cwd: backendPath,
      timeoutMs: 5 * 60 * 1000,
    });
  }

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

  return trimOutput(
    `${pipUpgrade}\n${baseInstall}\n${coreInstall}\n${requirementsInstall}`,
  );
}

export async function installMediaAiDependencies() {
  const backendPath = resolveMediaAiBackendPath();
  const { root, modelsPath, outputsPath, hfCachePath } = getMediaAiDataPaths();
  await fs.promises.mkdir(root, { recursive: true });
  await fs.promises.mkdir(modelsPath, { recursive: true });
  await fs.promises.mkdir(outputsPath, { recursive: true });
  await fs.promises.mkdir(hfCachePath, { recursive: true });

  if (!fs.existsSync(getVenvPythonPath())) {
    await runCommand("python", ["-m", "venv", getVenvPath()], {
      cwd: backendPath,
      timeoutMs: 5 * 60 * 1000,
    });
  }

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

  return trimOutput(
    `${pipUpgrade}\n${baseInstall}\n${coreInstall}\n${requirementsInstall}`,
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
