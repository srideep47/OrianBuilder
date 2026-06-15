"""Tiered image generation. Picks the best diffusion model that fits in
the active backend's VRAM, falls back through the tier list down to a
CPU-only ONNX SD 1.5.

Tier order matters: pick_best_tier walks the list top-to-bottom and
returns the first tier whose vram_mb fits the live VRAM budget.
"""

from __future__ import annotations

import gc
import io
import logging
import os
from pathlib import Path
from typing import Optional, TypedDict

from ..hardware import get_backend, get_torch_device, get_torch_dtype, get_vram_mb

log = logging.getLogger(__name__)


class ImageTier(TypedDict):
    id: str
    repo: Optional[str]
    filename: Optional[str]   # single-file download (GGUF); None = snapshot_download
    vram_mb: int
    download_size_mb: int
    backends: list[str]
    label: str


# Mirrors src/shared/media_tiers.ts IMAGE_MODEL_TIERS.
# When you add/remove a tier here, mirror the change there or the UI will
# show stale options.
IMAGE_MODEL_TIERS: list[ImageTier] = [
    {
        # GGUF Q4_1 quantised weights — downloaded as a single file from HF
        # and stored at $OMNIGEN_MODELS_DIR/z-image-turbo-Q4_1.gguf.
        # VAE + text encoder are fetched separately from Tongyi-MAI/Z-Image-Turbo
        # on first generation and cached in the HF hub cache.
        "id": "z-image-turbo-gguf",
        "label": "Z Image Turbo Q4_1 (GGUF)",
        "repo": "Ankithareddy08/z-image-turbo-gguf",
        "filename": "z-image-turbo-Q4_1.gguf",
        "vram_mb": 0,
        "download_size_mb": 4967,
        "backends": ["cuda", "rocm", "metal", "mps", "directml", "cpu"],
    },
    {
        # Alibaba Tongyi — 8-step, best quality tier.
        # Actual disk size: transformer 24.62 GB (bf16) + text encoder 8.05 GB + VAE 0.17 GB ≈ 32.85 GB.
        # Uses enable_sequential_cpu_offload on consumer GPUs (< 40 GB VRAM) — slow but correct.
        # Prefer z-image-turbo-gguf (13.1 GB total, fully GPU-resident on 16 GB cards).
        "id": "z-image-turbo",
        "label": "Z Image Turbo",
        "repo": "Tongyi-MAI/Z-Image-Turbo",
        "filename": None,
        "vram_mb": 8000,
        "download_size_mb": 32850,
        "backends": ["cuda", "rocm", "metal", "mps"],
    },
    {
        # 1-step SDXL — 1024×1024, good quality, fits 6 GB.
        "id": "sdxl-turbo",
        "label": "SDXL Turbo",
        "repo": "stabilityai/sdxl-turbo",
        "filename": None,
        "vram_mb": 6000,
        "download_size_mb": 7000,
        "backends": ["cuda", "rocm", "metal", "mps", "directml"],
    },
    {
        # 1-step budget model — auto-selected for GPUs under 6 GB (e.g. 4 GB).
        "id": "sd-turbo",
        "label": "SD Turbo",
        "repo": "stabilityai/sd-turbo",
        "filename": None,
        "vram_mb": 3000,
        "download_size_mb": 1700,
        "backends": ["cuda", "rocm", "metal", "mps", "directml"],
    },
    {
        "id": "sd-1.5",
        "label": "Stable Diffusion 1.5",
        "repo": "runwayml/stable-diffusion-v1-5",
        "filename": None,
        "vram_mb": 4000,
        "download_size_mb": 4000,
        "backends": ["cuda", "rocm", "metal", "mps", "directml"],
    },
    {
        "id": "sd-1.5-onnx-cpu",
        "label": "SD 1.5 ONNX (CPU)",
        "repo": "nmkd/stable-diffusion-1.5-onnx-fp16",
        "filename": None,
        "vram_mb": 0,
        "download_size_mb": 2500,
        "backends": ["cpu", "openvino", "directml"],
    },
]


_download_progress: dict[str, float] = {}
_download_errors: dict[str, str] = {}
_downloading_tiers: set[str] = set()


