"""Local 3D asset generation using TripoSR (image-to-3D).

Pipeline:
    1. Background removal on the input image (rembg)
    2. TripoSR reconstructs a NeRF and extracts a triangulated mesh
    3. Mesh is exported as .glb via trimesh

For text prompts the front-end first generates a reference image with the
existing image pipeline, then feeds that PNG here.
"""

from __future__ import annotations

import gc
import io
import logging
import os
import threading
from pathlib import Path
from typing import Any, Optional, TypedDict

from ..hardware import get_backend, get_torch_device, get_vram_mb

log = logging.getLogger(__name__)

BACKEND_DIR = Path(__file__).resolve().parents[2]
MODELS_DIR = Path(os.getenv("OMNIGEN_MODELS_DIR", str(BACKEND_DIR / "models")))
HF_CACHE_DIR = Path(os.getenv("OMNIGEN_HF_CACHE_DIR", str(MODELS_DIR / "huggingface")))


class ThreeDTier(TypedDict):
    id: str
    label: str
    description: str
    vram_mb: int
    download_size_mb: int
    backends: list[str]
    hf_repo: str
    weight_filename: str
    config_filename: str
    repo_url: str


THREED_TIERS: list[ThreeDTier] = [
    {
        "id": "triposr-6gb",
        "label": "TripoSR (6 GB)",
        "description": (
            "Stability AI's TripoSR — fast image-to-3D reconstruction. "
            "Generates a textured triangle mesh from a single reference image "
            "in roughly 1 second on a 6 GB GPU. Used for both image-to-3D "
            "and text-to-3D (text is first turned into an image)."
        ),
        "vram_mb": 4000,
        "download_size_mb": 1700,
        "backends": ["cuda", "rocm", "mps", "metal", "cpu"],
        "hf_repo": "stabilityai/TripoSR",
        "weight_filename": "model.ckpt",
        "config_filename": "config.yaml",
        "repo_url": "https://github.com/VAST-AI-Research/TripoSR",
    },
]


def _tier_root(tier_id: str) -> Path:
    return MODELS_DIR / "threed" / tier_id


def _tier_marker_path(tier_id: str) -> Path:
    return _tier_root(tier_id) / ".downloaded"


def pick_best_threed_tier(forced_tier_id: Optional[str] = None) -> ThreeDTier:
    if forced_tier_id:
        for tier in THREED_TIERS:
            if tier["id"] == forced_tier_id:
                return tier
        raise ValueError(f"Unknown 3D tier: {forced_tier_id!r}")

    backend = get_backend()
    vram = get_vram_mb()
    normalized_backend = "mps" if backend == "metal" else backend
    for tier in THREED_TIERS:
        if normalized_backend in tier["backends"] and tier["vram_mb"] <= vram:
            return tier
    return THREED_TIERS[-1]


def _has_weights(tier: ThreeDTier) -> bool:
    root = _tier_root(tier["id"])
    return (root / tier["weight_filename"]).exists() and (
        root / tier["config_filename"]
    ).exists()


def is_downloaded(tier_id: str) -> bool:
    tier = pick_best_threed_tier(tier_id)
    has_files = _has_weights(tier)
    if has_files and not _tier_marker_path(tier_id).exists():
        try:
            marker = _tier_marker_path(tier_id)
            marker.parent.mkdir(parents=True, exist_ok=True)
            marker.touch()
        except OSError:
            pass
    return has_files


_download_lock = threading.Lock()
_downloading: set[str] = set()
_download_progress: dict[str, float] = {}


def is_downloading(tier_id: str) -> bool:
    return tier_id in _downloading


def tier_status(tier_id: str) -> str:
    if is_downloading(tier_id):
        return "downloading"
    if is_downloaded(tier_id):
        return "downloaded"
    return "not_downloaded"


def _monitor_download_size(
    tier_id: str,
    target_dir: Path,
    expected_bytes: int,
    stop_event: threading.Event,
) -> None:
    if expected_bytes <= 0:
        return
    while not stop_event.wait(2.0):
        try:
            total = sum(
                f.stat().st_size for f in target_dir.rglob("*") if f.is_file()
            )
            progress = min(99.0, (total / expected_bytes) * 100.0)
            current = _download_progress.get(tier_id, 0.0)
            if progress > current:
                _download_progress[tier_id] = round(progress, 1)
        except Exception:
            pass


