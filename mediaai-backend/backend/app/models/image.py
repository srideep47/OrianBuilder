"""Tiered image generation. Picks the best diffusion model that fits in
the active backend's VRAM, falls back through the tier list down to a
CPU-only ONNX SD 1.5.

Tier order matters: pick_best_tier walks the list top-to-bottom and
returns the first tier whose vram_mb fits the live VRAM budget.
"""

from __future__ import annotations

import gc
import io
import logging
import os
from typing import Optional, TypedDict

from ..hardware import get_backend, get_torch_device, get_torch_dtype, get_vram_mb

log = logging.getLogger(__name__)


class ImageTier(TypedDict):
    id: str
    repo: Optional[str]
    vram_mb: int
    download_size_mb: int
    backends: list[str]
    label: str


# Mirrors src/shared/media_tiers.ts IMAGE_MODEL_TIERS.
# When you add/remove a tier here, mirror the change there or the UI will
# show stale options.
IMAGE_MODEL_TIERS: list[ImageTier] = [
    {
        # GGUF Q4_1 local file — place at $OMNIGEN_MODELS_DIR/z-image-turbo-Q4_1.gguf
        # Uses stable-diffusion-cpp-python (CPU/CUDA). Selected first when file exists.
        "id": "z-image-turbo-gguf",
        "label": "Z Image Turbo Q4_1 (GGUF)",
        "repo": None,
        "vram_mb": 0,
        "download_size_mb": 0,
        "backends": ["cuda", "rocm", "metal", "mps", "directml", "cpu"],
    },
    {
        "id": "flux-dev",
        "label": "FLUX.1 dev",
        "repo": "black-forest-labs/FLUX.1-dev",
        "vram_mb": 24000,
        "download_size_mb": 24000,
        "backends": ["cuda", "rocm", "metal", "mps"],
    },
    {
        "id": "flux-schnell",
        "label": "FLUX.1 schnell",
        "repo": "black-forest-labs/FLUX.1-schnell",
        "vram_mb": 12000,
        "download_size_mb": 24000,
        "backends": ["cuda", "rocm", "metal", "mps"],
    },
    {
        # 1-step SDXL — 1024×1024, much better quality than SD Turbo, fits 6 GB.
        "id": "sdxl-turbo",
        "label": "SDXL Turbo",
        "repo": "stabilityai/sdxl-turbo",
        "vram_mb": 6000,
        "download_size_mb": 7000,
        "backends": ["cuda", "rocm", "metal", "mps", "directml"],
    },
    {
        # 1-step turbo fallback for GPUs under 6 GB.
        "id": "sd-turbo",
        "label": "SD Turbo",
        "repo": "stabilityai/sd-turbo",
        "vram_mb": 3000,
        "download_size_mb": 1700,
        "backends": ["cuda", "rocm", "metal", "mps", "directml"],
    },
    {
        # 8-step model — needs 8 GB+ VRAM for GPU inference; CPU-offload on 6 GB.
        "id": "z-image-turbo",
        "label": "Z Image Turbo",
        "repo": "Tongyi-MAI/Z-Image-Turbo",
        "vram_mb": 8000,
        "download_size_mb": 12000,
        "backends": ["cuda", "rocm", "metal", "mps"],
    },
    {
        "id": "sd-1.5",
        "label": "Stable Diffusion 1.5",
        "repo": "runwayml/stable-diffusion-v1-5",
        "vram_mb": 4000,
        "download_size_mb": 4000,
        "backends": ["cuda", "rocm", "metal", "mps", "directml"],
    },
    {
        "id": "sd-1.5-onnx-cpu",
        "label": "SD 1.5 ONNX (CPU)",
        "repo": "nmkd/stable-diffusion-1.5-onnx-fp16",
        "vram_mb": 0,
        "download_size_mb": 2500,
        "backends": ["cpu", "openvino", "directml"],
    },
]


def _gguf_path() -> str:
    models_dir = os.getenv("OMNIGEN_MODELS_DIR", "")
    return os.path.join(models_dir, "z-image-turbo-Q4_1.gguf")


def pick_best_tier(forced_tier_id: Optional[str] = None) -> ImageTier:
    if forced_tier_id:
        for tier in IMAGE_MODEL_TIERS:
            if tier["id"] == forced_tier_id:
                return tier
    backend = get_backend()
    vram = get_vram_mb()
    for tier in IMAGE_MODEL_TIERS:
        if tier["id"] == "z-image-turbo-gguf":
            # Loaded via diffusers Lumina2Transformer2DModel + GGUFQuantizationConfig.
            # Transformer weights come from the local GGUF; VAE + text encoder are
            # fetched from HuggingFace on first run and cached.
            if os.path.isfile(_gguf_path()) and backend in tier["backends"]:
                return tier
            continue
        if backend in tier["backends"] and tier["vram_mb"] <= vram:
            return tier
    return IMAGE_MODEL_TIERS[-1]


_pipeline = None
_pipeline_tier_id: Optional[str] = None
_pipeline_device: Optional[str] = None   # track which device the cache is on


