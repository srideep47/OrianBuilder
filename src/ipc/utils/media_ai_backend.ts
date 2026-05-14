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

export async function getMediaAiBackendStatus(): Promise<MediaAiStatus> {
  const backendPath = resolveMediaAiBackendPath();
  const requirementsPath = path.join(backendPath, "requirements.txt");
  const { modelsPath, outputsPath } = getMediaAiDataPaths();
  const markerDir = path.join(modelsPath, ".model-markers");

  const models = (Object.keys(MODEL_LABELS) as MediaAiModelId[]).map((id) => {
    const markerPath = path.join(markerDir, `${id}.json`);
    return {
      id,
      label: MODEL_LABELS[id],
      downloaded: fs.existsSync(markerPath),
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
  const requirementsInstall = await runCommand(
    pythonPath,
    ["-m", "pip", "install", "-r", requirementsFile],
    { cwd: backendPath, timeoutMs: 90 * 60 * 1000 },
  );
  return trimOutput(`${pipUpgrade}\n${requirementsInstall}`);
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
  const requirementsInstall = await runCommand(
    pythonPath,
    ["-m", "pip", "install", "-r", path.join(backendPath, "requirements.txt")],
    { cwd: backendPath, timeoutMs: 90 * 60 * 1000 },
  );

  return trimOutput(`${pipUpgrade}\n${requirementsInstall}`);
}

export async function downloadMediaAiModels(models: MediaAiModelId[]) {
  const backendPath = resolveMediaAiBackendPath();
  const scriptPath = path.join(backendPath, "scripts", "download_models.py");
  const output = await runCommand(getPythonCommand(), [scriptPath, ...models], {
    cwd: backendPath,
    timeoutMs: 120 * 60 * 1000,
  });
  return output;
}

export function startMediaAiBackend() {
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