def tier_status(tier_id: str) -> str:
    if tier_id in _downloading_tiers:
        return "downloading"
    tier = next((t for t in IMAGE_MODEL_TIERS if t["id"] == tier_id), None)
    if not tier:
        return "not_downloaded"
    if tier["id"] == "z-image-turbo-gguf":
        return "downloaded" if os.path.isfile(_gguf_path()) else "not_downloaded"
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
    tier = next((t for t in IMAGE_MODEL_TIERS if t["id"] == tier_id), None)
    if not tier or not tier.get("repo"):
        return
    _downloading_tiers.add(tier_id)
    _download_errors.pop(tier_id, None)
    try:
        filename = tier.get("filename")
        if filename:
            # Single-file download (e.g. GGUF). Download directly into the
            # models directory so the rest of the code finds it at _gguf_path().
            from huggingface_hub import hf_hub_download  # type: ignore
            dest_dir = os.path.dirname(_gguf_path())
            os.makedirs(dest_dir, exist_ok=True)
            hf_hub_download(
                repo_id=tier["repo"],
                filename=filename,
                local_dir=dest_dir,
            )
        else:
            # Full repo snapshot (all other tiers — diffusers, ONNX, etc.)
            from huggingface_hub import snapshot_download  # type: ignore
            snapshot_download(repo_id=tier["repo"])
    except Exception as exc:  # noqa: BLE001
        _download_errors[tier_id] = str(exc)
    finally:
        _downloading_tiers.discard(tier_id)
        _download_progress.pop(tier_id, None)


def delete_tier(tier_id: str) -> None:
    """Remove a downloaded image tier's weights from disk so the UI can free
    space. Mirrors download_tier: the GGUF tier deletes its single local file,
    every other tier removes the HuggingFace cache directory that tier_status
    checks. Unloads the pipeline first if this tier is the one loaded, so the
    weight files aren't held open (Windows refuses to delete locked files)."""
    import shutil

    tier = next((t for t in IMAGE_MODEL_TIERS if t["id"] == tier_id), None)
    if not tier:
        return
    if _pipeline_tier_id == tier_id:
        unload_pipeline()
    if tier["id"] == "z-image-turbo-gguf":
        try:
            gguf = _gguf_path()
            if os.path.isfile(gguf):
                os.remove(gguf)
        except OSError as exc:  # noqa: BLE001
            log.warning("failed to delete gguf for %s: %s", tier_id, exc)
        _download_errors.pop(tier_id, None)
        return
    repo = tier.get("repo")
    if repo:
        hf_home = os.environ.get("HF_HOME", "")
        cache_dir = (
            Path(hf_home) / "hub"
            if hf_home
            else Path.home() / ".cache" / "huggingface" / "hub"
        )
        repo_dir = cache_dir / f"models--{repo.replace('/', '--')}"
        shutil.rmtree(repo_dir, ignore_errors=True)
    _download_errors.pop(tier_id, None)


def _gguf_path() -> str:
    models_dir = os.getenv("OMNIGEN_MODELS_DIR", "")
    return os.path.join(models_dir, "z-image-turbo-Q4_1.gguf")


def pick_best_tier(forced_tier_id: Optional[str] = None) -> ImageTier:
    backend = get_backend()
    gguf_tier = next(
        (t for t in IMAGE_MODEL_TIERS if t["id"] == "z-image-turbo-gguf"), None
    )
    gguf_available = (
        gguf_tier is not None
        and os.path.isfile(_gguf_path())
        and backend in gguf_tier["backends"]
    )

    if forced_tier_id:
        # The GGUF build IS Z-Image-Turbo (Q4_1 quantised). On a consumer GPU it
        # loads fully into VRAM (fast) and uses ~13 GB system RAM vs the bf16
        # build's ~32 GB. So when z-image-turbo is requested (e.g. storyboard
        # keyframes) and the GGUF is present, serve the GGUF: far faster AND it
        # leaves the RAM the video model (Wan 2.2 14B) needs free.
        if forced_tier_id in ("z-image-turbo", "z-image-turbo-gguf") and gguf_available:
            return gguf_tier  # type: ignore[return-value]
        for tier in IMAGE_MODEL_TIERS:
            if tier["id"] == forced_tier_id:
                return tier

    vram = get_vram_mb()
    for tier in IMAGE_MODEL_TIERS:
        if tier["id"] == "z-image-turbo-gguf":
            # Loaded via diffusers Lumina2Transformer2DModel + GGUFQuantizationConfig.
            # Transformer weights come from the local GGUF; VAE + text encoder are
            # fetched from HuggingFace on first run and cached.
            if gguf_available:
                return tier  # type: ignore[return-value]
            continue
        if backend in tier["backends"] and tier["vram_mb"] <= vram:
            return tier
    return IMAGE_MODEL_TIERS[-1]


