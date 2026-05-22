# OrianBuilder — Multi-Vendor Hardware Inference Plan

**Status:** Planning phase  
**Priority:** Windows + macOS (Apple Silicon M-series) first → Linux later  
**Principle:** Proprietary best-in-class backend per vendor. No universal abstraction layers at inference time. Performance > portability.

---

## Hardware Target Matrix

| OS      | GPU Vendor     | LLM Backend            | Image Backend                        | Audio Backend |
| ------- | -------------- | ---------------------- | ------------------------------------ | ------------- |
| Windows | Nvidia         | CUDA (node-llama-cpp)  | PyTorch+CUDA+diffusers               | PyTorch CUDA  |
| Windows | AMD            | Vulkan (llama.cpp)     | PyTorch-DirectML or ONNX DirectML EP | ONNX DirectML |
| Windows | Intel Arc/iGPU | Vulkan (llama.cpp)     | OpenVINO EP or ONNX DirectML         | OpenVINO      |
| Windows | CPU-only       | AVX2 llama.cpp         | ONNX CPU EP                          | ONNX CPU      |
| macOS   | Apple Silicon  | Metal (node-llama-cpp) | MPS (diffusers) or MLX               | MPS           |
| macOS   | Intel Mac      | CPU                    | CPU                                  | CPU           |
| Linux   | Nvidia         | CUDA                   | CUDA                                 | CUDA          |
| Linux   | AMD            | ROCm                   | PyTorch ROCm                         | ROCm          |
| Linux   | Intel          | SYCL/oneAPI            | OpenVINO                             | OpenVINO      |

---

## Phase 0 — Hardware Detection Foundation

**Effort:** ~1–2 days  
**Goal:** Single `HardwareProfile` object cached at startup. Every downstream decision derives from it.

### Files to create

| File                                    | Purpose                     |
| --------------------------------------- | --------------------------- |
| `src/main/hardware/types.ts`            | TypeScript interfaces       |
| `src/main/hardware/detect.ts`           | Detection logic             |
| `src/ipc/types/hardware.ts`             | IPC contracts + Zod schemas |
| `src/ipc/handlers/hardware_handlers.ts` | IPC handler registration    |

### TypeScript interface

```typescript
export interface GpuInfo {
  vendor: "nvidia" | "amd" | "intel" | "apple" | "unknown";
  model: string;
  vramMb: number;
  isIntegrated: boolean;
}

export interface HardwareProfile {
  os: "windows" | "macos" | "linux";
  arch: "x64" | "arm64";
  cpu: {
    vendor: "amd" | "intel" | "apple" | "unknown";
    model: string;
    cores: number;
    logicalCores: number;
  };
  gpus: GpuInfo[];
  primaryGpu: GpuInfo | null; // highest-VRAM discrete GPU
  totalRamMb: number;
  availableBackends: Array<
    "cuda" | "rocm" | "metal" | "vulkan" | "directml" | "openvino" | "cpu"
  >;
  bestLlmBackend: "cuda" | "rocm" | "metal" | "vulkan" | "cpu";
  bestMediaBackend: "cuda" | "rocm" | "metal" | "directml" | "openvino" | "cpu";
}
```

### Detection methods

**Windows GPU list:**

```
wmic path win32_videocontroller get name,adapterram /format:csv
```

Then for Nvidia VRAM accuracy:

```
nvidia-smi --query-gpu=name,memory.total --format=csv,noheader
```

**Windows backend availability checks:**

- CUDA: `nvidia-smi` exits 0
- ROCm: `rocm-smi` exits 0 OR AMD ROCm DLL present
- DirectML: Windows 10 build ≥ 18362 (1903) — always available on Win10/11
- OpenVINO: `mo --version` exits 0 OR `igdext64.dll` present
- Vulkan: `vulkaninfo --summary` exits 0

**macOS:**

```
system_profiler SPHardwareDataType -json    → detect Apple Silicon
system_profiler SPDisplaysDataType -json   → GPU info
```

Metal always available on M-series.

**CPU info (all platforms):** Node.js `os.cpus()` + `os.totalmem()`

### IPC channels

```
hardware:get-profile    → cached profile (fast)
hardware:refresh-profile → re-runs detection (slow, on demand)
```

### UI addition

Engine page (`src/pages/inference.tsx`): read-only card showing:

- Primary GPU name + VRAM bar
- Detected backend badges (CUDA / Metal / DirectML / etc.)
- Best LLM backend / Best Media backend

---

## Phase 1 — Smart Model Orchestrator

