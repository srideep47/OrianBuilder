import { app } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import log from "electron-log";

const logger = log.scope("tensorrt-native");

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TensorRtNativeStatus {
  runnerPath: string | null;
  runnerAvailable: boolean;
  runtimePath: string | null;
  runtimeAvailable: boolean;
  engineDir: string | null;
  engineFormat: "tensorrt-llm" | "tensorrt-plan" | "unknown" | null;
  loaded: boolean;
}

export interface TensorRtNativeChatResult {
  text: string;
  tokenCount: number;
  promptTokens: number;
  prefillDurationMs: number;
  decodeTps: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Pending request map
// ---------------------------------------------------------------------------

type TokenCallback = (text: string) => void;

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
  onToken?: TokenCallback;
};

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function findDefaultTensorRtEngineDir(): string | null {
  const appdata =
    process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
  const candidates = [
    path.join(
      app.getPath("userData"),
      "models",
      "trt_engines",
      "qwen2.5-0.5b-instruct",
    ),
    path.join(
      app.getPath("userData"),
      "models",
      "trt_engines",
      "qwen2.5-1.5b-instruct",
    ),
    path.join(app.getPath("userData"), "models", "trt_engines", "qwen3-4b"),
    path.join(
      appdata,
      "OrianBuilder",
      "models",
      "trt_engines",
      "qwen2.5-0.5b-instruct",
    ),
    path.join(appdata, "OrianBuilder", "models", "trt_engines", "qwen3-4b"),
  ];
  return (
    candidates.find((c) => fs.existsSync(path.join(c, "engine_meta.json"))) ??
    null
  );
}

