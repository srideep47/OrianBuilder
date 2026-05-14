"""Whisper-large-v3 speech-to-text via transformers' ASR pipeline."""

from __future__ import annotations

from typing import Optional

from ..hardware import get_torch_device, get_torch_dtype

_model = None


def get_model():
    global _model
    if _model is not None:
        return _model
    from transformers import pipeline  # type: ignore
    device = get_torch_device()
    dtype = get_torch_dtype()
    _model = pipeline(
        "automatic-speech-recognition",
        model="openai/whisper-large-v3",
        torch_dtype=dtype,
        device=device if device != "privateuseone" else "cpu",
    )
    return _model


def transcribe(audio_path: str, language: Optional[str] = None) -> str:
    pipe = get_model()
    kwargs: dict = {}
    if language:
        kwargs["generate_kwargs"] = {"language": language}
    result = pipe(audio_path, **kwargs)
    text = result.get("text") if isinstance(result, dict) else None
    return text or ""


def unload() -> None:
    global _model
    _model = None
    try:
        import torch  # type: ignore
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except ImportError:
        pass
