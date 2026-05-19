"""Tiered text-to-video generation. Picks the best video model that fits
the active backend's VRAM. Falls back through the tiers down to a CPU-only
text-to-video pipeline.

Tier order matters: pick_best_video_tier walks the list top-to-bottom and
returns the first tier whose vram_mb fits the live VRAM budget.
"""

from __future__ import annotations

import gc
import logging
import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, TypedDict
from uuid import uuid4

from ..hardware import get_backend, get_torch_device, get_torch_dtype, get_vram_mb

log = logging.getLogger(__name__)

BACKEND_DIR = Path(__file__).resolve().parents[2]
OUTPUTS_DIR = Path(os.getenv("OMNIGEN_OUTPUTS_DIR", str(BACKEND_DIR / "outputs")))


class VideoTier(TypedDict):
    id: str
    repo: Optional[str]
    vram_mb: int
    download_size_mb: int
    backends: list[str]
    label: str
    default_frames: int
    default_fps: int
    default_width: int
    default_height: int
    default_steps: int


# Mirrors src/shared/media_tiers.ts VIDEO_TIERS.
VIDEO_TIERS: list[VideoTier] = [
    {
        "id": "wan-2.1-1.3b",
        "label": "Wan 2.1 (1.3B)",
        "repo": "Wan-AI/Wan2.1-T2V-1.3B-Diffusers",
        "vram_mb": 8000,
        "download_size_mb": 14000,
        "backends": ["cuda", "rocm", "metal", "mps"],
        "default_frames": 81,
        "default_fps": 16,
        "default_width": 832,
        "default_height": 480,
        "default_steps": 25,
    },
    {
        "id": "ltx-video",
        "label": "LTX Video",
        "repo": "Lightricks/LTX-Video",
        "vram_mb": 12000,
        "download_size_mb": 18000,
        "backends": ["cuda", "rocm", "metal", "mps"],
        "default_frames": 121,
        "default_fps": 24,
        "default_width": 768,
        "default_height": 512,
        "default_steps": 30,
    },
    {
        "id": "cogvideox-2b",
        "label": "CogVideoX 2B",
        "repo": "THUDM/CogVideoX-2b",
        "vram_mb": 6000,
        "download_size_mb": 11000,
        "backends": ["cuda", "rocm", "metal", "mps"],
        "default_frames": 49,
        "default_fps": 8,
        "default_width": 720,
        "default_height": 480,
        "default_steps": 50,
    },
    {
        "id": "animatediff-sd15",
        "label": "AnimateDiff + SD 1.5",
        "repo": "guoyww/animatediff-motion-adapter-v1-5-3",
        "vram_mb": 4000,
        "download_size_mb": 6000,
        "backends": ["cuda", "rocm", "metal", "mps", "directml"],
        "default_frames": 16,
        "default_fps": 8,
        "default_width": 512,
        "default_height": 512,
        "default_steps": 25,
    },
    {
        "id": "text-to-video-cpu",
        "label": "Text-to-Video MS (CPU)",
        "repo": "damo-vilab/text-to-video-ms-1.7b",
        "vram_mb": 0,
        "download_size_mb": 8000,
        "backends": ["cpu"],
        "default_frames": 8,
        "default_fps": 4,
        "default_width": 256,
        "default_height": 256,
        "default_steps": 10,
    },
]


def pick_best_video_tier(forced_tier_id: Optional[str] = None) -> VideoTier:
    if forced_tier_id:
        for tier in VIDEO_TIERS:
            if tier["id"] == forced_tier_id:
                return tier
    backend = get_backend()
    vram = get_vram_mb()
    for tier in VIDEO_TIERS:
        if backend in tier["backends"] and tier["vram_mb"] <= vram:
            return tier
    return VIDEO_TIERS[-1]


_pipeline = None
_pipeline_tier_id: Optional[str] = None
_lock = threading.Lock()


def _enable_savers(pipe) -> None:
    for fn_name in (
        "enable_attention_slicing",
        "enable_vae_slicing",
        "enable_vae_tiling",
        "enable_model_cpu_offload",
    ):
        fn = getattr(pipe, fn_name, None)
        if callable(fn):
            try:
                fn()
            except Exception:  # noqa: BLE001
                pass