def _enable_memory_savers(pipe) -> None:
    """Apply the cheapest memory savers that don't hurt quality.
    These are no-ops for models that don't support them."""
    for fn_name in (
        "enable_attention_slicing",
        "enable_vae_slicing",
        "enable_vae_tiling",
    ):
        fn = getattr(pipe, fn_name, None)
        if callable(fn):
            try:
                fn()
            except Exception:  # noqa: BLE001 — savers are optional
                pass


def get_pipeline(forced_tier_id: Optional[str] = None):
    """Lazy-load the appropriate pipeline for the active backend.
    Returns the cached instance after the first call. When forced_tier_id is
    given, replaces the cache with that tier.

    The cache is keyed on BOTH tier id AND device so a CPU-cached pipeline is
    evicted and reloaded on GPU when CUDA becomes available (e.g. after the
    first generation triggered auto-detection of CUDA via torch).
    """
    global _pipeline, _pipeline_tier_id, _pipeline_device

    tier = pick_best_tier(forced_tier_id)
    device = get_torch_device()
    dtype = get_torch_dtype()

    if (
        _pipeline is not None
        and _pipeline_tier_id == tier["id"]
        and _pipeline_device == device
    ):
        return _pipeline

    if _pipeline is not None:
        log.info(
            "evicting cached pipeline (was %s on %s, need %s on %s)",
            _pipeline_tier_id, _pipeline_device, tier["id"], device,
        )
        unload_pipeline()
    log.info(
        "loading image tier id=%s repo=%s device=%s dtype=%s",
        tier["id"],
        tier["repo"],
        device,
        dtype,
    )

    if tier["id"] == "z-image-turbo-gguf":
        import torch  # type: ignore
        try:
            from diffusers import GGUFQuantizationConfig, ZImagePipeline  # type: ignore
            from diffusers import ZImageTransformer2DModel  # type: ignore
        except ImportError as _imp_err:
            raise RuntimeError(
                "diffusers>=0.33.0 is required for the z-image-turbo-gguf tier. "
                "Run: pip install -U 'diffusers>=0.33.0'"
            ) from _imp_err
        # The gguf parser is a runtime dependency of GGUFQuantizationConfig.
        # Without it, diffusers silently falls back to torch's safetensors
        # loader and crashes with "Unable to load weights from checkpoint file"
        # — which gives the user no clue what to install. Check up front.
        try:
            import gguf  # type: ignore  # noqa: F401
        except ImportError as _imp_err:
            raise RuntimeError(
                "The 'gguf' Python package is required to load Z-Image-Turbo "
                "GGUF weights. Click 'Reinstall Dependencies' on the Media AI "
                "page, or run: pip install 'gguf>=0.10.0'"
            ) from _imp_err

        _hf_model_dir = os.path.join(
            os.getenv("HF_HOME", ""),
            "hub", "models--Tongyi-MAI--Z-Image-Turbo",
        )
        _snaps_dir = os.path.join(_hf_model_dir, "snapshots")
        _snaps = sorted(os.listdir(_snaps_dir)) if os.path.isdir(_snaps_dir) else []
        if not _snaps:
            raise RuntimeError(
                "Z-Image-Turbo HF snapshot not found. Re-download the model from the Media AI page."
            )
        transformer_cfg = os.path.join(_hf_model_dir, "snapshots", _snaps[-1], "transformer")
        active_backend = get_backend()
        compute_dtype = torch.bfloat16 if active_backend != "cpu" else torch.float32

        # Load quantised transformer from local GGUF; text encoder + VAE come
        # from the already-cached HuggingFace snapshot (no download needed).
        transformer = ZImageTransformer2DModel.from_single_file(
            _gguf_path(),
            config=transformer_cfg,
            quantization_config=GGUFQuantizationConfig(compute_dtype=compute_dtype),
            torch_dtype=compute_dtype,
        )
        pipe = ZImagePipeline.from_pretrained(
            "Tongyi-MAI/Z-Image-Turbo",
            transformer=transformer,
            torch_dtype=compute_dtype,
        )
        if active_backend == "cuda":
            pipe.enable_model_cpu_offload()
        else:
            pipe = pipe.to(device)
        _enable_memory_savers(pipe)
    elif tier["id"] == "flux-dev":
        from diffusers import FluxPipeline  # type: ignore
        import torch  # type: ignore

        pipe = FluxPipeline.from_pretrained(
            tier["repo"], torch_dtype=torch.bfloat16
        )
        pipe = pipe.to(device)
        # FLUX dev is large — enable CPU offload when we're tight on VRAM.
        if get_vram_mb() < 32000 and device == "cuda":
            try:
                pipe.enable_model_cpu_offload()
            except Exception:  # noqa: BLE001
                pass
        _enable_memory_savers(pipe)
    elif tier["id"] == "flux-schnell":
        from diffusers import FluxPipeline  # type: ignore
        import torch  # type: ignore

        pipe = FluxPipeline.from_pretrained(
            tier["repo"], torch_dtype=torch.bfloat16
        )
        pipe = pipe.to(device)
        if get_vram_mb() < 16000 and device == "cuda":
            try:
                pipe.enable_model_cpu_offload()
            except Exception:  # noqa: BLE001
                pass
        _enable_memory_savers(pipe)
    elif tier["id"] == "z-image-turbo":
        from diffusers import DiffusionPipeline  # type: ignore

        pipe = DiffusionPipeline.from_pretrained(
            tier["repo"],
            torch_dtype=dtype,
        )
        # 6 GB GPUs are tight — use CPU offload so VRAM isn't exceeded.
        if get_vram_mb() <= 6500 and device == "cuda":
            try:
                pipe.enable_model_cpu_offload()
            except Exception:  # noqa: BLE001
                pipe = pipe.to(device)
        else:
            pipe = pipe.to(device)
        _enable_memory_savers(pipe)
    elif tier["id"] == "sd-turbo":
        from diffusers import AutoPipelineForText2Image  # type: ignore

        pipe = AutoPipelineForText2Image.from_pretrained(
            tier["repo"], torch_dtype=dtype, variant="fp16"
        )
        pipe = pipe.to(device)
        _enable_memory_savers(pipe)
    elif tier["id"] == "sdxl-turbo":
        from diffusers import AutoPipelineForText2Image  # type: ignore

        pipe = AutoPipelineForText2Image.from_pretrained(
            tier["repo"], torch_dtype=dtype, variant="fp16"
        )
        pipe = pipe.to(device)
        _enable_memory_savers(pipe)
    elif tier["id"] == "sd-1.5":
        from diffusers import StableDiffusionPipeline  # type: ignore

        pipe = StableDiffusionPipeline.from_pretrained(
            tier["repo"], torch_dtype=dtype, safety_checker=None
        )
        pipe = pipe.to(device)
        _enable_memory_savers(pipe)
    else:
        # CPU/ONNX fallback — defer to the existing service so we don't duplicate
        # ORT + DirectML wiring.
        from ..services.image_generation import image_generation_service

        pipe = image_generation_service  # provider-style adapter

    _pipeline = pipe
    _pipeline_tier_id = tier["id"]
    _pipeline_device = device
    return _pipeline