def download_tier(tier_id: str) -> None:
    """Download TripoSR weights for the given tier. Safe in a background thread."""
    tier = pick_best_threed_tier(tier_id)
    if is_downloaded(tier_id):
        _download_progress[tier_id] = 100.0
        return

    with _download_lock:
        if tier_id in _downloading:
            return
        _downloading.add(tier_id)

    target = _tier_root(tier_id)
    target.mkdir(parents=True, exist_ok=True)
    HF_CACHE_DIR.mkdir(parents=True, exist_ok=True)

    expected_bytes = tier["download_size_mb"] * 1024 * 1024
    stop_monitor = threading.Event()
    monitor = threading.Thread(
        target=_monitor_download_size,
        args=(tier_id, target, expected_bytes, stop_monitor),
        daemon=True,
    )
    monitor.start()

    try:
        from huggingface_hub import snapshot_download  # type: ignore

        log.info("downloading 3d tier=%s repo=%s", tier_id, tier["hf_repo"])
        _download_progress[tier_id] = 0.0
        snapshot_download(
            repo_id=tier["hf_repo"],
            local_dir=str(target),
            cache_dir=str(HF_CACHE_DIR),
            local_dir_use_symlinks=False,
            allow_patterns=[
                tier["weight_filename"],
                tier["config_filename"],
            ],
        )

        if not _has_weights(tier):
            raise RuntimeError(
                f"Downloaded files are incomplete. Missing "
                f"{tier['weight_filename']} or {tier['config_filename']}."
            )

        marker = _tier_marker_path(tier_id)
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.touch()
        _download_progress[tier_id] = 100.0
        log.info("3d tier %s downloaded", tier_id)
    finally:
        stop_monitor.set()
        _downloading.discard(tier_id)


_model: Any = None
_loaded_tier_id: Optional[str] = None
_model_lock = threading.Lock()


def _evict() -> None:
    global _model, _loaded_tier_id
    _model = None
    _loaded_tier_id = None
    gc.collect()
    try:
        import torch  # type: ignore

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


def _resolve_device() -> str:
    device = get_torch_device()
    if device in ("cuda", "mps"):
        return device
    return "cpu"


def _load_tier(tier: ThreeDTier) -> None:
    global _model, _loaded_tier_id
    if _model is not None and _loaded_tier_id == tier["id"]:
        return

    # Surface the real ImportError details. Using ModuleNotFoundError to
    # distinguish "package not cloned/installed" from "ABI mismatch at runtime".
    try:
        from tsr.system import TSR  # type: ignore
    except ModuleNotFoundError as exc:
        missing = exc.name or "tsr"
        if missing == "tsr" or (missing and missing.startswith("tsr.")):
            raise RuntimeError(
                "TripoSR source is not on PYTHONPATH. Click 'Reinstall Runtime' "
                "to fetch it, then restart the backend."
            ) from exc
        raise RuntimeError(
            f"Cannot import TripoSR — missing dependency '{missing}'. "
            "Click 'Reinstall Runtime' to install it."
        ) from exc
    except ImportError as exc:
        raise RuntimeError(
            f"Failed to import TripoSR: {exc}. "
            "Click 'Reinstall Runtime' to repair the install."
        ) from exc
    except ValueError as exc:
        # "numpy.dtype size changed, may indicate binary incompatibility" is
        # raised as a ValueError by Cython extensions (pandas, numba, etc.)
        # when they were compiled against a different numpy ABI than what's
        # installed. The user can recover by clicking Reinstall Runtime.
        if "dtype size changed" in str(exc) or "binary incompatibility" in str(exc):
            raise RuntimeError(
                f"3D runtime has a numpy ABI mismatch ({exc}). "
                "Click 'Reinstall Runtime' to rebuild the environment with "
                "compatible package versions."
            ) from exc
        raise

    _evict()

    target = _tier_root(tier["id"])
    device = _resolve_device()
    log.info("loading TripoSR on device=%s", device)

    model = TSR.from_pretrained(
        str(target),
        config_name=tier["config_filename"],
        weight_name=tier["weight_filename"],
    )
    # Smaller chunk size lowers peak VRAM at a tiny speed cost — important for 6GB.
    model.renderer.set_chunk_size(8192)
    model.to(device)

    _model = model
    _loaded_tier_id = tier["id"]


def _remove_background_pil(image: Any) -> Any:
    """PIL-based background removal — drops the dominant border colour to
    transparent. Designed for AI-generated reference images that the text→3D
    pipeline produces (single subject on roughly-uniform light background).

    Strategy:
      1. Sample the full 1px border ring rather than just 4 corners — handles
         textured/gradient backgrounds where corners disagree on colour.
      2. Use the *median* of that ring (not mean) so a stray foreground pixel
         touching the edge doesn't poison the background estimate.
      3. Use a per-pixel Euclidean distance test in RGB space with a generous
         threshold — covers JPEG noise, soft shadows, and AA fringes around
         the subject. Then flood-fill from the borders to avoid eating same-
         colour pixels that are part of the subject.
    """
    from PIL import Image  # type: ignore
    import numpy as np  # type: ignore
    from scipy import ndimage  # type: ignore

    rgba = image.convert("RGBA")
    arr = np.array(rgba, dtype=np.uint8)
    h, w = arr.shape[:2]

    border = np.concatenate(
        [
            arr[0, :, :3].reshape(-1, 3),
            arr[-1, :, :3].reshape(-1, 3),
            arr[:, 0, :3].reshape(-1, 3),
            arr[:, -1, :3].reshape(-1, 3),
        ],
        axis=0,
    )
    bg_colour = np.median(border, axis=0)

    rgb = arr[:, :, :3].astype(np.float32)
    dist = np.linalg.norm(rgb - bg_colour, axis=-1)
    # Threshold ~60 in Euclidean RGB distance: tolerant enough for soft
    # backgrounds (gradient/lighting) without eating mid-tone subject pixels.
    similar = dist < 60.0

    # Label connected components of the "similar to background" mask, then
    # keep only components that actually touch the image border. This stops
    # the mask from carving holes in the subject when the subject happens to
    # share a colour with the background (e.g. a white duck on a white plate).
    labels, _n = ndimage.label(similar)
    border_labels = np.unique(
        np.concatenate(
            [labels[0, :], labels[-1, :], labels[:, 0], labels[:, -1]]
        )
    )
    border_labels = border_labels[border_labels != 0]
    bg_mask = np.isin(labels, border_labels)

    arr[bg_mask, 3] = 0
    return Image.fromarray(arr, "RGBA")


