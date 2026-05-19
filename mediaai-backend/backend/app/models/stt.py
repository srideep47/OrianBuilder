"""Tiered Whisper speech-to-text via faster-whisper (CTranslate2).

Tier order (best → fallback):
  • whisper-large-v3-turbo: 6GB VRAM, near-Large-v3 quality, ~8× faster than original
  • whisper-medium:         4GB, balanced quality/speed
  • whisper-base:           2GB, fast on CPU
  • whisper-tiny:           CPU fallback, ~500ms, 75MB download
"""

from __future__ import annotations

import gc
import logging
import os
from pathlib import Path
from typing import Optional, TypedDict

from ..hardware import get_backend, get_vram_mb

log = logging.getLogger(__name__)

# Make bundled ffmpeg (from imageio-ffmpeg) visible to faster-whisper's ffmpeg subprocess.
try:
    import imageio_ffmpeg  # type: ignore

    _ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()
    _ffmpeg_dir = str(Path(_ffmpeg_exe).parent)
    os.environ["PATH"] = _ffmpeg_dir + os.pathsep + os.environ.get("PATH", "")
except Exception:
    pass


class SttTier(TypedDict):
    id: str
    label: str
    repo: str  # faster-whisper model name (auto-downloaded from HF)
    vram_mb: int
    download_size_mb: int
    backends: list[str]


# Mirrors src/shared/media_tiers.ts AUDIO_STT_TIERS.
STT_TIERS: list[SttTier] = [
    {
        "id": "whisper-large-v3-turbo",
        "label": "Whisper Large v3 Turbo",
        "repo": "large-v3-turbo",
        "vram_mb": 6000,
        "download_size_mb": 1620,
        "backends": ["cuda", "rocm", "metal", "mps"],
    },
    {
        "id": "whisper-medium",
        "label": "Whisper Medium",
        "repo": "medium",
        "vram_mb": 4000,
        "download_size_mb": 770,
        "backends": ["cuda", "rocm", "metal", "mps", "directml"],
    },
    {
        "id": "whisper-base",
        "label": "Whisper Base",
        "repo": "base",
        "vram_mb": 2000,
        "download_size_mb": 145,
        "backends": ["cuda", "rocm", "metal", "mps", "directml", "openvino", "cpu"],
    },
    {
        "id": "whisper-tiny-cpu",
        "label": "Whisper Tiny (CPU)",
        "repo": "tiny",
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


_model = None
_model_tier_id: Optional[str] = None
# Alias expected by main.py's /v1/models/available endpoint.
_pipeline_tier_id: Optional[str] = None


def get_pipeline(forced_tier_id: Optional[str] = None):
    global _model, _model_tier_id, _pipeline_tier_id

    tier = pick_stt_tier(forced_tier_id)
    if _model is not None and _model_tier_id == tier["id"]:
        return _model

    if _model is not None:
        unload()

    from faster_whisper import WhisperModel  # type: ignore

    backend = get_backend()
    device = "cuda" if backend in ("cuda", "rocm") else "cpu"
    compute_type = "float16" if device == "cuda" else "int8"

    log.info(
        "loading stt tier id=%s repo=%s device=%s compute_type=%s",
        tier["id"],
        tier["repo"],
        device,
        compute_type,
    )
    _model = WhisperModel(tier["repo"], device=device, compute_type=compute_type)
    _model_tier_id = tier["id"]
    _pipeline_tier_id = tier["id"]
    return _model


def transcribe(
    audio_path: str,
    language: Optional[str] = None,
    forced_tier_id: Optional[str] = None,
) -> str:
    model = get_pipeline(forced_tier_id)
    kwargs: dict = {}
    if language:
        kwargs["language"] = language
    segments, _info = model.transcribe(audio_path, beam_size=5, **kwargs)
    return "".join(seg.text for seg in segments).strip()


def unload() -> None:
    global _model, _model_tier_id, _pipeline_tier_id
    _model = None
    _model_tier_id = None
    _pipeline_tier_id = None
    gc.collect()
    try:
        import torch  # type: ignore

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except ImportError:
        pass
