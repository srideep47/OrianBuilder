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


def _get_available_ram_mb() -> int:
    """Returns available system RAM in MB. Returns 0 on platforms where we
    can't determine it (psutil missing, etc) — callers should treat 0 as
    'unknown' and proceed, not as 'no RAM'."""
    try:
        import psutil  # type: ignore

        return int(psutil.virtual_memory().available / (1024 * 1024))
    except Exception:  # noqa: BLE001
        return 0


def _get_total_ram_mb() -> int:
    """Returns total system RAM in MB, or 0 if unavailable."""
    try:
        import psutil  # type: ignore

        return int(psutil.virtual_memory().total / (1024 * 1024))
    except Exception:  # noqa: BLE001
        return 0


def _check_ram_sufficient(tier: "VideoTier") -> None:
    """Raises RuntimeError with an actionable message if there isn't enough
    free RAM to load this video tier. Loading a 14 GB model into 2 GB of free
    RAM causes Windows to swap to disk, locking up the entire machine for
    minutes. Refuse fast instead so the user can close other apps."""
    available = _get_available_ram_mb()
    total = _get_total_ram_mb()
    if available <= 0:
        # psutil missing or failed — skip the check rather than block generation.
        return

    # Rough memory requirement: download_size * 1.1 (load buffer + activations).
    # For Wan 2.1 1.3B with ~14 GB on disk that's ~15.4 GB of RAM headroom needed.
    required = int(tier["download_size_mb"] * 1.1)

    if available < required:
        # Build a friendly error message that suggests concrete next steps.
        gb_avail = available / 1024
        gb_required = required / 1024
        gb_total = total / 1024 if total > 0 else 0
        hint_lines = [
            f"Not enough free RAM to load {tier['label']}.",
            f"Required: ~{gb_required:.1f} GB free.  Available: ~{gb_avail:.1f} GB"
            + (f" of {gb_total:.1f} GB total." if gb_total else "."),
            "",
            "Try one of:",
            "  • Close Chrome / browsers and other apps, then retry.",
            "  • Restart the OrianBuilder app to free its working memory.",
            "  • Pick the 'Text-to-Video MS (CPU)' tier — it only needs ~3 GB.",
        ]
        raise RuntimeError("\n".join(hint_lines))


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
# Order is highest VRAM → lowest so pick_best_video_tier selects the best
# model that actually fits in available VRAM.
VIDEO_TIERS: list[VideoTier] = [
    {
        # Highest-quality tier — auto-selected for 14 GB+ GPUs.
        "id": "wan-2.1-14b",
        "label": "Wan 2.1 (14B)",
        "repo": "Wan-AI/Wan2.1-T2V-14B-Diffusers",
        "vram_mb": 14000,
        "download_size_mb": 30000,
        "backends": ["cuda", "rocm", "metal", "mps"],
        "default_frames": 81,
        "default_fps": 16,
        "default_width": 832,
        "default_height": 480,
        "default_steps": 30,
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
        # Budget tier — CPU offload lets this fit in 5 GB VRAM.
        "id": "wan-2.1-1.3b",
        "label": "Wan 2.1 (1.3B)",
        "repo": "Wan-AI/Wan2.1-T2V-1.3B-Diffusers",
        "vram_mb": 5000,
        "download_size_mb": 14000,
        "backends": ["cuda", "rocm", "metal", "mps"],
        "default_frames": 81,
        "default_fps": 16,
        "default_width": 832,
        "default_height": 480,
        "default_steps": 25,
    },
    {
        "id": "cogvideox-2b",
        "label": "CogVideoX 2B",
        "repo": "THUDM/CogVideoX-2b",
        "vram_mb": 7000,
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

_download_progress: dict[str, float] = {}
_download_errors: dict[str, str] = {}
_downloading_tiers: set[str] = set()


def tier_status(tier_id: str) -> str:
    if tier_id in _downloading_tiers:
        return "downloading"
    tier = next((t for t in VIDEO_TIERS if t["id"] == tier_id), None)
    if not tier:
        return "not_downloaded"
    repo = tier.get("repo")
    if not repo:
        return "not_downloaded"
    hf_home = os.environ.get("HF_HOME", "")
    cache_dir = Path(hf_home) / "hub" if hf_home else Path.home() / ".cache" / "huggingface" / "hub"
    repo_dir = cache_dir / f"models--{repo.replace('/', '--')}"
    snaps = repo_dir / "snapshots"
    if snaps.is_dir() and any(snaps.iterdir()):
        return "downloaded"
    return "not_downloaded"


def get_download_error(tier_id: str) -> str | None:
    return _download_errors.get(tier_id)


def download_tier(tier_id: str) -> None:
    tier = next((t for t in VIDEO_TIERS if t["id"] == tier_id), None)
    if not tier or not tier.get("repo"):
        return
    _downloading_tiers.add(tier_id)
    _download_errors.pop(tier_id, None)
    try:
        from huggingface_hub import snapshot_download  # type: ignore
        snapshot_download(repo_id=tier["repo"])
    except Exception as exc:  # noqa: BLE001
        _download_errors[tier_id] = str(exc)
    finally:
        _downloading_tiers.discard(tier_id)
        _download_progress.pop(tier_id, None)


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

    # Verify the CUDA runtime is actually usable. If get_torch_device() said
    # "cuda" but torch.cuda.is_available() is False, the model would silently
    # fall back to CPU during from_pretrained — which on Wan 2.1 means a 14 GB
    # load into RAM with no offload, instantly locking up low-RAM laptops.
    if device == "cuda":
        try:
            import torch  # type: ignore

            if not torch.cuda.is_available():
                log.warning(
                    "device=cuda requested but torch.cuda.is_available()=False; "
                    "falling back to CPU — generation will be slow and may OOM"
                )
                device = "cpu"
            else:
                cuda_name = torch.cuda.get_device_name(0)
                free_mb, total_mb = (x // (1024 * 1024) for x in torch.cuda.mem_get_info())
                log.info(
                    "CUDA OK: device=%s vram_free=%dMB vram_total=%dMB",
                    cuda_name,
                    free_mb,
                    total_mb,
                )
        except Exception as exc:  # noqa: BLE001
            log.warning("CUDA probe failed (%s); falling back to CPU", exc)
            device = "cpu"

    # Preflight RAM check — fail fast with a clear message instead of locking
    # up the machine when the model is too big to fit in available RAM.
    _check_ram_sufficient(tier)

    avail_ram = _get_available_ram_mb()
    log.info(
        "loading video tier id=%s repo=%s device=%s dtype=%s vram_mb=%d free_ram_mb=%d",
        tier["id"],
        tier["repo"],
        device,
        dtype,
        get_vram_mb(),
        avail_ram,
    )

    if tier["id"] == "wan-2.1-14b":
        from diffusers import WanPipeline  # type: ignore
        import torch  # type: ignore

        # bfloat16 matches the on-disk format — no dtype conversion during load,
        # which halves peak RAM vs float16. low_cpu_mem_usage streams shards to
        # CPU instead of materializing a meta-tensor copy first.
        pipe = WanPipeline.from_pretrained(
            tier["repo"],
            torch_dtype=torch.bfloat16,
            low_cpu_mem_usage=True,
        )
        # 14B needs CPU offload on anything under 20 GB.
        if device == "cuda" and get_vram_mb() < 20000:
            try:
                pipe.enable_model_cpu_offload()
            except Exception:  # noqa: BLE001
                pipe = pipe.to(device)
        else:
            pipe = pipe.to(device)
        _enable_savers(pipe)
    elif tier["id"] == "wan-2.1-1.3b":
        from diffusers import WanPipeline  # type: ignore
        import torch  # type: ignore

        # bfloat16 matches the Wan on-disk weight format so PyTorch can load
        # each shard without allocating a temporary float16 copy — this halves
        # peak RAM (the UMT5-XXL text encoder alone is ~11 GB on disk).
        # low_cpu_mem_usage=True is essential: it uses meta-tensor materialization
        # so peak RAM usage stays close to the model size (vs ~2× without it).
        pipe = WanPipeline.from_pretrained(
            tier["repo"],
            torch_dtype=torch.bfloat16,
            low_cpu_mem_usage=True,
        )
        # Free the intermediate Python references from the load process before
        # configuring offload — gives back any temporary tensors that pip's
        # safetensors loader retained.
        gc.collect()

        if device == "cuda":
            vram = get_vram_mb()
            if vram < 8000:
                # ≤ 8 GB VRAM (e.g. RTX 3060 Laptop 6 GB): sequential offload moves
                # individual layers to GPU one-at-a-time, keeping peak VRAM under 4 GB.
                # enable_model_cpu_offload keeps whole sub-modules on GPU and can spike
                # past 6 GB, causing Windows access-violation crashes.
                log.info("VRAM=%dMB < 8GB → using sequential_cpu_offload", vram)
                try:
                    pipe.enable_sequential_cpu_offload()
                    log.info("sequential_cpu_offload enabled — inference will use GPU")
                except Exception as exc:  # noqa: BLE001
                    log.warning("sequential_cpu_offload failed (%s); trying model_cpu_offload", exc)
                    try:
                        pipe.enable_model_cpu_offload()
                    except Exception as exc2:  # noqa: BLE001
                        log.warning("model_cpu_offload also failed (%s); using full CPU", exc2)
                        pipe = pipe.to(device)
            else:
                log.info("VRAM=%dMB ≥ 8GB → using model_cpu_offload", vram)
                try:
                    pipe.enable_model_cpu_offload()
                except Exception:  # noqa: BLE001
                    pipe = pipe.to(device)
        else:
            log.warning(
                "loading Wan 2.1 1.3B on CPU — this will be very slow and use ~14 GB RAM"
            )
            pipe = pipe.to(device)

        # VAE memory helpers — skip the offload call since we already configured it.
        for fn_name in ("enable_attention_slicing", "enable_vae_slicing", "enable_vae_tiling"):
            fn = getattr(pipe, fn_name, None)
            if callable(fn):
                try:
                    fn()
                except Exception:  # noqa: BLE001
                    pass
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
        # stable-diffusion-v1-5/stable-diffusion-v1-5 is a public mirror of
        # runwayml/stable-diffusion-v1-5 that doesn't require HF login.
        pipe = AnimateDiffPipeline.from_pretrained(
            "stable-diffusion-v1-5/stable-diffusion-v1-5",
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
        if tier["id"] in ("wan-2.1-14b", "wan-2.1-1.3b", "ltx-video", "cogvideox-2b"):
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
