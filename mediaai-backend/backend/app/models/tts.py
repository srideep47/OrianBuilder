"""Tiered text-to-speech.

Tier order (best → fallback):
  • f5-tts: voice cloning, very natural, 6GB
  • xtts-v2: Coqui XTTS-v2, voice cloning, 3GB
  • kokoro-82m: Kokoro 82M — SOTA tiny, runs on CPU at near-realtime, 1GB GPU optional
  • piper: CPU-only fast TTS via local binary
  • speecht5-cpu: legacy SpeechT5 fallback (existing service)
"""

from __future__ import annotations

import gc
import io
import logging
import shutil
import subprocess
import wave
from typing import Optional, TypedDict

from ..hardware import get_backend, get_torch_device, get_vram_mb

log = logging.getLogger(__name__)


class TtsTier(TypedDict):
    id: str
    label: str
    repo: Optional[str]
    vram_mb: int
    download_size_mb: int
    backends: list[str]


# Mirrors src/shared/media_tiers.ts AUDIO_TTS_TIERS.
TTS_TIERS: list[TtsTier] = [
    {
        "id": "f5-tts",
        "label": "F5-TTS",
        "repo": "SWivid/F5-TTS",
        "vram_mb": 6000,
        "download_size_mb": 5000,
        "backends": ["cuda", "rocm", "metal", "mps"],
    },
    {
        "id": "xtts-v2",
        "label": "XTTS v2",
        "repo": "coqui/XTTS-v2",
        "vram_mb": 3000,
        "download_size_mb": 1900,
        "backends": ["cuda", "rocm", "metal", "mps"],
    },
    {
        "id": "kokoro-82m",
        "label": "Kokoro 82M",
        "repo": "hexgrad/Kokoro-82M",
        "vram_mb": 1000,
        "download_size_mb": 350,
        "backends": ["cuda", "rocm", "metal", "mps", "directml", "openvino", "cpu"],
    },
    {
        "id": "piper",
        "label": "Piper TTS (CPU)",
        "repo": None,
        "vram_mb": 0,
        "download_size_mb": 60,
        "backends": ["cuda", "rocm", "metal", "mps", "directml", "openvino", "cpu"],
    },
    {
        "id": "speecht5-cpu",
        "label": "SpeechT5 (CPU)",
        "repo": "microsoft/speecht5_tts",
        "vram_mb": 0,
        "download_size_mb": 600,
        "backends": ["cpu", "directml", "openvino"],
    },
]


def pick_tts_tier(forced_tier_id: Optional[str] = None) -> TtsTier:
    if forced_tier_id:
        for t in TTS_TIERS:
            if t["id"] == forced_tier_id:
                return t
    backend = get_backend()
    vram = get_vram_mb()
    for t in TTS_TIERS:
        if backend in t["backends"] and t["vram_mb"] <= vram:
            return t
    return TTS_TIERS[-1]


# ─── Per-tier loaders (lazy) ──────────────────────────────────────────────────

_f5_model = None
_xtts_model = None
_kokoro_pipeline = None
_loaded_tier_id: Optional[str] = None


def _evict_other_tiers(keep: str) -> None:
    """Drop loaded models for tiers other than `keep` so we don't double-spend
    VRAM when the user switches between them."""
    global _f5_model, _xtts_model, _kokoro_pipeline, _loaded_tier_id
    if _loaded_tier_id == keep:
        return
    _f5_model = None
    _xtts_model = None
    _kokoro_pipeline = None
    gc.collect()
    try:
        import torch  # type: ignore

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except ImportError:
        pass
    _loaded_tier_id = keep


def _generate_f5(text: str, voice: Optional[str] = None) -> bytes:
    """F5-TTS via the f5-tts python package."""
    global _f5_model
    _evict_other_tiers("f5-tts")
    if _f5_model is None:
        try:
            from f5_tts.api import F5TTS  # type: ignore
        except ImportError as exc:
            raise RuntimeError(
                "f5-tts is not installed. Add `f5-tts` to requirements-cuda.txt "
                "or fall back to a different TTS tier."
            ) from exc
        device = get_torch_device()
        _f5_model = F5TTS(device=device if device != "privateuseone" else "cpu")
    wav, sr, _ = _f5_model.infer(
        ref_file=voice if voice and voice.endswith(".wav") else None,
        ref_text="",
        gen_text=text,
        seed=-1,
    )
    import soundfile as sf  # type: ignore

    buf = io.BytesIO()
    sf.write(buf, wav, sr, format="WAV")
    return buf.getvalue()


