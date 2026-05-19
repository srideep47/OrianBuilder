"""Hardware-awareness shim. Reads env vars injected by the Electron host
(media_ai_backend.ts) and exposes them to model loaders so each backend can
pick the right device and the right tier of model."""

from __future__ import annotations

import os
from typing import Literal

Backend = Literal["cuda", "rocm", "metal", "mps", "vulkan", "directml", "openvino", "cpu"]

# Normalize whatever the TS layer sent us — defaults to "cpu" when nothing is set.
_RAW_BACKEND = os.environ.get("ORIANBUILDER_HARDWARE_BACKEND", "cpu").lower()
_RAW_VRAM = os.environ.get("ORIANBUILDER_GPU_VRAM_MB", "0")
_RAW_VENDOR = os.environ.get("ORIANBUILDER_GPU_VENDOR", "unknown").lower()


def get_backend() -> str:
    return _RAW_BACKEND


def get_vendor() -> str:
    return _RAW_VENDOR


def get_vram_mb() -> int:
    try:
        return max(0, int(_RAW_VRAM))
    except ValueError:
        return 0


def get_torch_device() -> str:
    """Return the torch device string for the active backend."""
    if _RAW_BACKEND == "cuda":
        return "cuda"
    if _RAW_BACKEND == "rocm":
        # PyTorch ROCm builds expose the device as "cuda" too.
        return "cuda"
    if _RAW_BACKEND in ("metal", "mps"):
        return "mps"
    if _RAW_BACKEND == "directml":
        # torch-directml binds via privateuseone.
        return "privateuseone"
    return "cpu"


def get_torch_dtype():
    """Return the recommended torch dtype for this backend. Imports torch
    lazily so this module can be imported by code paths that don't actually
    need torch."""
    try:
        import torch
    except ImportError:
        return None
    if _RAW_BACKEND == "cuda" and _RAW_VENDOR == "nvidia":
        return torch.float16
    if _RAW_BACKEND in ("rocm", "mps", "metal"):
        return torch.float16
    if _RAW_BACKEND == "directml":
        return torch.float16
    return torch.float32


def describe() -> dict:
    return {
        "backend": _RAW_BACKEND,
        "vendor": _RAW_VENDOR,
        "vram_mb": get_vram_mb(),
        "torch_device": get_torch_device(),
    }