_pipeline = None
_pipeline_tier_id: Optional[str] = None
_pipeline_device: Optional[str] = None   # track which device the cache is on


def _place_sd_pipeline(pipe, device: str):
    """Move an SD-family pipeline to its device. GTX 16xx cards run fp32
    (get_torch_dtype upcasts them because fp16 UNets emit NaNs there), and
    fp32 SD weights (~5 GB) don't fit a 4 GB card whole — module-level CPU
    offload keeps peak VRAM under ~3.7 GB (measured on a GTX 1650 Ti)."""
    import torch  # type: ignore

    from ..hardware import is_fp16_unreliable_gpu

    needs_offload = (
        device == "cuda"
        and is_fp16_unreliable_gpu()
        and get_torch_dtype() == torch.float32
    )
    if needs_offload:
        log.info("GTX 16xx-class GPU — fp32 pipeline with model CPU offload")
        try:
            pipe.enable_model_cpu_offload()
            return pipe
        except Exception as exc:  # noqa: BLE001
            log.warning("model_cpu_offload failed (%s); using plain .to()", exc)
    return pipe.to(device)


def _enable_memory_savers(pipe) -> None:
    """Apply the cheapest memory savers that don't hurt quality.
    These are no-ops for models that don't support them."""
    for fn_name in (
        "enable_attention_slicing",
        "enable_vae_slicing",
        "enable_vae_tiling",
    ):
        fn = getattr(pipe, fn_name, None)
        if callable(fn):
            try:
                fn()
            except Exception:  # noqa: BLE001 — savers are optional
                pass