def _generate_xtts(text: str, voice: Optional[str] = None) -> bytes:
    global _xtts_model
    _evict_other_tiers("xtts-v2")
    if _xtts_model is None:
        try:
            from TTS.api import TTS  # type: ignore
        except ImportError as exc:
            raise RuntimeError(
                "Coqui TTS is not installed. Add `TTS` to requirements-cuda.txt."
            ) from exc
        device = get_torch_device()
        _xtts_model = TTS("tts_models/multilingual/multi-dataset/xtts_v2").to(
            device if device != "privateuseone" else "cpu"
        )
    buf = io.BytesIO()
    _xtts_model.tts_to_file(
        text=text,
        speaker_wav=voice if voice and voice.endswith(".wav") else None,
        language="en",
        file_path=buf,
    )
    return buf.getvalue()


def _generate_kokoro(text: str, voice: Optional[str] = None) -> bytes:
    """Kokoro 82M — SOTA tiny TTS. Uses the `kokoro` python package which
    pulls weights from HuggingFace on first use."""
    global _kokoro_pipeline
    _evict_other_tiers("kokoro-82m")
    if _kokoro_pipeline is None:
        try:
            from kokoro import KPipeline  # type: ignore
        except ImportError as exc:
            raise RuntimeError(
                "kokoro is not installed. Add `kokoro` to requirements files."
            ) from exc
        device = get_torch_device()
        _kokoro_pipeline = KPipeline(
            lang_code="a",  # American English
            device=device if device != "privateuseone" else "cpu",
        )
    voice_id = voice or "af_bella"  # default voice
    audio_chunks = []
    sample_rate = 24000
    for _, _, audio in _kokoro_pipeline(text, voice=voice_id, speed=1.0):
        audio_chunks.append(audio)
    if not audio_chunks:
        raise RuntimeError("Kokoro returned no audio")
    import numpy as np  # type: ignore
    import soundfile as sf  # type: ignore

    audio = np.concatenate(audio_chunks)
    buf = io.BytesIO()
    sf.write(buf, audio, sample_rate, format="WAV")
    return buf.getvalue()


def _generate_piper(text: str, voice: Optional[str] = None) -> bytes:
    """Pipe text through the Piper TTS binary if available, else fall back
    to the legacy SpeechT5 service path."""
    piper_bin = shutil.which("piper")
    if not piper_bin or not voice:
        return _generate_speecht5(text)

    proc = subprocess.run(
        [piper_bin, "--model", voice, "--output_raw"],
        input=text.encode("utf-8"),
        capture_output=True,
        check=True,
    )
    # Wrap raw 22050Hz mono int16 PCM into a WAV container.
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(22050)
        wav.writeframes(proc.stdout)
    return buf.getvalue()


def _generate_speecht5(text: str) -> bytes:
    """Final fallback — uses the existing SpeechT5 service."""
    from ..services.audio_generation import audio_generation_service
    from ..schemas import AudioGenerationRequest

    result = audio_generation_service.generate(AudioGenerationRequest(prompt=text))
    with open(result.audio_path, "rb") as fh:
        return fh.read()


def generate_speech(
    text: str,
    voice: Optional[str] = None,
    forced_tier_id: Optional[str] = None,
) -> bytes:
    tier = pick_tts_tier(forced_tier_id)
    log.info("tts gen tier=%s", tier["id"])

    # Each tier falls through to the next on ANY failure — not just the
    # loader's own RuntimeError wrapper. Real-world example: Coqui TTS
    # imports lazily inside its constructor and explodes with an ImportError
    # (BeamSearchScorer removed from new transformers), which used to escape
    # this chain and fail the whole speech request.
    if tier["id"] == "f5-tts":
        try:
            return _generate_f5(text, voice)
        except Exception as exc:  # noqa: BLE001
            log.warning("f5-tts unavailable, falling back: %s", exc)
    if tier["id"] in ("f5-tts", "xtts-v2"):
        try:
            return _generate_xtts(text, voice)
        except Exception as exc:  # noqa: BLE001
            log.warning("xtts unavailable, falling back: %s", exc)
    if tier["id"] in ("f5-tts", "xtts-v2", "kokoro-82m"):
        try:
            return _generate_kokoro(text, voice)
        except Exception as exc:  # noqa: BLE001
            log.warning("kokoro unavailable, falling back: %s", exc)
    if tier["id"] in ("f5-tts", "xtts-v2", "kokoro-82m", "piper"):
        try:
            return _generate_piper(text, voice)
        except Exception as exc:  # noqa: BLE001
            log.warning("piper unavailable, falling back: %s", exc)
    return _generate_speecht5(text)


def unload() -> None:
    global _f5_model, _xtts_model, _kokoro_pipeline, _loaded_tier_id
    _f5_model = None
    _xtts_model = None
    _kokoro_pipeline = None
    _loaded_tier_id = None
    gc.collect()
    try:
        import torch  # type: ignore

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except ImportError:
        pass