def get_pipeline(forced_tier_id: Optional[str] = None):
    global _pipeline, _pipeline_tier_id

    tier = pick_best_video_tier(forced_tier_id)
    if _pipeline is not None and _pipeline_tier_id == tier["id"]:
        return _pipeline

    if _pipeline is not None and _pipeline_tier_id != tier["id"]:
        unload_pipeline()

    device = get_torch_device()
    dtype = get_torch_dtype()
    log.info(
        "loading video tier id=%s repo=%s device=%s",
        tier["id"],
        tier["repo"],
        device,
    )

    if tier["id"] == "wan-2.1-1.3b":
        from diffusers import WanPipeline  # type: ignore

        pipe = WanPipeline.from_pretrained(tier["repo"], torch_dtype=dtype)
        pipe = pipe.to(device)
        _enable_savers(pipe)
    elif tier["id"] == "ltx-video":
        from diffusers import LTXPipeline  # type: ignore

        pipe = LTXPipeline.from_pretrained(tier["repo"], torch_dtype=dtype)
        pipe = pipe.to(device)
        _enable_savers(pipe)
    elif tier["id"] == "cogvideox-2b":
        from diffusers import CogVideoXPipeline  # type: ignore

        pipe = CogVideoXPipeline.from_pretrained(tier["repo"], torch_dtype=dtype)
        pipe = pipe.to(device)
        _enable_savers(pipe)
    elif tier["id"] == "animatediff-sd15":
        from diffusers import (  # type: ignore
            AnimateDiffPipeline,
            MotionAdapter,
            EulerDiscreteScheduler,
        )

        adapter = MotionAdapter.from_pretrained(tier["repo"], torch_dtype=dtype)
        pipe = AnimateDiffPipeline.from_pretrained(
            "runwayml/stable-diffusion-v1-5",
            motion_adapter=adapter,
            torch_dtype=dtype,
            safety_checker=None,
        )
        pipe.scheduler = EulerDiscreteScheduler.from_config(
            pipe.scheduler.config, timestep_spacing="linspace", beta_schedule="linear"
        )
        pipe = pipe.to(device)
        _enable_savers(pipe)
    else:
        # CPU fallback — Text-to-Video MS 1.7B on CPU.
        from diffusers import DiffusionPipeline  # type: ignore
        import torch  # type: ignore

        pipe = DiffusionPipeline.from_pretrained(
            tier["repo"], torch_dtype=torch.float32
        ).to("cpu")

    _pipeline = pipe
    _pipeline_tier_id = tier["id"]
    return _pipeline


def unload_pipeline() -> None:
    global _pipeline, _pipeline_tier_id
    _pipeline = None
    _pipeline_tier_id = None
    gc.collect()
    try:
        import torch  # type: ignore

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except ImportError:
        pass


def _output_filename() -> str:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return f"video-{timestamp}-{uuid4().hex[:8]}.mp4"


def generate_video(
    prompt: str,
    forced_tier_id: Optional[str] = None,
    num_frames: Optional[int] = None,
    fps: Optional[int] = None,
    width: Optional[int] = None,
    height: Optional[int] = None,
    steps: Optional[int] = None,
) -> dict:
    """Generates a video and returns {video_path, video_url, model, tier}.
    Writes the file under OMNIGEN_OUTPUTS_DIR."""
    OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)

    with _lock:
        pipe = get_pipeline(forced_tier_id)
        tier = pick_best_video_tier(forced_tier_id)
        kwargs = {
            "num_frames": num_frames or tier["default_frames"],
            "num_inference_steps": steps or tier["default_steps"],
            "width": width or tier["default_width"],
            "height": height or tier["default_height"],
        }

        # Wan/LTX/CogVideoX accept guidance_scale; AnimateDiff/text-to-video may not.
        if tier["id"] in ("wan-2.1-1.3b", "ltx-video", "cogvideox-2b"):
            kwargs["guidance_scale"] = 6.0

        log.info("video gen tier=%s frames=%s", tier["id"], kwargs["num_frames"])
        result = pipe(prompt, **kwargs)

    # Diffusers pipelines return either a `.frames` (list of PIL frames) or a
    # `.videos` ndarray; normalize to a list of PIL frames.
    frames = getattr(result, "frames", None)
    if frames is None:
        frames = getattr(result, "videos", None)
    if frames is None:
        raise RuntimeError(f"video pipeline returned no frames (tier={tier['id']})")

    # Most pipelines return frames[0] as the per-batch sequence.
    if isinstance(frames, (list, tuple)) and len(frames) > 0 and isinstance(frames[0], (list, tuple)):
        frame_seq = frames[0]
    else:
        frame_seq = frames

    from diffusers.utils import export_to_video  # type: ignore

    filename = _output_filename()
    output_path = OUTPUTS_DIR / filename
    export_to_video(frame_seq, str(output_path), fps=fps or tier["default_fps"])

    return {
        "video_path": str(output_path.resolve()),
        "video_url": f"/outputs/{filename}",
        "model": tier["repo"] or tier["id"],
        "tier": tier["id"],
    }
