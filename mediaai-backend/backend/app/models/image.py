"""Tiered image generation. Picks the best diffusion model that fits in
the active backend's VRAM, falls back to SD 1.5 ONNX on CPU."""

from __future__ import annotations

import io
from typing import Optional, TypedDict

from ..hardware import get_backend, get_torch_device, get_torch_dtype, get_vram_mb


class ImageTier(TypedDict):
    id: str
    repo: Optional[str]
    vram_mb: int
    backends: list[str]


IMAGE_MODEL_TIERS: list[ImageTier] = [
    {
        "id": "flux-schnell",
        "repo": "black-forest-labs/FLUX.1-schnell",
        "vram_mb": 12000,
        "backends": ["cuda", "rocm", "mps", "metal"],
    },
    {
        "id": "sdxl-turbo",
        "repo": "stabilityai/sdxl-turbo",
        "vram_mb": 8000,
        "backends": ["cuda", "rocm", "mps", "metal", "directml"],
    },
    {
        "id": "sd-1.5",
        "repo": "runwayml/stable-diffusion-v1-5",
        "vram_mb": 4000,
        "backends": ["cuda", "rocm", "mps", "metal", "directml", "openvino", "cpu"],
    },
    {
        "id": "sd-1.5-onnx",
        "repo": None,
        "vram_mb": 0,
        "backends": ["cpu", "openvino", "directml"],
    },
]


def pick_best_tier(forced_tier_id: Optional[str] = None) -> ImageTier:
    if forced_tier_id:
        for tier in IMAGE_MODEL_TIERS:
            if tier["id"] == forced_tier_id:
                return tier
    backend = get_backend()
    vram = get_vram_mb()
    for tier in IMAGE_MODEL_TIERS:
        if backend in tier["backends"] and tier["vram_mb"] <= vram:
            return tier
    return IMAGE_MODEL_TIERS[-1]


_pipeline = None
_pipeline_tier_id: Optional[str] = None


def get_pipeline(forced_tier_id: Optional[str] = None):
    """Lazy-load the appropriate pipeline for the active backend.
    Returns the cached instance after the first call. When forced_tier_id is
    given, replaces the cache with that tier."""
    global _pipeline, _pipeline_tier_id

    tier = pick_best_tier(forced_tier_id)
    if _pipeline is not None and _pipeline_tier_id == tier["id"]:
        return _pipeline

    if _pipeline is not None and _pipeline_tier_id != tier["id"]:
        unload_pipeline()

    device = get_torch_device()
    dtype = get_torch_dtype()

    if tier["id"] == "flux-schnell":
        from diffusers import FluxPipeline  # type: ignore
        import torch  # type: ignore
        pipe = FluxPipeline.from_pretrained(
            tier["repo"], torch_dtype=torch.bfloat16
        )
        pipe = pipe.to(device)
    elif tier["id"] == "sdxl-turbo":
        from diffusers import AutoPipelineForText2Image  # type: ignore
        pipe = AutoPipelineForText2Image.from_pretrained(
            tier["repo"], torch_dtype=dtype, variant="fp16"
        )
        pipe = pipe.to(device)
    elif tier["id"] == "sd-1.5":
        from diffusers import StableDiffusionPipeline  # type: ignore
        pipe = StableDiffusionPipeline.from_pretrained(
            tier["repo"], torch_dtype=dtype
        )
        pipe = pipe.to(device)
    else:
        # CPU/ONNX fallback. Defer to the existing service so we don't duplicate
        # ORT model wiring (DirectML / OpenVINO EPs etc.).
        from ..services.image_generation import image_generation_service

        pipe = image_generation_service  # provider-style adapter

    _pipeline = pipe
    _pipeline_tier_id = tier["id"]
    return _pipeline


def unload_pipeline() -> None:
    global _pipeline, _pipeline_tier_id
    _pipeline = None
    _pipeline_tier_id = None
    try:
        import torch  # type: ignore
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except ImportError:
        pass


def generate_image(
    prompt: str,
    steps: int = 20,
    guidance: float = 7.5,
    width: int = 512,
    height: int = 512,
    forced_tier_id: Optional[str] = None,
) -> bytes:
    pipe = get_pipeline(forced_tier_id)
    tier = pick_best_tier(forced_tier_id)

    if tier["id"] == "sdxl-turbo":
        # turbo: 1 step, no classifier-free guidance
        image = pipe(prompt=prompt, num_inference_steps=1, guidance_scale=0.0).images[0]
    elif tier["id"] == "flux-schnell":
        image = pipe(
            prompt=prompt, num_inference_steps=max(1, min(steps, 4)),
            guidance_scale=0.0, width=width, height=height,
        ).images[0]
    elif tier["id"] == "sd-1.5":
        image = pipe(
            prompt=prompt, num_inference_steps=steps,
            guidance_scale=guidance, width=width, height=height,
        ).images[0]
    else:
        # ONNX fallback returns a path. Read the bytes for the caller.
        from ..schemas import ImageGenerationRequest
        from starlette.concurrency import run_in_threadpool  # noqa: F401 - import to mirror sync path
        result = pipe.generate(
            ImageGenerationRequest(prompt=prompt, steps=steps, guidance=guidance,
                                    width=width, height=height)
        )
        with open(result.image_path, "rb") as fh:
            return fh.read()

    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return buf.getvalue()
