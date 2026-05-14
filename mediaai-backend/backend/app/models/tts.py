"""Tiered text-to-speech. XTTS-v2 when GPU VRAM is plentiful, Piper TTS
(CPU-fast) otherwise. Falls back to SpeechT5 (existing) when neither is
installed yet."""

from __future__ import annotations

import io
import subprocess
import shutil
from typing import Optional, TypedDict

from ..hardware import get_backend, get_torch_device, get_vram_mb


class TtsTier(TypedDict):
    id: str
    vram_mb: int
    backends: list[str]


TTS_TIERS: list[TtsTier] = [
    {"id": "xtts-v2", "vram_mb": 3000, "backends": ["cuda", "rocm", "mps", "metal"]},
    {"id": "piper",   "vram_mb": 0,    "backends": ["cuda", "rocm", "mps", "metal", "directml", "openvino", "cpu"]},
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


_xtts_model = None


def _get_xtts():
    """Lazy XTTS-v2 loader using Coqui TTS."""
    global _xtts_model
    if _xtts_model is not None:
        return _xtts_model
    from TTS.api import TTS  # type: ignore
    device = get_torch_device()
    _xtts_model = TTS("tts_models/multilingual/multi-dataset/xtts_v2").to(device)
    return _xtts_model


def _generate_xtts(text: str, voice: Optional[str] = None) -> bytes:
    model = _get_xtts()
    buf = io.BytesIO()
    model.tts_to_file(
        text=text,
        speaker_wav=voice if voice and voice.endswith(".wav") else None,
        language="en",
        file_path=buf,
    )
    return buf.getvalue()


def _generate_piper(text: str, voice: Optional[str] = None) -> bytes:
    """Pipe text through the Piper TTS binary if available, else fall back to
    the SpeechT5 service path. Piper writes raw PCM to stdout when --output_raw
    is supplied; we wrap it into a WAV envelope."""
    piper_bin = shutil.which("piper")
    if not piper_bin or not voice:
        from ..services.audio_generation import audio_generation_service
        from ..schemas import AudioGenerationRequest
        result = audio_generation_service.generate(
            AudioGenerationRequest(prompt=text)
        )
        with open(result.audio_path, "rb") as fh:
            return fh.read()

    proc = subprocess.run(
        [piper_bin, "--model", voice, "--output_raw"],
        input=text.encode("utf-8"),
        capture_output=True,
        check=True,
    )
    # Wrap raw 22050Hz mono int16 PCM into a WAV container.
    import wave
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(22050)
        wav.writeframes(proc.stdout)
    return buf.getvalue()


def generate_speech(
    text: str,
    voice: Optional[str] = None,
    forced_tier_id: Optional[str] = None,
) -> bytes:
    tier = pick_tts_tier(forced_tier_id)
    if tier["id"] == "xtts-v2":
        try:
            return _generate_xtts(text, voice)
        except ImportError:
            # Coqui TTS not installed for this requirements profile — fall back
            pass
    return _generate_piper(text, voice)


def unload() -> None:
    global _xtts_model
    _xtts_model = None
    try:
        import torch  # type: ignore
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except ImportError:
        pass
