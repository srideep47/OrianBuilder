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
    # If a GPU backend was requested, verify torch actually supports it before
    # trusting it — avoids confusing failures when a CPU torch wheel is installed.
    if _RAW_BACKEND in ("cuda", "rocm"):
        try:
            import torch  # type: ignore
            if torch.cuda.is_available():
                return _RAW_BACKEND
            import logging as _log
            _log.getLogger(__name__).warning(
                "Backend '%s' requested but CUDA unavailable — falling back to CPU", _RAW_BACKEND
            )
        except ImportError:
            pass
        return "cpu"
    if _RAW_BACKEND != "cpu":
        return _RAW_BACKEND
    # Electron may not have nvidia-smi in PATH, causing it to send "cpu" even
    # on CUDA machines. Auto-promote when torch can see a CUDA device.
    try:
        import torch  # type: ignore
        if torch.cuda.is_available():
            return "cuda"
    except Exception:
        pass
    return _RAW_BACKEND


def get_vendor() -> str:
    return _RAW_VENDOR


def get_vram_mb() -> int:
    try:
        mb = max(0, int(_RAW_VRAM))
        if mb > 0:
            return mb
    except ValueError:
        pass
    # If env var is 0, auto-detect from torch.
    try:
        import torch  # type: ignore
        if torch.cuda.is_available():
            props = torch.cuda.get_device_properties(torch.cuda.current_device())
            return props.total_memory // (1024 * 1024)
    except Exception:
        pass
    return 0


def get_torch_device() -> str:
    """Return the torch device string for the active backend.

    Calls get_backend() (not _RAW_BACKEND) so CUDA auto-promotion applies
    even when the env var was set to 'cpu' due to a startup race condition.
    """
    backend = get_backend()
    if backend in ("cuda", "rocm"):
        # ROCm PyTorch builds surface devices as "cuda" too.
        return "cuda"
    if backend in ("metal", "mps"):
        return "mps"
    if backend == "directml":
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
    backend = get_backend()
    if backend == "cuda":
        # fp16 works on most CUDA GPUs (Kepler+), but GTX 16xx cards produce
        # NaN activations in fp16 diffusion UNets (verified: black images on a
        # GTX 1650 Ti even with attention upcast). Those cards must run fp32 —
        # pair with CPU offload so the weights still fit a 4 GB card.
        if is_fp16_unreliable_gpu():
            return torch.float32
        return torch.float16
    if backend in ("rocm", "mps", "metal"):
        return torch.float16
    if backend == "directml":
        return torch.float16
    return torch.float32


def is_fp16_unreliable_gpu() -> bool:
    """True for GPUs whose float16 stable-diffusion path is known-broken.

    GTX 16xx (Turing TU11x) cards famously emit NaNs during fp16 VAE decode,
    which surfaces as solid-black images/videos. The standard community fix
    (A1111's --no-half-vae) is to run the VAE in float32 — see
    force_fp32_vae() below."""
    try:
        import torch  # type: ignore

        if torch.cuda.is_available():
            name = torch.cuda.get_device_name(0).upper()
            return "GTX 16" in name
    except Exception:  # noqa: BLE001
        pass
    return False


def force_fp32_vae(pipe) -> None:
    """Upcast a diffusers pipeline's VAE to float32 and transparently cast
    incoming latents. Apply on is_fp16_unreliable_gpu() hardware — fp16
    UNet inference stays fast, while the decode (where the NaNs appear)
    runs in full precision (~330 MB extra VRAM for an SD-family VAE)."""
    import torch  # type: ignore

    vae = getattr(pipe, "vae", None)
    if vae is None:
        return
    vae.to(dtype=torch.float32)
    orig_decode = vae.decode

    def _decode_fp32(z, *args, **kwargs):
        return orig_decode(z.to(torch.float32), *args, **kwargs)

    vae.decode = _decode_fp32


def describe() -> dict:
    return {
        "backend": _RAW_BACKEND,
        "vendor": _RAW_VENDOR,
        "vram_mb": get_vram_mb(),
        "torch_device": get_torch_device(),
        "fp16_unreliable": is_fp16_unreliable_gpu(),
    }