def get_pipeline(forced_tier_id: Optional[str] = None):
    """Lazy-load the appropriate pipeline for the active backend.
    Returns the cached instance after the first call. When forced_tier_id is
    given, replaces the cache with that tier.

    The cache is keyed on BOTH tier id AND device so a CPU-cached pipeline is
    evicted and reloaded on GPU when CUDA becomes available (e.g. after the
    first generation triggered auto-detection of CUDA via torch).
    """
    global _pipeline, _pipeline_tier_id, _pipeline_device

    tier = pick_best_tier(forced_tier_id)
    device = get_torch_device()
    dtype = get_torch_dtype()

    if (
        _pipeline is not None
        and _pipeline_tier_id == tier["id"]
        and _pipeline_device == device
    ):
        return _pipeline

    if _pipeline is not None:
        log.info(
            "evicting cached pipeline (was %s on %s, need %s on %s)",
            _pipeline_tier_id, _pipeline_device, tier["id"], device,
        )
        unload_pipeline()
    log.info(
        "loading image tier id=%s repo=%s device=%s dtype=%s",
        tier["id"],
        tier["repo"],
        device,
        dtype,
    )

    if tier["id"] == "z-image-turbo-gguf":
        import torch  # type: ignore
        try:
            from diffusers import GGUFQuantizationConfig, ZImagePipeline  # type: ignore
            from diffusers import ZImageTransformer2DModel  # type: ignore
        except ImportError as _imp_err:
            raise RuntimeError(
                "diffusers>=0.33.0 is required for the z-image-turbo-gguf tier. "
                "Run: pip install -U 'diffusers>=0.33.0'"
            ) from _imp_err
        # The gguf parser is a runtime dependency of GGUFQuantizationConfig.
        # Without it, diffusers silently falls back to torch's safetensors
        # loader and crashes with "Unable to load weights from checkpoint file"
        # — which gives the user no clue what to install. Check up front.
        try:
            import gguf  # type: ignore  # noqa: F401
        except ImportError as _imp_err:
            raise RuntimeError(
                "The 'gguf' Python package is required to load Z-Image-Turbo "
                "GGUF weights. Click 'Reinstall Dependencies' on the Media AI "
                "page, or run: pip install 'gguf>=0.10.0'"
            ) from _imp_err

        _hf_model_dir = os.path.join(
            os.getenv("HF_HOME", ""),
            "hub", "models--Tongyi-MAI--Z-Image-Turbo",
        )
        _snaps_dir = os.path.join(_hf_model_dir, "snapshots")
        _snaps = sorted(os.listdir(_snaps_dir)) if os.path.isdir(_snaps_dir) else []
        if not _snaps:
            raise RuntimeError(
                "Z-Image-Turbo HF snapshot not found. Re-download the model from the Media AI page."
            )
        transformer_cfg = os.path.join(_hf_model_dir, "snapshots", _snaps[-1], "transformer")
        active_backend = get_backend()
        compute_dtype = torch.bfloat16 if active_backend != "cpu" else torch.float32

        # Load quantised transformer from local GGUF; text encoder + VAE come
        # from the already-cached HuggingFace snapshot (no download needed).
        _use_gpu = active_backend == "cuda" and get_vram_mb() >= 14000
        log.info(
            "z-image-turbo-gguf: vram=%d MB, use_gpu=%s",
            get_vram_mb(), _use_gpu,
        )
        transformer = ZImageTransformer2DModel.from_single_file(
            _gguf_path(),
            config=transformer_cfg,
            quantization_config=GGUFQuantizationConfig(compute_dtype=compute_dtype),
            torch_dtype=compute_dtype,
        )
        # Move the GGUF transformer to GPU BEFORE building the full pipeline so
        # that from_pretrained (text encoder + VAE) stays in CPU RAM and we can
        # move components one at a time — avoids a single large .to("cuda") call
        # that can fail if any component has a broken .to() override.
        if _use_gpu:
            transformer = transformer.to(device)
            log.info(
                "GGUF transformer on GPU, VRAM used: %d MB",
                torch.cuda.memory_allocated() // (1024 * 1024),
            )
        pipe = ZImagePipeline.from_pretrained(
            "Tongyi-MAI/Z-Image-Turbo",
            transformer=transformer,
            torch_dtype=compute_dtype,
        )
        if _use_gpu:
            # Transformer is already on GPU; move text encoder and VAE individually.
            for attr in ("text_encoder", "text_encoder_2", "vae"):
                component = getattr(pipe, attr, None)
                if component is not None:
                    try:
                        setattr(pipe, attr, component.to(device))
                        log.info(
                            "Moved %s to GPU, VRAM used: %d MB",
                            attr, torch.cuda.memory_allocated() // (1024 * 1024),
                        )
                    except Exception as _e:  # noqa: BLE001
                        log.warning("Failed to move %s to GPU (%s); keeping on CPU", attr, _e)
        elif active_backend == "cuda":
            pipe.enable_model_cpu_offload()
        else:
            pipe = pipe.to(device)
        _enable_memory_savers(pipe)
    elif tier["id"] == "z-image-turbo":
        import torch  # type: ignore
        from diffusers import DiffusionPipeline  # type: ignore

        # Z-Image is a Lumina-style flow model that produces all-black (NaN)
        # images in float16 — it MUST run in bfloat16 (matches the GGUF path
        # above and the official model card). get_torch_dtype() returns float16
        # on CUDA, which is what caused the blank black images. Fall back to
        # float32 on CPU (and on the rare CUDA device without bf16 support),
        # never float16 for this model.
        if get_backend() == "cpu":
            zimg_dtype = torch.float32
        elif device == "cuda" and not torch.cuda.is_bf16_supported():
            zimg_dtype = torch.float32
        else:
            zimg_dtype = torch.bfloat16

        pipe = DiffusionPipeline.from_pretrained(
            tier["repo"],
            torch_dtype=zimg_dtype,
        )
        # Z-Image Turbo (bf16) is 32.85 GB on disk: transformer 24.6 GB + Qwen3
        # text encoder 8 GB + VAE 0.17 GB. It cannot fit on any consumer GPU.
        # enable_sequential_cpu_offload offloads at the individual layer/block
        # level so peak VRAM stays at a few hundred MB — the only safe mode.
        # (enable_model_cpu_offload works at the component level; the 24.6 GB
        # transformer component alone exceeds 16 GB VRAM and would OOM.)
        # Only load fully to GPU on a datacenter-class card (40+ GB).
        if device == "cuda":
            if get_vram_mb() >= 40000:
                pipe = pipe.to(device)
            else:
                pipe.enable_sequential_cpu_offload()
        else:
            pipe = pipe.to(device)
        _enable_memory_savers(pipe)
    elif tier["id"] == "sd-turbo":
        from diffusers import AutoPipelineForText2Image  # type: ignore

        # variant="fp16" reuses the cached fp16 shards; torch_dtype decides the
        # compute precision (fp32 on GTX 16xx — see get_torch_dtype).
        pipe = AutoPipelineForText2Image.from_pretrained(
            tier["repo"], torch_dtype=dtype, variant="fp16"
        )
        pipe = _place_sd_pipeline(pipe, device)
        _enable_memory_savers(pipe)
    elif tier["id"] == "sdxl-turbo":
        from diffusers import AutoPipelineForText2Image  # type: ignore

        pipe = AutoPipelineForText2Image.from_pretrained(
            tier["repo"], torch_dtype=dtype, variant="fp16"
        )
        pipe = _place_sd_pipeline(pipe, device)
        _enable_memory_savers(pipe)
    elif tier["id"] == "sd-1.5":
        from diffusers import StableDiffusionPipeline  # type: ignore

        pipe = StableDiffusionPipeline.from_pretrained(
            tier["repo"], torch_dtype=dtype, safety_checker=None
        )
        pipe = _place_sd_pipeline(pipe, device)
        _enable_memory_savers(pipe)
    else:
        # CPU/ONNX fallback — defer to the existing service so we don't duplicate
        # ORT + DirectML wiring.
        from ..services.image_generation import image_generation_service

        pipe = image_generation_service  # provider-style adapter

    _pipeline = pipe
    _pipeline_tier_id = tier["id"]
    _pipeline_device = device
    return _pipeline


