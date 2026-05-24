"""Local music generation tiers for the Media AI screen.

The implementation uses ACE-Step 1.5 for both supported tiers:

* 4 GB: ACE-Step 1.5 Turbo in DiT-only mode. This is the low-VRAM path the
  user asked us to validate first.
* 12 GB: ACE-Step 1.5 XL Turbo with the 0.6B planner. This is a more practical
  high-quality 12 GB target than the YuE community fork because it stays on the
  same maintained ACE-Step API and supports non-CUDA backends.

Model downloads are explicit. Generation requires the chosen tier to already
be present so the UI can show a real progress bar instead of hiding a multi-GB
download behind the Generate button.
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


class MusicTier(TypedDict):
    id: str
    label: str
    description: str
    vram_mb: int
    download_size_mb: int
    backends: list[str]
    hf_repos: list[str]
    config_path: str
    lm_model_path: Optional[str]
    uses_lm: bool
    inference_steps: int
    repo_url: str


MUSIC_TIERS: list[MusicTier] = [
    {
        "id": "ace-step-xl-turbo-12gb",
        "label": "ACE-Step 1.5 XL Turbo (12 GB)",
        "description": (
            "Higher-fidelity 4B DiT decoder with the 0.6B planner enabled. "
            "Best quality currently wired into OrianBuilder, with vocals, "
            "instruments, structure tags, and 50+ language support."
        ),
        "vram_mb": 12000,
        "download_size_mb": 14000,
        "backends": ["cuda", "rocm", "mps", "metal", "cpu"],
        "hf_repos": [
            "ACE-Step/Ace-Step1.5",
            "ACE-Step/acestep-v15-xl-turbo",
            "ACE-Step/acestep-5Hz-lm-0.6B",
        ],
        "config_path": "acestep-v15-xl-turbo",
        "lm_model_path": "acestep-5Hz-lm-0.6B",
        "uses_lm": True,
        "inference_steps": 8,
        "repo_url": "https://github.com/ace-step/ACE-Step-1.5",
    },
    {
        "id": "ace-step-turbo-4gb",
        "label": "ACE-Step 1.5 Turbo (4 GB)",
        "description": (
            "Low-VRAM mode with the 0.6B planner enabled for full songs with "
            "vocals and instruments. Fast local music generation."
        ),
        "vram_mb": 4000,
        "download_size_mb": 9700,
        "backends": ["cuda", "rocm", "mps", "metal", "cpu"],
        "hf_repos": [
            "ACE-Step/Ace-Step1.5",
            "ACE-Step/acestep-5Hz-lm-0.6B",
        ],
        "config_path": "acestep-v15-turbo",
        "lm_model_path": "acestep-5Hz-lm-0.6B",
        "uses_lm": True,
        "inference_steps": 8,
        "repo_url": "https://github.com/ace-step/ACE-Step-1.5",
    },
]


COMMON_MAIN_COMPONENTS = ("vae", "Qwen3-Embedding-0.6B")
MAIN_REPO = "ACE-Step/Ace-Step1.5"
WEIGHT_FILENAMES = (
    "model.safetensors",
    "model.safetensors.index.json",
    "pytorch_model.bin",
    "pytorch_model.bin.index.json",
    "diffusion_pytorch_model.safetensors",
    "diffusion_pytorch_model.safetensors.index.json",
    "diffusion_pytorch_model.bin",
    "diffusion_pytorch_model.bin.index.json",
)


def _canonical_checkpoint_root() -> Path:
    return MODELS_DIR / "music" / "ace-step" / "checkpoints"


def _legacy_checkpoint_root() -> Path:
    # Earlier experiments in this repo placed the HF snapshot directly here.
    return MODELS_DIR / "music" / "Ace-Step1.5"


def _tier_marker_path(tier_id: str) -> Path:
    return MODELS_DIR / "music" / tier_id / ".downloaded"


def _contains_weights(path: Path) -> bool:
    if not path.is_dir():
        return False
    return any((path / filename).exists() for filename in WEIGHT_FILENAMES)


def _required_checkpoint_dirs(tier: MusicTier) -> list[str]:
    dirs = [*COMMON_MAIN_COMPONENTS, tier["config_path"]]
    if tier["lm_model_path"]:
        dirs.append(tier["lm_model_path"])
    return dirs


def _root_has_tier(root: Path, tier: MusicTier) -> bool:
    return all(_contains_weights(root / dirname) for dirname in _required_checkpoint_dirs(tier))


def _active_checkpoint_root(tier: MusicTier) -> Path:
    canonical = _canonical_checkpoint_root()
    if _root_has_tier(canonical, tier):
        return canonical
    legacy = _legacy_checkpoint_root()
    if _root_has_tier(legacy, tier):
        return legacy
    return canonical


def pick_best_music_tier(forced_tier_id: Optional[str] = None) -> MusicTier:
    if forced_tier_id:
        for tier in MUSIC_TIERS:
            if tier["id"] == forced_tier_id:
                return tier
        raise ValueError(f"Unknown music tier: {forced_tier_id!r}")

    backend = get_backend()
    vram = get_vram_mb()
    normalized_backend = "mps" if backend == "metal" else backend
    for tier in MUSIC_TIERS:
        if normalized_backend in tier["backends"] and tier["vram_mb"] <= vram:
            return tier
    return MUSIC_TIERS[-1]


def is_downloaded(tier_id: str) -> bool:
    tier = pick_best_music_tier(tier_id)
    has_files = _root_has_tier(_active_checkpoint_root(tier), tier)
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
_download_errors: dict[str, str] = {}


class DownloadProgressTracker:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.active_downloads: dict[int, tuple[float, float]] = {}
        self.tier_id: str | None = None
        self.repo_index = 0
        self.repo_count = 1

    def reset(self, tier_id: str, repo_count: int) -> None:
        with self.lock:
            self.active_downloads = {}
            self.tier_id = tier_id
            self.repo_index = 0
            self.repo_count = max(1, repo_count)
            _download_progress[tier_id] = 0.0

    def start_repo(self, repo_index: int) -> None:
        with self.lock:
            self.active_downloads = {}
            self.repo_index = repo_index
            if self.tier_id is not None:
                _download_progress[self.tier_id] = round(
                    (repo_index / self.repo_count) * 100.0,
                    1,
                )

    def finish_repo(self) -> None:
        with self.lock:
            if self.tier_id is not None:
                _download_progress[self.tier_id] = round(
                    ((self.repo_index + 1) / self.repo_count) * 100.0,
                    1,
                )

    def update(self, tqdm_id: int, downloaded: float, total: float) -> None:
        with self.lock:
            if self.tier_id is None or total <= 0:
                return
            self.active_downloads[tqdm_id] = (downloaded, total)
            total_bytes = sum(total_bytes for _, total_bytes in self.active_downloads.values())
            downloaded_bytes = sum(done for done, _ in self.active_downloads.values())
            if total_bytes <= 0:
                return
            repo_fraction = min(1.0, downloaded_bytes / total_bytes)
            overall = ((self.repo_index + repo_fraction) / self.repo_count) * 100.0
            _download_progress[self.tier_id] = round(max(0.0, min(99.9, overall)), 1)


_tracker = DownloadProgressTracker()


def _monitor_download_size(
    tier_id: str,
    checkpoint_root: Path,
    expected_bytes: int,
    stop_event: threading.Event,
) -> None:
    """Background thread: estimate progress from bytes written to checkpoint_root.

    This works regardless of whether hf_transfer or hf_xet are active — both
    bypass Python tqdm callbacks, making the TierTqdm monkey-patch ineffective.
    """
    if expected_bytes <= 0:
        return
    while not stop_event.wait(2.0):
        try:
            total = sum(
                f.stat().st_size
                for f in checkpoint_root.rglob("*")
                if f.is_file()
            )
            progress = min(99.0, (total / expected_bytes) * 100.0)
            current = _download_progress.get(tier_id, 0.0)
            if progress > current:
                _download_progress[tier_id] = round(progress, 1)
        except Exception:
            pass


def _root_has_any_of_tier(root: Path, tier: MusicTier) -> bool:
    return any(_contains_weights(root / dirname) for dirname in _required_checkpoint_dirs(tier))


def is_downloading(tier_id: str) -> bool:
    return tier_id in _downloading


def tier_status(tier_id: str) -> str:
    if is_downloading(tier_id):
        return "downloading"
    if is_downloaded(tier_id):
        return "downloaded"
    tier = pick_best_music_tier(tier_id)
    root = _active_checkpoint_root(tier)
    if _root_has_any_of_tier(root, tier):
        return "partially_downloaded"
    return "not_downloaded"


def get_download_error(tier_id: str) -> str | None:
    """Return the last download error for *tier_id*, or ``None``."""
    return _download_errors.get(tier_id)


def _snapshot_download_with_progress(
    *,
    repo_id: str,
    local_dir: Path,
    repo_index: int,
    allow_patterns: list[str] | None = None,
) -> None:
    from huggingface_hub import snapshot_download  # type: ignore

    _tracker.start_repo(repo_index)
    snapshot_download(
        repo_id=repo_id,
        local_dir=str(local_dir),
        cache_dir=str(HF_CACHE_DIR),
        local_dir_use_symlinks=False,
        allow_patterns=allow_patterns,
    )
    _tracker.finish_repo()


def _download_main_components(tier: MusicTier, checkpoint_root: Path, repo_index: int) -> None:
    patterns = [f"{component}/*" for component in COMMON_MAIN_COMPONENTS]
    if tier["config_path"] == "acestep-v15-turbo":
        patterns.append("acestep-v15-turbo/*")
    _snapshot_download_with_progress(
        repo_id=MAIN_REPO,
        local_dir=checkpoint_root,
        repo_index=repo_index,
        allow_patterns=patterns,
    )


def _download_tier_repos(tier: MusicTier, checkpoint_root: Path) -> None:
    repos: list[tuple[str, Path, list[str] | None]] = [
        (MAIN_REPO, checkpoint_root, None),
    ]

    if tier["config_path"] != "acestep-v15-turbo":
        repos.append(
            (
                f"ACE-Step/{tier['config_path']}",
                checkpoint_root / tier["config_path"],
                None,
            )
        )
    if tier["lm_model_path"]:
        repos.append(
            (
                f"ACE-Step/{tier['lm_model_path']}",
                checkpoint_root / tier["lm_model_path"],
                None,
            )
        )

    _tracker.reset(tier["id"], len(repos))
    _download_main_components(tier, checkpoint_root, repo_index=0)
    for repo_index, (repo_id, local_dir, allow_patterns) in enumerate(repos[1:], start=1):
        log.info("downloading music repo=%s -> %s", repo_id, local_dir)
        _snapshot_download_with_progress(
            repo_id=repo_id,
            local_dir=local_dir,
            repo_index=repo_index,
            allow_patterns=allow_patterns,
        )


def download_tier(tier_id: str) -> None:
    """Download model weights for a tier. Safe to run in a background thread.

    Always runs the full HF snapshot_download sequence so that missing
    components (e.g. the LM planner added after initial download) are fetched.
    HF Hub is idempotent — files already on disk are validated and skipped.
    """
    tier = pick_best_music_tier(tier_id)

    # Invalidate any stale marker from a previous tier config that had fewer
    # required components (e.g. before the LM planner was added).
    try:
        stale_marker = _tier_marker_path(tier_id)
        if stale_marker.exists():
            stale_marker.unlink()
    except OSError:
        pass

    with _download_lock:
        if tier_id in _downloading:
            return
        _downloading.add(tier_id)

    checkpoint_root = _canonical_checkpoint_root()
    checkpoint_root.mkdir(parents=True, exist_ok=True)
    HF_CACHE_DIR.mkdir(parents=True, exist_ok=True)

    # Filesystem monitor gives real progress even when hf_transfer/hf_xet are
    # active (both use Rust/C downloaders that skip Python tqdm callbacks).
    expected_bytes = tier["download_size_mb"] * 1024 * 1024
    stop_monitor = threading.Event()
    monitor = threading.Thread(
        target=_monitor_download_size,
        args=(tier_id, checkpoint_root, expected_bytes, stop_monitor),
        daemon=True,
    )
    monitor.start()

    try:
        import huggingface_hub.utils as hf_utils

        original_tqdm = hf_utils.tqdm

        class TierTqdm(original_tqdm):  # type: ignore[misc, valid-type]
            def update(self, n: int = 1) -> Any:
                result = super().update(n)
                unit = getattr(self, "unit", "")
                total = getattr(self, "total", None)
                if total and total > 100_000 and (unit in ("B", "iB", "bytes") or getattr(self, "unit_scale", False)):
                    _tracker.update(id(self), float(getattr(self, "n", 0)), float(total))
                return result

        hf_utils.tqdm = TierTqdm
        try:
            log.info("downloading music tier=%s", tier_id)
            _download_tier_repos(tier, checkpoint_root)
        finally:
            hf_utils.tqdm = original_tqdm

        if not _root_has_tier(checkpoint_root, tier):
            missing = [
                dirname
                for dirname in _required_checkpoint_dirs(tier)
                if not _contains_weights(checkpoint_root / dirname)
            ]
            raise RuntimeError(f"Downloaded files are incomplete. Missing: {', '.join(missing)}")

        marker = _tier_marker_path(tier_id)
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.touch()
        _download_progress[tier_id] = 100.0
        _download_errors.pop(tier_id, None)
        log.info("music tier %s downloaded", tier_id)
    except Exception as exc:  # noqa: BLE001
        log.exception("download failed for tier %s", tier_id)
        _download_errors[tier_id] = str(exc)
    finally:
        stop_monitor.set()
        _downloading.discard(tier_id)


_dit_handler: Any = None
_llm_handler: Any = None
_loaded_tier_id: Optional[str] = None
_model_lock = threading.Lock()


def _evict() -> None:
    global _dit_handler, _llm_handler, _loaded_tier_id
    try:
        if _llm_handler is not None and hasattr(_llm_handler, "unload"):
            _llm_handler.unload()
    except Exception:
        log.exception("failed to unload ACE-Step LM")
    _dit_handler = None
    _llm_handler = None
    _loaded_tier_id = None
    gc.collect()
    try:
        import torch  # type: ignore

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


def _configure_acestep_runtime(checkpoint_root: Path) -> None:
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    os.environ.setdefault("ACESTEP_DISABLE_TQDM", "1")
    os.environ["ACESTEP_CHECKPOINTS_DIR"] = str(checkpoint_root)
    os.environ["HF_HOME"] = str(HF_CACHE_DIR)

    # ACE-Step treats the default 1.7B LM as part of the "main" model. For
    # OrianBuilder we download only common components plus the selected DiT/LM
    # tier, so patch the downloader's main-component check before initialization.
    try:
        import acestep.model_downloader as model_downloader  # type: ignore

        model_downloader.MAIN_MODEL_COMPONENTS = list(COMMON_MAIN_COMPONENTS)
    except Exception:
        # Import errors are reported later with a clearer setup message.
        pass


def _acestep_device() -> str:
    device = get_torch_device()
    if device == "privateuseone":
        return "cpu"
    if device == "mps":
        return "mps"
    if device == "cuda":
        return "cuda"
    return "cpu"


def _can_quantize(device: str) -> bool:
    return device in ("cuda", "xpu")


def _split_prompt(prompt: str) -> tuple[str, str, bool]:
    """Parse the user prompt into (caption, lyrics, instrumental).

    ACE-Step requires a non-empty ``lyrics`` string to generate vocals.
    If the user supplies structure tags (``[verse]``, ``[chorus]`` etc.) or
    multi-line text they are passed through verbatim.  For short prompts
    without tags we wrap the text inside a ``[verse]`` tag so the model
    knows to synthesise vocals instead of falling back to instrumental.
    """
    cleaned = prompt.replace("\\n", "\n").replace("\\r", "\r").strip()
    lower = cleaned.lower()
    is_instrumental = "instrumental" in lower and "[instrumental]" not in lower
    has_lyric_tags = any(tag in lower for tag in ("[verse", "[chorus", "[bridge", "[intro", "[outro"))
    has_many_lines = cleaned.count("\n") >= 3

    if is_instrumental:
        return cleaned[:512], "[Instrumental]", True
    if has_lyric_tags or has_many_lines:
        first_line = next((line.strip() for line in cleaned.splitlines() if line.strip()), "")
        caption = first_line if first_line and not first_line.startswith("[") else "vocal song with structured lyrics"
        return caption[:512], cleaned[:4096], False

    # Simple prompt without explicit lyrics — wrap in [verse] so the DiT
    # receives a structure tag and the LM planner knows vocals are wanted.
    return cleaned[:512], f"[verse]\n{cleaned}\n", False


def _load_tier(tier: MusicTier, checkpoint_root: Path) -> None:
    global _dit_handler, _llm_handler, _loaded_tier_id
    if _dit_handler is not None and _loaded_tier_id == tier["id"]:
        # If the tier config now requires the LM but it was loaded without
        # one (e.g. the 4 GB tier was upgraded to include the planner),
        # force a full reload so the LLM handler gets initialised.
        if tier["uses_lm"] and _llm_handler is None:
            log.info("tier %s now requires LM planner — forcing reload", tier["id"])
        else:
            return

    try:
        from acestep.handler import AceStepHandler  # type: ignore
        from acestep.llm_inference import LLMHandler  # type: ignore
    except ImportError as exc:
        raise RuntimeError(
            "ACE-Step 1.5 is not installed. Click Auto Setup Music AI to install "
            "the music runtime, then start the backend again."
        ) from exc

    _evict()
    _configure_acestep_runtime(checkpoint_root)

    device = _acestep_device()
    quantization = "int8_weight_only" if _can_quantize(device) else None
    use_offload = tier["vram_mb"] <= 12000

    dit_handler = AceStepHandler()
    status, ok = dit_handler.initialize_service(
        project_root=str(checkpoint_root.parent),
        config_path=tier["config_path"],
        device=device,
        compile_model=False,
        offload_to_cpu=use_offload,
        offload_dit_to_cpu=tier["vram_mb"] <= 4000,
        quantization=quantization,
        use_flash_attention=False,
    )
    if not ok:
        raise RuntimeError(status)

    llm_handler = None
    if tier["uses_lm"] and tier["lm_model_path"]:
        llm_handler = LLMHandler()
        lm_status, lm_ok = llm_handler.initialize(
            checkpoint_dir=str(checkpoint_root),
            lm_model_path=tier["lm_model_path"],
            backend="pt",
            device=device,
            offload_to_cpu=True,
        )
        if not lm_ok:
            raise RuntimeError(lm_status)

    _dit_handler = dit_handler
    _llm_handler = llm_handler
    _loaded_tier_id = tier["id"]


def generate_music(
    prompt: str,
    duration_seconds: float = 15.0,
    forced_tier_id: Optional[str] = None,
    inference_steps: Optional[int] = None,
    use_cot_lyrics: Optional[bool] = None,
) -> bytes:
    """Generate a WAV file from a prompt using a previously downloaded tier."""
    tier = pick_best_music_tier(forced_tier_id)
    tier_id = tier["id"]
    if not is_downloaded(tier_id):
        raise RuntimeError(
            f"{tier['label']} is not downloaded yet. Download the model from the Music tab first."
        )

    duration_seconds = max(10.0, min(float(duration_seconds), 600.0))
    checkpoint_root = _active_checkpoint_root(tier)

    with _model_lock:
        _load_tier(tier, checkpoint_root)

        try:
            from acestep.inference import (  # type: ignore
                GenerationConfig,
                GenerationParams,
                generate_music as acestep_generate_music,
            )
        except ImportError as exc:
            raise RuntimeError("ACE-Step 1.5 inference API is unavailable.") from exc

        caption, lyrics, instrumental = _split_prompt(prompt)
        params = GenerationParams(
            task_type="text2music",
            caption=caption,
            lyrics=lyrics,
            instrumental=instrumental,
            duration=duration_seconds,
            inference_steps=inference_steps if inference_steps is not None else tier["inference_steps"],
            shift=3.0,
            thinking=tier["uses_lm"],
            use_cot_metas=tier["uses_lm"],
            use_cot_caption=tier["uses_lm"],
            use_cot_language=tier["uses_lm"],
            use_cot_lyrics=use_cot_lyrics if use_cot_lyrics is not None else tier["uses_lm"],
        )
        config = GenerationConfig(
            batch_size=1,
            use_random_seed=True,
            lm_batch_chunk_size=1,
            audio_format="wav",
        )

        import tempfile

        with tempfile.TemporaryDirectory(prefix="orianbuilder-music-") as tmp:
            result = acestep_generate_music(
                _dit_handler,
                _llm_handler,
                params,
                config,
                save_dir=tmp,
            )
            if not result.success:
                raise RuntimeError(result.error or result.status_message or "ACE-Step generation failed")
            if not result.audios:
                raise RuntimeError("ACE-Step did not return any audio.")

            audio = result.audios[0]
            path = audio.get("path")
            if path and Path(path).exists():
                return Path(path).read_bytes()

            tensor = audio.get("tensor")
            sample_rate = int(audio.get("sample_rate") or 48000)
            if tensor is None:
                raise RuntimeError("ACE-Step returned audio without a file path or tensor.")

            import soundfile as sf  # type: ignore

            array = tensor.detach().cpu().numpy() if hasattr(tensor, "detach") else tensor
            if getattr(array, "ndim", 1) == 2 and array.shape[0] <= 8:
                array = array.T
            buf = io.BytesIO()
            sf.write(buf, array, sample_rate, format="WAV")
            return buf.getvalue()


def unload() -> None:
    _evict()