**Effort:** ~1 week  
**Goal:** Fully autonomous LLM↔media swap with zero user intervention.

### Files to create

| File                                       | Purpose                    |
| ------------------------------------------ | -------------------------- |
| `src/main/ipc/utils/model_orchestrator.ts` | State machine core         |
| `src/main/ipc/utils/vram_accounting.ts`    | Live VRAM query per vendor |
| `src/ipc/types/model_orchestrator.ts`      | Types + IPC contracts      |

### State machine

```
idle
  → llm-loading       (acquireLlm called)
  → llm-loaded        (model is in VRAM, inference available)
  → swapping-out      (generate_X tool fired — captures request, begins unload)
  → media-loading     (LLM unloaded, starting media model)
  → media-loaded      (generation running)
  → swapping-back     (generation done, unloading media model)
  → llm-loaded        (LLM back in VRAM, agent resumes)
```

### Core interface

```typescript
interface ModelOrchestrator {
  acquireLlm(modelPath: string, params: LlmLoadParams): Promise<void>;

  // Called by agent tools — handles full swap lifecycle
  runMediaGeneration(
    request: MediaGenerationRequest,
  ): Promise<MediaGenerationResult>;

  releaseAll(): Promise<void>;
  getStatus(): OrchestratorStatus;
}

interface MediaGenerationRequest {
  modelType: "image" | "audio" | "video" | "music";
  prompt: string;
  outputPath: string;
  options?: Record<string, unknown>;
}
```

### VRAM accounting per vendor (`vram_accounting.ts`)

```typescript
async function getCurrentVramUsageMb(
  vendor: GpuInfo["vendor"],
): Promise<number>;
```

- **Nvidia:** parse `nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits`
- **AMD Windows:** parse `rocm-smi --showmeminfo vram` or WMI `AdapterRAM`
- **AMD Linux:** parse `rocm-smi`
- **Intel:** DXGI query via PowerShell helper
- **Apple:** `vm_stat` + model total RAM estimation
- **Fallback:** estimate from model file size × quant multiplier

### Auto-tune LLM params formula

```typescript
function calculateOptimalLlmParams(
  modelSizeGb: number,
  quantLevel: string, // "q4_k_m", "q6_k", "q8_0", ...
  gpuVramMb: number,
  desiredContextTokens: number,
): LlmLoadParams {
  const SAFETY_HEADROOM_MB = 512;
  const effectiveVram = gpuVramMb - SAFETY_HEADROOM_MB;
  const weightsMb = modelSizeGb * 1024;
  // kv cache ≈ 2 * layers * heads * head_dim * 2 bytes * context / 1024^2
  // gpu_layers = floor(effectiveVram * 0.85 / (weightsMb / totalLayers))
}
```

### Agent tool update

`src/pro/main/ipc/handlers/local_agent/tools/generate_image.ts` (create if missing): call `orchestrator.runMediaGeneration()`. The orchestrator captures the full request _before_ the LLM is unloaded, then injects the result back as a tool result after reload.

---

## Phase 2 — Multi-Vendor Media Backend

**Effort:** ~1–2 weeks  
**Goal:** Replace CPU-only SD 1.5 with vendor-accelerated models.

### Architecture stays the same

Python FastAPI subprocess spawned from `src/ipc/utils/media_ai_backend.ts`. Pass `ORIANBUILDER_HARDWARE_BACKEND=cuda|rocm|directml|openvino|mps|cpu` via env.

### Split requirements files

```
mediaai-backend/requirements-base.txt      → FastAPI, httpx, Pillow — no ML
mediaai-backend/requirements-cuda.txt      → torch+cu128, diffusers, xformers
mediaai-backend/requirements-rocm.txt      → torch+rocm62, diffusers
mediaai-backend/requirements-directml.txt  → torch-directml, onnxruntime-directml
mediaai-backend/requirements-openvino.txt  → optimum-intel, openvino
mediaai-backend/requirements-mps.txt       → torch (MPS built-in), diffusers
mediaai-backend/requirements-cpu.txt       → onnxruntime, diffusers (CPU only)
```

Install only the matching file at setup time.

### Image model tiers