def unload_pipeline() -> None:
    global _pipeline, _pipeline_tier_id, _pipeline_device
    pipe = _pipeline
    _pipeline = None
    _pipeline_tier_id = None
    _pipeline_device = None
    # Strip accelerate CPU-offload hooks before dropping the reference. A model
    # loaded via enable_sequential/model_cpu_offload keeps AlignDevicesHooks +
    # pinned buffers that a plain `del` + empty_cache() can leave resident, so
    # the next model (e.g. the Wan video pipeline) OOMs. Removing the hooks lets
    # gc actually reclaim the GPU memory.
    if pipe is not None:
        try:
            from accelerate.hooks import remove_hook_from_module  # type: ignore

            for name in (
                "transformer", "unet", "text_encoder", "text_encoder_2",
                "vae", "image_encoder",
            ):
                comp = getattr(pipe, name, None)
                if comp is not None:
                    try:
                        remove_hook_from_module(comp, recurse=True)
                    except Exception:  # noqa: BLE001
                        pass
        except Exception:  # noqa: BLE001
            pass
    del pipe
    gc.collect()
    try:
        import torch  # type: ignore

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            torch.cuda.synchronize()
    except ImportError:
        pass


def _generation_params(tier_id: str, steps: int, guidance: float, w: int, h: int) -> dict:
    """Per-tier sane defaults. Turbo / schnell / Z Image Turbo all use
    very low step counts and low/no guidance."""
    if tier_id == "z-image-turbo-gguf":
        return {
            "num_inference_steps": max(4, min(steps, 8)),
            "guidance_scale": 4.0,
            "width": w,
            "height": h,
        }
    if tier_id in ("sd-turbo", "sdxl-turbo"):
        return {"num_inference_steps": 1, "guidance_scale": 0.0}
    if tier_id == "z-image-turbo":
        return {
            "num_inference_steps": max(4, min(steps, 8)),
            "guidance_scale": 0.0,
            "width": w,
            "height": h,
        }
    if tier_id == "sd-1.5":
        return {
            "num_inference_steps": steps,
            "guidance_scale": guidance,
            "width": w,
            "height": h,
        }
    return {
        "num_inference_steps": steps,
        "guidance_scale": guidance,
        "width": w,
        "height": h,
    }


def generate_image(
    prompt: str,
    steps: int = 20,
    guidance: float = 7.5,
    width: int = 512,
    height: int = 512,
    forced_tier_id: Optional[str] = None,
    seed: Optional[int] = None,
    negative_prompt: Optional[str] = None,
) -> bytes:
    pipe = get_pipeline(forced_tier_id)
    tier = pick_best_tier(forced_tier_id)
    params = _generation_params(tier["id"], steps, guidance, width, height)

    if tier["id"] == "sd-1.5-onnx-cpu":
        # ONNX fallback returns a path; read the bytes for the caller.
        from ..schemas import ImageGenerationRequest

        result = pipe.generate(
            ImageGenerationRequest(
                prompt=prompt,
                steps=steps,
                guidance=guidance,
                width=width,
                height=height,
            )
        )
        with open(result.image_path, "rb") as fh:
            return fh.read()

    # Pass seed as a torch Generator when provided.
    if seed is not None:
        import torch  # type: ignore
        generator = torch.Generator().manual_seed(seed)
        params["generator"] = generator

    call_kwargs: dict = {"prompt": prompt, **params}
    if negative_prompt and tier["id"] not in ("sd-turbo", "sdxl-turbo", "z-image-turbo-gguf"):
        call_kwargs["negative_prompt"] = negative_prompt
    image = pipe(**call_kwargs).images[0]
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return buf.getvalue()
