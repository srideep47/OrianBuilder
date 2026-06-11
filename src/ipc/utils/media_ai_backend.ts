import { app } from "electron";
import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import log from "electron-log";
import treeKill from "tree-kill";
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

const SERVER_URL = "http://127.0.0.1:8001";
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

/** Tracks how many times the backend has been auto-restarted after a crash.
 *  Resets to 0 on every intentional startMediaAiBackend() call.  Caps out
 *  at MAX_CRASH_RESTARTS to avoid an infinite crash-restart loop when the
 *  crash is deterministic (e.g. corrupted model weights). */
let _crashRestartCount = 0;
const MAX_CRASH_RESTARTS = 3;

/** Set to true just before an intentional SIGKILL so the close handler
 *  doesn't mistake the forced shutdown for a crash and schedule a restart. */
let _intentionalStop = false;

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

function getTripoSrSrcPath() {
  // TripoSR has no setup.py, so we can't pip-install it. We clone the repo
  // here and add this path to PYTHONPATH so `from tsr.system import TSR` works.
  return path.join(getMediaAiDataPaths().root, "triposr-src");
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

/**
 * Checks whether the minimum required Python packages are installed in the
 * venv. We look for fastapi, uvicorn, and diffusers as sentinels — if any are
 * missing the install was interrupted (e.g. lost internet) and the backend
 * cannot start.
 */
function areBaseDepsInstalled(): boolean {
  const sitePackages = getVenvSitePackages();
  if (!sitePackages) return false;
  try {
    const entries = fs.readdirSync(sitePackages);
    const lower = entries.map((e) => e.toLowerCase());
    const hasFastapi = lower.some((e) => e.startsWith("fastapi"));
    const hasUvicorn = lower.some((e) => e.startsWith("uvicorn"));
    const hasDiffusers = lower.some((e) => e.startsWith("diffusers"));
    return hasFastapi && hasUvicorn && hasDiffusers;
  } catch {
    return false;
  }
}

// Probe the venv's site-packages to detect GPU-capable packages already installed.
// Handles existing installs that pre-date the marker file.
function detectGpuBackendFromVenv(): string | undefined {
  const sitePackages = getVenvSitePackages();
  if (!sitePackages) return undefined;
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
  // Stitch the TripoSR source onto PYTHONPATH if we've cloned it — this lets
  // `from tsr.system import TSR` resolve without pip having to install the
  // package (TripoSR's repo has no setup.py).
  const tripoSrSrc = getTripoSrSrcPath();
  const pythonPathEntries = [backendPath];
  if (fs.existsSync(path.join(tripoSrSrc, "tsr"))) {
    pythonPathEntries.push(tripoSrSrc);
  }
  return {
    ...process.env,
    PYTHONPATH: pythonPathEntries.join(path.delimiter),
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
    // RAM-aware tier selection fallback for venvs without psutil installed.
    ORIANBUILDER_TOTAL_RAM_MB: String(
      Math.round(os.totalmem() / (1024 * 1024)),
    ),
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

const TRIPO_SR_GIT_URL = "https://github.com/VAST-AI-Research/TripoSR.git";

function getTripoSrRuntimePackages(_effectiveBackend: string): string[] {
  // TripoSR runtime packages — deliberately minimal to avoid numpy ABI chaos.
  //
  // Root-cause of the recurring "Expected 96, got 88" error: onnxruntime
  // (used by rembg for background removal) and PyMCubes both ship Windows
  // native C extensions whose internal numpy ABI expectation depends on which
  // numpy was available when the wheel was built on PyPI's CI. We've been in
  // a constant fight with mismatched versions. The fix is to stop using them:
  //
  //   • rembg / onnxruntime  → replaced with PIL-based threshold segmentation
  //                            in threed.py (good enough for cartoon/object
  //                            images on light backgrounds)
  //   • PyMCubes              → replaced with scikit-image marching_cubes.
  //                            skimage ships as a proper numpy-2.x-compatible
  //                            wheel and is maintained by the scientific Python
  //                            community. Our torchmcubes shim wraps it.
  //
  // huggingface_hub is pinned below 1.0 because transformers (loaded by
  // TripoSR internally) enforces huggingface_hub>=0.34.0,<1.0 at import time
  // and throws a hard error if the installed version is outside that range.
  //
  // pandas>=2.2.2 is the first release with numpy-2.x ABI compatibility.
  // TripoSR imports transformers, which imports sklearn, which imports pandas
  // at module load. Older pandas (e.g. 1.5.3 pulled in by TTS) crashes with
  // "Expected 96 from C header, got 88 from PyObject" the moment its Cython
  // extensions are loaded against numpy 2.x.
  // rembg + onnxruntime are what upstream TripoSR uses to segment the subject
  // out of the reference image with U2Net. We previously avoided them because
  // they fought numpy 1.x — but with numpy 2.x + pandas 2.x they install
  // cleanly on Windows and the segmentation quality is dramatically better
  // than our PIL flood-fill. Subject quality in the final mesh is bounded by
  // segmentation quality, so this is the single biggest mesh-quality lever.
  return [
    "numpy>=2.0,<3.0",
    "huggingface-hub>=0.34.0,<1.0",
    "scikit-image>=0.21.0",
    "omegaconf>=2.3.0",
    "trimesh>=4.0.0",
    "einops>=0.7.0",
    "Pillow>=10.0.0",
    "pandas>=2.2.2",
    "onnxruntime>=1.18.0",
    "rembg[cpu]>=2.0.50",
  ];
}

const TORCHMCUBES_SHIM_SOURCE = `"""Shim: exposes torchmcubes.marching_cubes using scikit-image.

TripoSR requires torchmcubes (GitHub-only, CUDA build needed) for mesh
extraction. scikit-image ships pre-built, numpy-2.x-compatible wheels for
every major platform — no compiler or CUDA toolkit required. The interface
is identical: marching_cubes(scalar_field_tensor, isovalue) → (vertices, faces).
"""

from __future__ import annotations

import numpy as np
import torch


def marching_cubes(volume, isovalue: float = 0.0):
    """Drop-in for torchmcubes.marching_cubes using skimage.measure."""
    if isinstance(volume, torch.Tensor):
        scalar_field = volume.detach().cpu().numpy()
    else:
        scalar_field = np.asarray(volume)
    scalar_field = scalar_field.astype(np.float32, copy=False)

    from skimage.measure import marching_cubes as _mc  # type: ignore
    # skimage returns (vertices, faces, normals, values); TripoSR only uses
    # vertices and faces.
    verts, faces, _normals, _values = _mc(scalar_field, level=float(isovalue))
    # .copy() is critical: skimage can return arrays with negative strides
    # which torch.from_numpy does not support.
    return (
        torch.from_numpy(np.ascontiguousarray(verts, dtype=np.float32)),
        torch.from_numpy(np.ascontiguousarray(faces, dtype=np.int64)),
    )


def grid_interp(*_args, **_kwargs):
    raise NotImplementedError(
        "torchmcubes.grid_interp is not needed by TripoSR and is not "
        "implemented in this scikit-image shim."
    )
`;

async function writeThreeDShims(): Promise<string> {
  // We only ship the torchmcubes shim. rembg is now installed for real (via
  // the runtime packages list) so U2Net segmentation can run — that's what
  // upstream TripoSR uses and it produces much cleaner cutouts than corner
  // sampling on noisy AI-generated reference images. If an older install
  // left a rembg.py shim on PYTHONPATH it would shadow the real package, so
  // we delete it as part of the same step.
  const srcPath = getTripoSrSrcPath();
  const mcubesPath = path.join(srcPath, "torchmcubes.py");
  await fs.promises.writeFile(mcubesPath, TORCHMCUBES_SHIM_SOURCE, "utf8");

  const messages: string[] = [`torchmcubes shim written to ${mcubesPath}`];
  for (const stale of ["rembg.py", "rembg.py.disabled"]) {
    const stalePath = path.join(srcPath, stale);
    try {
      await fs.promises.unlink(stalePath);
      messages.push(`removed stale ${stale} from TripoSR source`);
    } catch {
      // not present — fine
    }
  }
  return messages.join("\n");
}

async function cloneOrUpdateTripoSrSrc(): Promise<string> {
  const srcPath = getTripoSrSrcPath();
  const parentDir = path.dirname(srcPath);
  await fs.promises.mkdir(parentDir, { recursive: true });

  const alreadyCloned = fs.existsSync(path.join(srcPath, ".git"));
  if (alreadyCloned) {
    try {
      const pullOut = await runCommand("git", ["pull", "--ff-only"], {
        cwd: srcPath,
        timeoutMs: 5 * 60 * 1000,
      });
      logger.info(`TripoSR source updated at ${srcPath}`);
      // Sanity check: tsr/ must exist for PYTHONPATH to resolve `import tsr`.
      if (!fs.existsSync(path.join(srcPath, "tsr"))) {
        throw new Error(
          `TripoSR was cloned but tsr/ subfolder is missing at ${srcPath} — upstream layout may have changed.`,
        );
      }
      return `TripoSR source updated at ${srcPath}\n${pullOut}`;
    } catch (err) {
      logger.warn(
        "git pull failed for TripoSR source — leaving existing checkout:",
        err,
      );
      return `TripoSR source already present at ${srcPath} (pull skipped: ${err instanceof Error ? err.message.split("\n")[0] : String(err)})`;
    }
  }

  // Fresh clone. If a stale non-git folder is in the way, remove it first.
  if (fs.existsSync(srcPath)) {
    await fs.promises.rm(srcPath, { recursive: true, force: true });
  }
  const cloneOut = await runCommand(
    "git",
    ["clone", "--depth", "1", TRIPO_SR_GIT_URL, srcPath],
    { cwd: parentDir, timeoutMs: 10 * 60 * 1000 },
  );
  // Sanity check the clone landed where we expect — the tsr/ subfolder is what
  // PYTHONPATH needs to see. If the upstream repo layout ever moves, we want
  // a loud failure here rather than a confusing "TripoSR is not installed"
  // error later from the Python side.
  if (!fs.existsSync(path.join(srcPath, "tsr"))) {
    throw new Error(
      `TripoSR clone finished but tsr/ subfolder is missing at ${srcPath}. Clone output:\n${cloneOut}`,
    );
  }
  logger.info(`TripoSR source cloned to ${srcPath}`);
  return `TripoSR source cloned to ${srcPath}\n${cloneOut}`;
}

function getVenvSitePackages(): string | null {
  const venvPath = getVenvPath();
  // Windows: Lib/site-packages
  const winSp = path.join(venvPath, "Lib", "site-packages");
  if (fs.existsSync(winSp)) return winSp;
  // Unix: lib/python3.x/site-packages
  const libDir = path.join(venvPath, "lib");
  if (fs.existsSync(libDir)) {
    const pyDir = fs.readdirSync(libDir).find((d) => d.startsWith("python"));
    if (pyDir) {
      const unixSp = path.join(libDir, pyDir, "site-packages");
      if (fs.existsSync(unixSp)) return unixSp;
    }
  }
  return null;
}

/** Hard-delete numpy and any ABI-sensitive packages from site-packages before
 *  reinstalling. pip refuses to replace files that Windows still has locked,
 *  and silently leaves the old DLLs behind — that's exactly the failure mode
 *  causing the recurring "Expected 96, got 88" error. By removing the files
 *  ourselves (after tree-killing the backend) we guarantee pip's next install
 *  produces a clean, consistent package on disk.
 *
 *  IMPORTANT: pip on Windows also leaves stale `~`-prefixed remnant directories
 *  (e.g. `~umpy`, `~-mpy`, `~.mpy.libs`) when it can't fully rename/delete
 *  locked files during uninstall. These remnants contain OLD .pyd files that
 *  Windows DLL loading can pick up, causing the numpy ABI size mismatch.
 *  We remove ALL `~`-prefixed directories as a safety measure.
 */
async function purgeBinaryPackages(packageNames: string[]): Promise<string> {
  const sitePackages = getVenvSitePackages();
  if (!sitePackages) return "site-packages not found, skipping purge";

  const removed: string[] = [];
  const failed: string[] = [];

  let entries: string[] = [];
  try {
    entries = await fs.promises.readdir(sitePackages);
  } catch (err) {
    return `purge: readdir failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  for (const entry of entries) {
    // Match e.g. "numpy", "numpy-2.0.0.dist-info", "numpy.libs"
    const matchesPackage = packageNames.some(
      (pkg) =>
        entry === pkg ||
        entry === `${pkg}.libs` ||
        entry.startsWith(`${pkg}-`) ||
        entry.startsWith(`${pkg}.`),
    );

    // Match pip's stale remnant directories: ~umpy, ~-mpy, ~.mpy.libs, etc.
    // pip renames locked dirs to ~<random_prefix><suffix> on Windows when it
    // can't delete them. These contain old .pyd files that pollute DLL loading.
    const isStaleRemnant = entry.startsWith("~");

    if (!matchesPackage && !isStaleRemnant) continue;

    const fullPath = path.join(sitePackages, entry);
    try {
      await fs.promises.rm(fullPath, { recursive: true, force: true });
      removed.push(entry);
    } catch (err) {
      failed.push(
        `${entry} (${err instanceof Error ? err.message.split("\n")[0] : String(err)})`,
      );
    }
  }

  const summary = [
    `Purged ${removed.length} entries from ${sitePackages}`,
    removed.length ? `Removed: ${removed.join(", ")}` : "",
    failed.length ? `Failed: ${failed.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  logger.info(summary);
  return summary;
}

async function installTripoSrRuntime(
  pythonPath: string,
  backendPath: string,
  effectiveBackend: string,
): Promise<string> {
  // Step 0: Hard-purge ABI-sensitive packages from disk. pip's uninstall has
  // been failing to actually remove numpy's DLLs on the user's Windows machine
  // (file locks from a still-warm backend), so it "succeeds" but leaves the
  // old 1.x files in place. We bypass pip entirely and just delete the dirs.
  // This is safe because the next pip install will recreate them.
  const purgeReport = await purgeBinaryPackages([
    "numpy",
    // rembg + onnxruntime are now intentionally REINSTALLED below (after the
    // numpy 2.x stack is in place) so U2Net segmentation can run. We still
    // purge first because pip's uninstall on Windows leaves stale .pyd files
    // when the previous backend held them open.
    "rembg",
    "onnxruntime",
    // PyMCubes / mcubes are NOT reinstalled — we replaced them with the
    // scikit-image torchmcubes shim. Keep purging in case a previous broken
    // install still has them on disk.
    "PyMCubes",
    "mcubes",
    // pandas ships Cython extensions whose ABI is locked to the numpy used
    // at wheel-build time. TTS pulls pandas<2.0 (1.5.3, numpy-1.x ABI) which
    // crashes on import once numpy 2.x is installed. Purge it so we can
    // force a fresh, numpy-2.x-compatible wheel below.
    "pandas",
    // Pin huggingface_hub to avoid stuck 1.x install.
    "huggingface_hub",
  ]);

  // Step 1: Ensure numpy is 2.x BEFORE installing anything else. Without this,
  // pip's resolver can keep an existing numpy<2 because it satisfies most
  // packages' loose constraints — and then later imports of any wheel built
  // against numpy 2.x fail with "Expected 96 from C header, got 88". Forcing
  // numpy first means every wheel installed below will be picked to match.
  let numpyPrep = "";
  try {
    // Uninstall first as a belt-and-braces measure (purgeBinaryPackages should
    // already have wiped the files, but pip's metadata may still claim
    // something is installed).
    await runCommand(pythonPath, ["-m", "pip", "uninstall", "-y", "numpy"], {
      cwd: backendPath,
      timeoutMs: 5 * 60 * 1000,
    }).catch((err) => {
      logger.info("numpy uninstall returned non-zero (probably absent):", err);
    });
    numpyPrep = await runCommand(
      pythonPath,
      [
        "-m",
        "pip",
        "install",
        "--upgrade",
        "--no-cache-dir",
        "numpy>=2.0,<3.0",
      ],
      { cwd: backendPath, timeoutMs: 10 * 60 * 1000 },
    );
  } catch (err) {
    numpyPrep = `ERROR: numpy 2.x install failed: ${err instanceof Error ? err.message : String(err)}`;
    logger.error("numpy 2.x install failed:", err);
    throw new Error(numpyPrep);
  }

  // Step 2: PyPI dependencies. Now that numpy 2.x is already present, pip
  // picks wheels of rembg / onnxruntime / PyMCubes that were built against
  // numpy 2.x (older numpy-1-only wheels are no longer "best match").
  const runtimeInstall = await runCommand(
    pythonPath,
    [
      "-m",
      "pip",
      "install",
      "--upgrade",
      ...getTripoSrRuntimePackages(effectiveBackend).filter(
        (p) => !p.startsWith("numpy"),
      ),
    ],
    { cwd: backendPath, timeoutMs: 30 * 60 * 1000 },
  );

  // Step 3: TripoSR source. The upstream repo has no setup.py / pyproject.toml,
  // so `pip install git+...` fails with "does not appear to be a Python project".
  // We clone the repo into the user-data directory and add it to PYTHONPATH
  // via getBackendEnvironment() so `from tsr.system import TSR` resolves.
  let srcInstall = "";
  try {
    srcInstall = await cloneOrUpdateTripoSrSrc();
  } catch (err) {
    srcInstall = `ERROR: failed to fetch TripoSR source: ${err instanceof Error ? err.message : String(err)}`;
    logger.error("Failed to clone TripoSR source:", err);
    throw new Error(srcInstall);
  }

  // Step 4: 3D shims (torchmcubes & rembg).
  //   • The real torchmcubes package compiles CUDA kernels and needs a build
  //     toolchain that most Windows machines don't have. Our shim re-exports
  //     scikit-image marching_cubes under the same module name.
  //   • The real rembg package depends on onnxruntime and other native DLLs
  //     which cause constant numpy ABI mismatches on Windows. Our shim resolves
  //     its top-level import since OrianBuilder uses a PIL-based alternative.
  let shimWrite = "";
  try {
    shimWrite = await writeThreeDShims();
  } catch (err) {
    shimWrite = `ERROR: failed to write 3D shims: ${err instanceof Error ? err.message : String(err)}`;
    logger.error("Failed to write 3D shims:", err);
    throw new Error(shimWrite);
  }

  // Step 5: numpy safety net. If the pip resolver above silently downgraded
  // numpy (a buggy older wheel of rembg can pin numpy<2), force-reinstall the
  // 2.x version back. --no-deps prevents pip from pulling anything else down
  // with it.
  let numpyRepair = "";
  try {
    numpyRepair = await runCommand(
      pythonPath,
      [
        "-m",
        "pip",
        "install",
        "--upgrade",
        "--force-reinstall",
        "--no-cache-dir",
        "--no-deps",
        "numpy>=2.0,<3.0",
      ],
      { cwd: backendPath, timeoutMs: 10 * 60 * 1000 },
    );
  } catch (err) {
    numpyRepair = `Warning: numpy repair failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`;
    logger.warn("numpy repair failed:", err);
  }

  // Step 5b: force-reinstall every package whose wheel must be ABI-compatible
  // with the installed numpy. If any of these were installed earlier against a
  // different numpy (which is exactly the bug the user keeps hitting), pip's
  // --upgrade is a no-op when the version number hasn't changed — only
  // --force-reinstall --no-cache-dir actually fetches a fresh wheel.
  let abiRepair = "";
  try {
    abiRepair = await runCommand(
      pythonPath,
      [
        "-m",
        "pip",
        "install",
        "--force-reinstall",
        "--no-cache-dir",
        // --no-deps prevents pandas from dragging in a numpy<2 because of
        // TTS's transitive metadata constraint (TTS pins pandas<2.0).
        "--no-deps",
        "scikit-image>=0.21.0",
        "huggingface-hub>=0.34.0,<1.0",
        "trimesh>=4.0.0",
        "pandas>=2.2.2",
      ],
      { cwd: backendPath, timeoutMs: 20 * 60 * 1000 },
    );
  } catch (err) {
    abiRepair = `Warning: ABI repair (mcubes/onnxruntime/rembg/trimesh) failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`;
    logger.warn("ABI repair failed:", err);
  }

  // Step 6: end-to-end ABI smoke test. Import torch FIRST — the real backend
  // loads torch via the hardware module before trimesh/skimage. If torch's DLLs
  // were compiled against numpy 1.x, the "dtype size changed" crash only appears
  // when torch is already loaded. Without torch in the smoke test, we get a
  // false-pass and the user sees the crash during actual generation.
  let numpyVerify = "";
  try {
    const versionOut = await runCommand(
      pythonPath,
      [
        "-c",
        "import sys; " +
          "import torch; print('torch', torch.__version__); " +
          "import numpy; print('numpy', numpy.__version__, numpy.__file__); " +
          "import huggingface_hub; print('huggingface_hub', huggingface_hub.__version__); " +
          "import skimage; print('scikit-image', skimage.__version__); " +
          "from skimage.measure import marching_cubes; print('marching_cubes OK'); " +
          "import trimesh; print('trimesh', trimesh.__version__); " +
          // pandas import exercises its Cython _libs against the current
          // numpy ABI — the exact failure path that crashed 3D generation
          // when pandas<2.0 was left over from a TTS install.
          "import pandas; print('pandas', pandas.__version__); " +
          "from pandas._libs.interval import Interval; print('pandas._libs OK'); " +
          // rembg + onnxruntime are needed for U2Net background segmentation,
          // which is the single biggest mesh-quality lever in the 3D pipeline.
          // A broken install would silently fall back to PIL flood-fill (less
          // accurate) — check up front so we can flag it during setup.
          "import onnxruntime; print('onnxruntime', onnxruntime.__version__); " +
          "import rembg; print('rembg', rembg.__version__); " +
          "hf_ver = tuple(int(x) for x in huggingface_hub.__version__.split('.')[:2]); " +
          "assert (0, 34) <= hf_ver < (1, 0), f'huggingface_hub out of range: {huggingface_hub.__version__}'; " +
          "pd_ver = tuple(int(x) for x in pandas.__version__.split('.')[:2]); " +
          "assert pd_ver >= (2, 2), f'pandas too old for numpy 2.x ABI: {pandas.__version__}'; " +
          "ver = tuple(int(x) for x in numpy.__version__.split('.')[:2]); " +
          "sys.exit(0) if ver >= (2, 0) else sys.exit(f'numpy too old: {numpy.__version__}')",
      ],
      { cwd: backendPath, timeoutMs: 2 * 60_000 },
    );
    numpyVerify = `ABI smoke test passed:\n${versionOut}`;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    numpyVerify = `ERROR: ABI smoke test failed:\n${detail}`;
    logger.error("ABI smoke test failed:", err);
    throw new Error(numpyVerify);
  }

  return `${purgeReport}\n${numpyPrep}\n${runtimeInstall}\n${srcInstall}\n${shimWrite}\n${numpyRepair}\n${abiRepair}\n${numpyVerify}`;
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
    depsInstalled: areBaseDepsInstalled(),
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
          // gguf is required for the z-image-turbo-gguf tier — without it,
          // diffusers' from_single_file falls back to a torch checkpoint loader
          // and crashes with "Unable to load weights from checkpoint file".
          "gguf>=0.10.0",
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

  // TripoSR is optional — if its install fails we still want music/image/etc.
  // to keep working, so wrap it the same way ACE-Step does for its optional
  // packages.
  let tripoSrInstall = "";
  try {
    tripoSrInstall = await installTripoSrRuntime(
      pythonPath,
      backendPath,
      effectiveBackend,
    );
  } catch (err) {
    tripoSrInstall = `Warning: TripoSR runtime install failed: ${err instanceof Error ? err.message : String(err)}`;
    logger.warn("TripoSR install failed:", err);
  }

  if (effectiveBackend !== "cpu") {
    writeGpuMarker(effectiveBackend);
  }

  return trimOutput(
    `${venvSetup}\n${pipUpgrade}\n${baseInstall}\n${coreInstall}\n${requirementsInstall}\n${aceStepInstall}\n${tripoSrInstall}`,
  );
}

/** Installs ONLY the TripoSR runtime into the existing Media AI venv. Used by
 *  the 3D Assets page so a user who already set up Media AI for image/music
 *  can add 3D generation without reinstalling everything else. */
export async function installThreeDRuntimeOnly(
  backend?: string,
): Promise<string> {
  const backendPath = resolveMediaAiBackendPath();
  await ensureCompatibleMediaAiVenv(backendPath);

  const pythonPath = getVenvPythonPath();
  const effectiveBackend =
    backend ?? cachedHardwareProfile?.bestMediaBackend ?? "cpu";

  logger.info(
    `Installing TripoSR runtime for backend "${effectiveBackend}" into existing venv`,
  );

  return installTripoSrRuntime(pythonPath, backendPath, effectiveBackend);
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

  let tripoSrInstall = "";
  try {
    tripoSrInstall = await installTripoSrRuntime(
      pythonPath,
      backendPath,
      cachedHardwareProfile?.bestMediaBackend ?? "cpu",
    );
  } catch (err) {
    tripoSrInstall = `Warning: TripoSR runtime install failed: ${err instanceof Error ? err.message : String(err)}`;
    logger.warn("TripoSR install failed:", err);
  }

  return trimOutput(
    `${venvSetup}\n${pipUpgrade}\n${baseInstall}\n${coreInstall}\n${requirementsInstall}\n${aceStepInstall}\n${tripoSrInstall}`,
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
  onLog?: (chunk: string) => void,
): Promise<string> {
  const backendPath = resolveMediaAiBackendPath();
  const scriptPath = path.join(backendPath, "scripts", "download_models.py");
  const env = getBackendEnvironment();

  // If the download produces NO output for this long it is considered stalled
  // (e.g. a hung HuggingFace socket on flaky Wi-Fi — exactly the case that froze
  // an Orion run). We then kill it and reject so the caller can proceed (the
  // model falls back to an on-demand download at generation time) rather than
  // blocking forever. hf_transfer emits progress frequently while alive, so a
  // multi-minute silence reliably means "stuck", not "slow".
  const STALL_TIMEOUT_MS = 4 * 60 * 1000;

  return new Promise<string>((resolve, reject) => {
    const child = spawn(getPythonCommand(), [scriptPath, ...models], {
      cwd: backendPath,
      env,
      shell: false,
      windowsHide: true,
    });
    activeDownloadProcess = child;
    appendLog(`Starting download: ${models.join(", ")}\n`);
    onLog?.(`Starting download: ${models.join(", ")}`);

    let output = "";
    let stalled = false;
    let stallTimer: NodeJS.Timeout;
    const resetStall = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        stalled = true;
        const msg = `Download stalled: no progress for ${STALL_TIMEOUT_MS / 1000}s — aborting (will retry on demand).`;
        appendLog(`\n${msg}\n`);
        onLog?.(msg);
        if (child.pid) treeKill(child.pid, "SIGKILL");
        else child.kill();
      }, STALL_TIMEOUT_MS);
    };
    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      appendLog(text);
      onLog?.(text);
      resetStall();
    };
    resetStall();
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("close", (code) => {
      clearTimeout(stallTimer);
      activeDownloadProcess = null;
      if (stalled) {
        reject(
          new Error(
            `Download stalled (no progress for ${STALL_TIMEOUT_MS / 1000}s) and was aborted.`,
          ),
        );
      } else if (code === 0 || code === null) {
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
      clearTimeout(stallTimer);
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
  // Reset crash counter on every intentional (re)start so we always allow
  // at least MAX_CRASH_RESTARTS auto-recoveries from the next crash.
  _crashRestartCount = 0;
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
    ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8001"],
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
    // Capture and immediately reset the intentional-stop flag so the next
    // start/stop cycle is unaffected.
    const wasIntentional = _intentionalStop;
    _intentionalStop = false;
    pythonServer = null;

    // Auto-restart only on unexpected crashes — not on intentional SIGKILL.
    // stopMediaAiBackend() sets _intentionalStop = true before sending SIGKILL
    // so we can distinguish the two cases even though both produce non-zero codes.
    const isCrash = !wasIntentional && code !== 0 && code !== null;
    if (isCrash && _crashRestartCount < MAX_CRASH_RESTARTS) {
      _crashRestartCount++;
      const delay = 3000;
      logger.warn(
        `Media AI backend crashed (code ${code}), scheduling auto-restart ` +
          `(attempt ${_crashRestartCount}/${MAX_CRASH_RESTARTS}) in ${delay}ms…`,
      );
      setTimeout(() => {
        startMediaAiBackend().catch((err) => {
          logger.error("Media AI backend auto-restart failed:", err);
        });
      }, delay);
    }
  });
}

export function stopMediaAiBackend() {
  if (!pythonServer) {
    return;
  }
  logger.info("Stopping Media AI backend...");
  // Mark as intentional so the close handler doesn't schedule an auto-restart.
  _intentionalStop = true;
  // On Windows, uvicorn / python can have child processes (reloader workers,
  // OMP threads holding native DLLs) that survive a plain .kill(). tree-kill
  // takes the entire process tree down with SIGKILL so pip can replace the
  // numpy DLLs on the next install.
  const pid = pythonServer.pid;
  if (pid !== undefined) {
    treeKill(pid, "SIGKILL", (err) => {
      if (err) {
        logger.warn(`tree-kill failed for pid=${pid}:`, err);
      }
    });
  }
  // Defensive: also call the built-in kill() in case treeKill didn't catch
  // the immediate child.
  try {
    pythonServer.kill("SIGKILL");
  } catch {
    /* already dead */
  }
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