```python
IMAGE_MODELS = {
    "flux-schnell": {
        "repo": "black-forest-labs/FLUX.1-schnell",
        "vram_required_mb": 12000,
        "backends": ["cuda", "rocm", "mps"],
    },
    "sdxl-turbo": {
        "repo": "stabilityai/sdxl-turbo",
        "vram_required_mb": 8000,
        "backends": ["cuda", "rocm", "mps", "directml"],
    },
    "sd-1.5": {
        "repo": "runwayml/stable-diffusion-v1-5",
        "vram_required_mb": 4000,
        "backends": ["cuda", "rocm", "mps", "directml", "openvino", "cpu"],
    },
}

MUSIC_MODELS = {
    "yue-7b-fp16": {
        "repo": "multimodal-art-projection/YuE",
        "vram_required_mb": 16000,
        "backends": ["cuda"]
    },
    "ace-step-1.5-llm-dit": {
        "repo": "ace-step/ACE-Step-1.5",
        "vram_required_mb": 6000,
        "backends": ["cuda", "rocm", "mps", "cpu"]
    },
    "diffrhythm": {
        "repo": "ASLP-lab/DiffRhythm",
        "vram_required_mb": 6000,
        "backends": ["cuda", "mps", "cpu"]
    },
    "ace-step-1.5-dit-only": {
        "repo": "ace-step/ACE-Step-1.5",
        "vram_required_mb": 4000,
        "backends": ["cuda", "rocm", "mps", "cpu"]
    }
}
```

### New API endpoints

```
POST /v1/generate/image
POST /v1/generate/audio/tts
POST /v1/generate/audio/music
POST /v1/transcribe
GET  /v1/models/available
POST /v1/models/load
POST /v1/models/unload
```

### New model targets

| Type           | Model            | VRAM    |
| -------------- | ---------------- | ------- |
| Image fast     | FLUX.1 [schnell] | ~12 GB  |
| Image quality  | FLUX.1 [dev]     | ~20 GB  |
| Image fallback | SDXL Turbo       | ~8 GB   |
| STT            | Whisper large-v3 | ~1.5 GB |
| TTS fast       | Piper TTS        | CPU     |
| TTS quality    | XTTS-v2          | ~3 GB   |
| Music max      | YuE 7B           | ~16 GB  |
| Music fast     | ACE-Step 1.5 LLM | ~6 GB   |
| Music fallback | ACE-Step 1.5 DiT | ~4 GB   |
| Video fast     | LTX-Video        | ~12 GB  |

---

## Phase 3 — Model Auto-Scaling

**Effort:** ~3–5 days  
**Goal:** Orchestrator picks best model tier that fits after LLM unload. Graceful degradation.

```typescript
const IMAGE_MODEL_TIERS = [
  { id: "flux-schnell", vramRequiredMb: 12000, quality: "best" },
  { id: "sdxl-turbo", vramRequiredMb: 8000, quality: "good" },
  { id: "sd-1.5", vramRequiredMb: 4000, quality: "basic" },
  { id: "sd-1.5-cpu", vramRequiredMb: 0, quality: "slow" },
];

function pickBestTier(
  tiers: typeof IMAGE_MODEL_TIERS,
  availableVramMb: number,
) {
  return (
    tiers.find((t) => t.vramRequiredMb <= availableVramMb) ?? tiers.at(-1)!
  );
}
```

---

## Phase 4 — LLM Multi-Vendor (node-llama-cpp)

**Effort:** ~3–5 days  
**Scope:** node-llama-cpp ships prebuilt binaries for CUDA, Metal, Vulkan, CPU. Wire backend selection to HardwareProfile.

- AMD/Intel Windows → Vulkan prebuilt (already in node-llama-cpp)
- AMD Linux → ROCm build (community binaries or compile)
- Apple Silicon → Metal (already first-class)
- Intel CPU → AVX2 CPU build

**Key file:** `src/ipc/utils/embedded_inference_server.ts` — add backend selection at model-load time.

---

## Rules (non-negotiable)

1. **DO NOT** change existing Nvidia/CUDA code paths — they work, leave them alone
2. **DO NOT** use universal ONNX-only where a vendor-specific backend is faster
3. **DO NOT** add cloud inference code yet
4. Windows + macOS (M-series) first — Linux is a future phase
5. After every file change: `npx tsc --noEmit` must pass
6. After every logical unit: `npx vitest run` must pass
7. The orchestrator is fully autonomous — zero user prompts during agent build sessions
8. Python dependencies are split per vendor — no single monolithic requirements.txt
9. Each phase committed separately

---

## Implementation Order

```
Phase 0 (hardware detection) → foundation for everything
Phase 1 (orchestrator) with stub media → state machine proven
Phase 2 (real media models) → swap stub with real GPU paths
Phase 3 (auto-scaling) → extend orchestrator with tier logic
Phase 4 (LLM multi-vendor) → lowest priority, can run parallel with Phase 3
```