/** Read engine_meta.json format field without throwing. */
export function readEngineMetaFormat(
  engineDir: string,
): "tensorrt-llm" | "tensorrt-plan" | "unknown" {
  try {
    const meta = JSON.parse(
      fs.readFileSync(path.join(engineDir, "engine_meta.json"), "utf8"),
    );
    const fmt = meta?.format;
    if (fmt === "tensorrt-llm") return "tensorrt-llm";
    if (fmt === "tensorrt-plan") return "tensorrt-plan";
    return "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Resolve the Python sidecar runner script.
 * Looks in packaged resources first, then the source tree.
 */
export function resolveTrtLlmRunnerScript(): string | null {
  const candidates = [
    path.join(process.resourcesPath, "trt-llm-runner", "runner.py"),
    path.join(app.getAppPath(), "native", "trt-llm-runner", "runner.py"),
    path.join(process.cwd(), "native", "trt-llm-runner", "runner.py"),
  ];
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

/** Kept for back-compat: find the C++ runner (not used for LLM chat). */
export function resolveTensorRtRunnerPath(): string | null {
  const exeName =
    process.platform === "win32"
      ? "OrianTensorRtRunner.exe"
      : "OrianTensorRtRunner";
  const candidates = [
    path.join(process.resourcesPath, "tensorrt-runner", exeName),
    path.join(app.getAppPath(), "native", "tensorrt-runner", "bin", exeName),
    path.join(process.cwd(), "native", "tensorrt-runner", "bin", exeName),
  ];
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

/**
 * Find the TensorRT runtime DLL directory.
 * TensorRT 10.x ships DLLs in bin\ (not lib\).
 */
export function resolveTensorRtRuntimePath(): string | null {
  const roots = [
    process.env.ORIAN_TENSORRT_ROOT,
    process.env.TENSORRT_ROOT,
    path.join(app.getPath("userData"), "runtimes", "tensorrt"),
    path.join(process.resourcesPath, "tensorrt-runtime"),
    // Fallback: well-known install path
    "C:\\NVIDIA\\TensorRT-10.16.1.11",
  ].filter(Boolean) as string[];

  for (const root of roots) {
    // TensorRT 10.x: DLLs in bin\
    const binDir = path.join(root, "bin");
    const libDir = path.join(root, "lib");
    if (hasTensorRtDll(binDir)) return binDir;
    if (hasTensorRtDll(libDir)) return libDir;
    if (hasTensorRtDll(root)) return root;
  }

  const pathEntries = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean);
  return pathEntries.find((entry) => hasTensorRtDll(entry)) ?? null;
}

function hasTensorRtDll(dir: string): boolean {
  try {
    // TensorRT 10.x uses versioned names like nvinfer_10.dll
    return fs
      .readdirSync(dir)
      .some((file) => /^nvinfer(_\d+)?\.dll$/i.test(file));
  } catch {
    return false;
  }
}

/** Resolve the Python executable on PATH. */
function resolvePython(): string {
  return process.platform === "win32" ? "python" : "python3";
}

// ---------------------------------------------------------------------------
// TensorRtNativeBackend
// ---------------------------------------------------------------------------

export class TensorRtNativeBackend {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, PendingRequest>();
  private stdoutBuffer = "";
  private loadedEngineDir: string | null = null;
  private loadedEngineFormat:
    | "tensorrt-llm"
    | "tensorrt-plan"
    | "unknown"
    | null = null;

  getStatus(): TensorRtNativeStatus {
    const runnerScript = resolveTrtLlmRunnerScript();
    const runtimePath = resolveTensorRtRuntimePath();
    const engineDir = this.loadedEngineDir ?? findDefaultTensorRtEngineDir();
    const engineFormat = engineDir ? readEngineMetaFormat(engineDir) : null;
    return {
      // Python runner is the primary runner for LLM chat
      runnerPath: runnerScript,
      runnerAvailable: Boolean(runnerScript),
      runtimePath,
      runtimeAvailable: Boolean(runtimePath),
      engineDir,
      engineFormat,
      loaded: Boolean(this.loadedEngineDir && this.proc),
    };
  }

  async load(engineDir: string): Promise<void> {
    if (process.platform !== "win32") {
      throw new Error("Native TensorRT backend is currently Windows-only.");
    }
    if (!fs.existsSync(path.join(engineDir, "engine_meta.json"))) {
      throw new Error(`TensorRT engine metadata not found in: ${engineDir}`);
    }
    const format = readEngineMetaFormat(engineDir);
    if (format !== "tensorrt-llm") {
      throw new Error(
        `Engine at ${engineDir} has format "${format}". ` +
          `Only "tensorrt-llm" engines built by OrianBuilder support real LLM chat. ` +
          `Use the Build panel to compile a TensorRT-LLM engine first.`,
      );
    }
    await this.ensureRunner();
    const result = await this.request("load", { engineDir }, 300_000);
    this.loadedEngineDir = engineDir;
    this.loadedEngineFormat = format;
    logger.info(`TensorRT engine loaded: ${result.modelId ?? engineDir}`);
  }

  async unload(): Promise<void> {
    if (!this.proc) {
      this.loadedEngineDir = null;
      this.loadedEngineFormat = null;
      return;
    }
    try {
      await this.request("unload", {}, 15_000);
    } catch {
      /* best effort */
    }
    this.loadedEngineDir = null;
    this.loadedEngineFormat = null;
  }

  async shutdown(): Promise<void> {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("TensorRT runner stopped"));
    }
    this.pending.clear();
    this.loadedEngineDir = null;
    this.loadedEngineFormat = null;
    this.proc?.kill();
    this.proc = null;
  }

  /**
   * Run a chat request.
   * If onToken is provided the runner will stream tokens back via that callback,
   * then resolve with the final done stats.
   */
  async chat(params: {
    system: string;
    prompt: string;
    maxTokens: number;
    temperature?: number;
    topP?: number;
    topK?: number;
    stop?: string[];
    stream?: boolean;
    onToken?: TokenCallback;
  }): Promise<TensorRtNativeChatResult> {
    if (!this.loadedEngineDir) {
      throw new Error("TensorRT engine is not loaded.");
    }
    const {
      system,
      prompt,
      maxTokens,
      temperature = 0.7,
      topP = 0.95,
      topK = 40,
      stop = [],
      stream = Boolean(params.onToken),
      onToken,
    } = params;

    const response = await this.request(
      "chat",
      { system, prompt, maxTokens, temperature, topP, topK, stop, stream },
      600_000,
      onToken,
    );
    return {
      text: String(response.text ?? ""),
      tokenCount: Number(response.tokenCount ?? 0),
      promptTokens: Number(response.promptTokens ?? 0),
      prefillDurationMs: Number(response.prefillDurationMs ?? 0),
      decodeTps: Number(response.decodeTps ?? 0),
      durationMs: Number(response.durationMs ?? 0),
    };
  }

  /**
   * Send a build request to the Python runner.
   * Calls onProgress with phase/message updates.
   * Resolves with { engineDir, durationMs } on success.
   */
  async build(params: {
    modelId: string;
    outputDir: string;
    maxInputLen?: number;
    maxOutputLen?: number;
    dtype?: string;
    onProgress?: (phase: string, message: string) => void;
  }): Promise<{ engineDir: string; durationMs: number }> {
    const {
      modelId,
      outputDir,
      maxInputLen = 4096,
      maxOutputLen = 2048,
      dtype = "fp16",
      onProgress,
    } = params;

    await this.ensureRunner();

    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timeoutMs = 3_600_000; // 1 hour max for long builds
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`TensorRT build timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve,
        reject,
        timer,
        // build uses a custom message handler (see handleMessage)
      });

      // Store onProgress so handleMessage can call it
      (this.pending.get(id) as any)._onProgress = onProgress;

      const body =
        JSON.stringify({
          id,
          type: "build",
          modelId,
          outputDir,
          maxInputLen,
          maxOutputLen,
          dtype,
        }) + "\n";
      this.proc!.stdin.write(body, "utf8");
    });
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async ensureRunner(): Promise<void> {
    if (this.proc) return;

    const runnerScript = resolveTrtLlmRunnerScript();
    if (!runnerScript) {
      throw new Error(
        "TensorRT-LLM runner script not found. " +
          "Expected at native/trt-llm-runner/runner.py in the source tree or packaged resources.",
      );
    }

    const python = resolvePython();
    const runtimePath = resolveTensorRtRuntimePath();

    // Inject TensorRT DLL directory into PATH so Python/ctypes can find nvinfer.dll
    const extraPath = runtimePath ? `${runtimePath}${path.delimiter}` : "";

    this.proc = spawn(python, [runnerScript], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        PATH: `${extraPath}${process.env.PATH ?? ""}`,
        // Propagate TensorRT root so trtexec can be found inside the runner
        TENSORRT_ROOT:
          process.env.TENSORRT_ROOT ?? "C:\\NVIDIA\\TensorRT-10.16.1.11",
        // Suppress Python output buffering
        PYTHONUNBUFFERED: "1",
      },
    });

    this.proc.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    this.proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) logger.info(`[py-stderr] ${text}`);
    });
    this.proc.on("exit", (code, signal) => {
      logger.warn(`Python runner exited code=${code} signal=${signal}`);
      void this.shutdown();
    });
    this.proc.on("error", (err) => {
      logger.error("Python runner error:", err);
      void this.shutdown();
    });

    logger.info(`Python TRT-LLM runner started: ${python} ${runnerScript}`);
  }

  private request(
    type: string,
    payload: Record<string, unknown>,
    timeoutMs: number,
    onToken?: TokenCallback,
  ): Promise<any> {
    if (!this.proc) {
      return Promise.reject(new Error("TensorRT runner is not started"));
    }
    const id = randomUUID();
    const body = JSON.stringify({ id, type, ...payload }) + "\n";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`TensorRT ${type} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, onToken });
      this.proc!.stdin.write(body, "utf8");
    });
  }

  private onStdout(chunk: Buffer): void {
    this.stdoutBuffer += chunk.toString();
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      this.handleMessage(line);
    }
  }

  private handleMessage(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      logger.warn(`invalid runner JSON: ${line.slice(0, 200)}`);
      return;
    }

    const id = String(msg.id ?? "");
    const pending = this.pending.get(id);
    if (!pending) return;

    const msgType: string = msg.type ?? "";

    // Streaming token — call callback but keep pending alive
    if (msgType === "token") {
      pending.onToken?.(String(msg.text ?? ""));
      return;
    }

    // Build progress — call _onProgress but keep pending alive
    if (msgType === "build_progress") {
      (pending as any)._onProgress?.(
        String(msg.phase ?? ""),
        String(msg.message ?? ""),
      );
      return;
    }

    // Final responses — resolve/reject and clean up
    this.pending.delete(id);
    clearTimeout(pending.timer);

    if (msg.ok === false) {
      pending.reject(new Error(String(msg.error ?? "TensorRT runner error")));
      return;
    }

    if (msgType === "done") {
      // chat done
      pending.resolve(msg);
      return;
    }

    if (msgType === "build_done") {
      pending.resolve({ engineDir: msg.engineDir, durationMs: msg.durationMs });
      return;
    }

    // Generic ok response (load, unload, status)
    pending.resolve(msg);
  }
}