def unload_pipeline() -> None:
    global _pipeline, _pipeline_tier_id, _pipeline_device
    _pipeline = None
    _pipeline_tier_id = None
    _pipeline_device = None
    gc.collect()
    try:
        import torch  # type: ignore

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except ImportError:
        pass


def _generation_params(tier_id: str, steps: int, guidance: float, w: int, h: int) -> dict:
    """Per-tier sane defaults. Turbo / schnell / Z Image Turbo all use
    very low step counts and low/no guidance."""
    if tier_id == "z-image-turbo-gguf":
        return {
            "num_inference_steps": max(4, min(steps, 8)),
            "guidance_scale": 4.0,
            "width": w,
            "height": h,
        }
    if tier_id in ("sd-turbo", "sdxl-turbo"):
        return {"num_inference_steps": 1, "guidance_scale": 0.0}
    if tier_id == "flux-schnell":
        return {
            "num_inference_steps": max(1, min(steps, 4)),
            "guidance_scale": 0.0,
            "width": w,
            "height": h,
        }
    if tier_id == "flux-dev":
        return {
            "num_inference_steps": max(20, min(steps, 50)),
            "guidance_scale": max(1.0, guidance),
            "width": w,
            "height": h,
        }
    if tier_id == "z-image-turbo":
        return {
            "num_inference_steps": max(4, min(steps, 8)),
            "guidance_scale": 0.0,
            "width": w,
            "height": h,
        }
    if tier_id == "sd-1.5":
        return {
            "num_inference_steps": steps,
            "guidance_scale": guidance,
            "width": w,
            "height": h,
        }
    return {
        "num_inference_steps": steps,
        "guidance_scale": guidance,
        "width": w,
        "height": h,
    }


def generate_image(
    prompt: str,
    steps: int = 20,
    guidance: float = 7.5,
    width: int = 512,
    height: int = 512,
    forced_tier_id: Optional[str] = None,
    seed: Optional[int] = None,
) -> bytes:
    pipe = get_pipeline(forced_tier_id)
    tier = pick_best_tier(forced_tier_id)
    params = _generation_params(tier["id"], steps, guidance, width, height)

    if tier["id"] == "sd-1.5-onnx-cpu":
        # ONNX fallback returns a path; read the bytes for the caller.
        from ..schemas import ImageGenerationRequest

        result = pipe.generate(
            ImageGenerationRequest(
                prompt=prompt,
                steps=steps,
                guidance=guidance,
                width=width,
                height=height,
            )
        )
        with open(result.image_path, "rb") as fh:
            return fh.read()

    # Pass seed as a torch Generator when provided.
    if seed is not None:
        import torch  # type: ignore
        generator = torch.Generator().manual_seed(seed)
        params["generator"] = generator

    image = pipe(prompt=prompt, **params).images[0]
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return buf.getvalue()