_rembg_session: Any = None


def _remove_background_rembg(image: Any) -> Optional[Any]:
    """U2Net-based background removal (the same network upstream TripoSR uses).

    Returns the RGBA cutout, or None if rembg isn't available — in which case
    the caller falls back to the PIL flood-fill. Caches the rembg session so
    we don't reload U2Net (~176 MB) on every generation.
    """
    global _rembg_session
    try:
        import rembg  # type: ignore
    except ImportError:
        return None
    # Defensive: a previous broken install may have left the package
    # importable but its onnxruntime missing.
    try:
        if _rembg_session is None:
            _rembg_session = rembg.new_session("u2net")
        return rembg.remove(image, session=_rembg_session)
    except Exception as exc:  # noqa: BLE001
        log.warning(
            "rembg failed (%s) — falling back to PIL flood-fill", exc
        )
        return None


def _preprocess_image(image_bytes: bytes, foreground_ratio: float = 0.85) -> Any:
    from PIL import Image  # type: ignore
    import numpy as np  # type: ignore
    from tsr.utils import resize_foreground  # type: ignore

    image = Image.open(io.BytesIO(image_bytes)).convert("RGBA")

    # Prefer rembg (U2Net) — the network is what upstream TripoSR uses and is
    # vastly more accurate than corner-sampling on noisy AI-generated reference
    # images. Falls back to the PIL flood-fill if rembg isn't installed.
    cleaned = _remove_background_rembg(image)
    if cleaned is None:
        cleaned = _remove_background_pil(image)
    image = resize_foreground(cleaned, foreground_ratio)

    arr = np.array(image).astype(np.float32) / 255.0
    # Alpha-composite over neutral grey — TripoSR was trained on grey backdrops.
    arr = arr[:, :, :3] * arr[:, :, 3:4] + (1 - arr[:, :, 3:4]) * 0.5
    return Image.fromarray((arr * 255.0).astype(np.uint8))


def generate_3d_from_image(
    image_bytes: bytes,
    forced_tier_id: Optional[str] = None,
    mesh_resolution: int = 256,
    foreground_ratio: float = 0.85,
) -> bytes:
    """Generate a .glb 3D mesh from a single image. Returns the GLB file bytes."""
    tier = pick_best_threed_tier(forced_tier_id)
    tier_id = tier["id"]
    if not is_downloaded(tier_id):
        raise RuntimeError(
            f"{tier['label']} is not downloaded yet. Download the model from the 3D Assets tab first."
        )

    mesh_resolution = max(32, min(int(mesh_resolution), 512))

    with _model_lock:
        _load_tier(tier)

        try:
            import torch  # type: ignore
        except ImportError as exc:
            raise RuntimeError("torch is not installed.") from exc

        try:
            import trimesh  # type: ignore  # noqa: F401
        except ImportError as exc:
            raise RuntimeError(
                "trimesh is not installed. Run 'Setup 3D AI' first."
            ) from exc

        processed = _preprocess_image(image_bytes, foreground_ratio)
        device = _resolve_device()
        with torch.no_grad():
            scene_codes = _model([processed], device=device)
            # Upstream TripoSR added has_vertex_color as a required positional
            # argument. Pass True so meshes ship with sampled vertex colours
            # — that's what the .glb viewer in the UI expects.
            meshes = _model.extract_mesh(
                scene_codes, True, resolution=mesh_resolution
            )

        if not meshes:
            raise RuntimeError("TripoSR did not return any mesh.")

        mesh = meshes[0]
        # tsr returns a trimesh.Trimesh — export directly to .glb in memory.
        glb_bytes = mesh.export(file_type="glb")
        if isinstance(glb_bytes, str):
            glb_bytes = glb_bytes.encode("utf-8")
        return bytes(glb_bytes)


def unload() -> None:
    _evict()
