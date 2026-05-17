"""Tiered Whisper speech-to-text via transformers' ASR pipeline.

Tier order (best → fallback):
  • whisper-large-v3-turbo: 6GB, near-Large-v3 quality, ~6× faster
  • whisper-large-v3:       8GB, highest accuracy
  • whisper-medium:         4GB
  • whisper-base:           2GB
  • whisper-tiny:           CPU fallback
"""

from __future__ import annotations

import gc
import logging
from typing import Optional, TypedDict

from ..hardware import get_backend, get_torch_device, get_torch_dtype, get_vram_mb

log = logging.getLogger(__name__)


class SttTier(TypedDict):
    id: str
    label: str
    repo: str
    vram_mb: int
    download_size_mb: int
    backends: list[str]


# Mirrors src/shared/media_tiers.ts AUDIO_STT_TIERS.
STT_TIERS: list[SttTier] = [
    {
        "id": "whisper-large-v3-turbo",
        "label": "Whisper Large v3 Turbo",
        "repo": "openai/whisper-large-v3-turbo",
        "vram_mb": 6000,
        "download_size_mb": 1620,
        "backends": ["cuda", "rocm", "metal", "mps"],
    },
    {
        "id": "whisper-large-v3",
        "label": "Whisper Large v3",
        "repo": "openai/whisper-large-v3",
        "vram_mb": 8000,
        "download_size_mb": 3100,
        "backends": ["cuda", "rocm", "metal", "mps"],
    },
    {
        "id": "whisper-medium",
        "label": "Whisper Medium",
        "repo": "openai/whisper-medium",
        "vram_mb": 4000,
        "download_size_mb": 1530,
        "backends": ["cuda", "rocm", "metal", "mps", "directml"],
    },
    {
        "id": "whisper-base",
        "label": "Whisper Base",
        "repo": "openai/whisper-base",
        "vram_mb": 2000,
        "download_size_mb": 290,
        "backends": ["cuda", "rocm", "metal", "mps", "directml", "openvino", "cpu"],
    },
    {
        "id": "whisper-tiny-cpu",
        "label": "Whisper Tiny (CPU)",
        "repo": "openai/whisper-tiny",
        "vram_mb": 0,
        "download_size_mb": 75,
        "backends": ["cuda", "rocm", "metal", "mps", "directml", "openvino", "cpu"],
    },
]


def pick_stt_tier(forced_tier_id: Optional[str] = None) -> SttTier:
    if forced_tier_id:
        for t in STT_TIERS:
            if t["id"] == forced_tier_id:
                return t
    backend = get_backend()
    vram = get_vram_mb()
    for t in STT_TIERS:
        if backend in t["backends"] and t["vram_mb"] <= vram:
            return t
    return STT_TIERS[-1]


_pipeline = None
_pipeline_tier_id: Optional[str] = None


def get_pipeline(forced_tier_id: Optional[str] = None):
    global _pipeline, _pipeline_tier_id

    tier = pick_stt_tier(forced_tier_id)
    if _pipeline is not None and _pipeline_tier_id == tier["id"]:
        return _pipeline

    if _pipeline is not None and _pipeline_tier_id != tier["id"]:
        unload()

    from transformers import pipeline  # type: ignore

    device = get_torch_device()
    dtype = get_torch_dtype()
    log.info(
        "loading stt tier id=%s repo=%s device=%s",
        tier["id"],
        tier["repo"],
        device,
    )
    _pipeline = pipeline(
        "automatic-speech-recognition",
        model=tier["repo"],
        torch_dtype=dtype,
        device=device if device != "privateuseone" else "cpu",
    )
    _pipeline_tier_id = tier["id"]
    return _pipeline


def transcribe(
    audio_path: str,
    language: Optional[str] = None,
    forced_tier_id: Optional[str] = None,
) -> str:
    pipe = get_pipeline(forced_tier_id)
    kwargs: dict = {}
    if language:
        kwargs["generate_kwargs"] = {"language": language}
    result = pipe(audio_path, **kwargs)
    text = result.get("text") if isinstance(result, dict) else None
    return text or ""


def unload() -> None:
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
