"""Tiered text-to-video generation.

Five production tiers, matched to the hardware OrianBuilder actually targets,
plus a CPU fallback. Order is best → worst; pick_best_video_tier returns the
first tier whose VRAM *and* system-RAM requirements fit the live machine:

    ltx-2-av                top++ LTX-2.3 dev · synced AUDIO+VIDEO, bnb-4bit
                                  quantized at load · ≥12 GB VRAM, ≥32 GB RAM
                                  (RTX 4080 Super class — best quality)
    ltx-2-av-small          top+  LTX-2.3 DISTILLED · synced AUDIO+VIDEO,
                                  GGUF transformer, 8 steps CFG 1 — fits
                                  when (≥6 GB VRAM and ≥10 GB RAM) OR
                                  (≥4 GB VRAM and ≥30 GB RAM)
    ltx-video               top   LTX-Video 0.9 · ≥12 GB VRAM, ≥20 GB RAM
    animatediff-sd15        mid   RTX 3060 6 GB class   · ≥4.5 GB VRAM, ≥8 GB RAM
    animatediff-sd15-small  small GTX 1650 Ti 4 GB class· ≥3 GB VRAM, ≥6 GB RAM
    text-to-video-cpu       cpu   anything (256×256, slow)

The two LTX-2.3 tiers generate a synced soundtrack along with the frames
(LTX2Pipeline, diffusers ≥0.37) — callers see `has_audio: true` and skip
their own music/mux pass. LTX-2.3's text encoder is Gemma-3-27B (~42 GB bf16,
plus ~12 GB of connectors), so NO laptop holds the small tier resident: it
runs through diffusers group offloading, which streams weight groups to the
GPU as they're needed. RAM-rich machines (≥24 GB) keep the groups pinned in
system RAM; tight machines spill the offload store to DISK so peak RAM stays
in single digits — slower per step, but it is what makes a 16 GB-RAM /
6 GB-VRAM laptop viable at all. The GGUF quant is picked per machine too
(Q4_K_S rich / Q3_K_M tight). The distilled checkpoint (8 steps, guidance
1.0) is what makes a 22 B model tolerable on small cards. When the installed
diffusers has no LTX-2 support, both tiers demote themselves at load time and
selection re-runs without them — no job ever hard-fails on an old install.

Mid and small AnimateDiff share the same weights (SD 1.5 + motion adapter) —
small runs sequential CPU offload at a lower resolution so it fits in 4 GB of
VRAM while mid keeps the whole pipeline resident on the GPU.

Mirrors src/shared/media_tiers.ts VIDEO_TIERS — keep both in sync.
"""

from __future__ import annotations

import gc
import logging
import os
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Optional, TypedDict
from uuid import uuid4

from ..hardware import (
    force_fp32_vae,
    get_backend,
    get_torch_device,
    get_torch_dtype,
    get_vram_mb,
    is_fp16_unreliable_gpu,
)

log = logging.getLogger(__name__)

BACKEND_DIR = Path(__file__).resolve().parents[2]
OUTPUTS_DIR = Path(os.getenv("OMNIGEN_OUTPUTS_DIR", str(BACKEND_DIR / "outputs")))

ProgressFn = Callable[[str, Optional[float]], None]


def _get_available_ram_mb() -> int:
    """Returns available system RAM in MB. Returns 0 on platforms where we
    can't determine it (psutil missing, etc) — callers should treat 0 as
    'unknown' and proceed, not as 'no RAM'."""
    try:
        import psutil  # type: ignore

        return int(psutil.virtual_memory().available / (1024 * 1024))
    except Exception:  # noqa: BLE001
        return 0


def _get_total_ram_mb() -> int:
    """Returns total system RAM in MB, or 0 if unavailable. Prefers psutil;
    falls back to the env var the Electron host injects so RAM gating still
    works on installs whose venv predates the psutil requirement."""
    try:
        import psutil  # type: ignore

        return int(psutil.virtual_memory().total / (1024 * 1024))
    except Exception:  # noqa: BLE001
        pass
    try:
        return max(0, int(os.environ.get("ORIANBUILDER_TOTAL_RAM_MB", "0")))
    except ValueError:
        return 0


class VideoTier(TypedDict):
    id: str
    repo: Optional[str]
    # Additional HF repos the pipeline pulls at load time (e.g. the SD 1.5
    # base weights AnimateDiff's motion adapter rides on). Pre-downloaded by
    # ensure_tier_downloaded so generation never stalls on a silent fetch.
    extra_repos: list[str]
    vram_mb: int
    # Minimum TOTAL system RAM for this tier to be auto-selected. Stops a
    # 16 GB-RAM machine from picking a tier whose weights swap the OS to death.
    ram_required_mb: int
    # When set, the tier fits if ANY {vram_mb, ram_mb} pair is satisfied —
    # used for models whose weights can trade VRAM for system RAM via offload.
    # vram_mb/ram_required_mb above then act as absolute floors for display.
    any_of: Optional[list[dict]]
    # True when the model emits a synced soundtrack with the frames; the
    # result carries has_audio so callers skip their own music/mux pass.
    generates_audio: bool
    # Pipeline guidance_scale override. None = the pipeline's own default
    # (distilled checkpoints need 1.0; LTX-Video 0.9 wants 3.0).
    default_guidance: Optional[float]
    # GGUF transformer replacing the repo's full-precision one (community Q4
    # quant) — what lets the 22 B LTX-2.3 fit small cards with a ~17 GB
    # download instead of ~50 GB. Loaded via from_single_file; on any failure
    # the loader falls back to the repo transformer with bnb-4bit.
    gguf_repo: Optional[str]
    gguf_file: Optional[str]
    # snapshot_download ignore patterns for `repo` — the GGUF tier skips the
    # multi-GB transformer/ folder it replaces.
    repo_ignore_patterns: Optional[list[str]]
    download_size_mb: int
    # Peak resident RAM at load time in the chosen dtype with offload applied.
    peak_ram_mb: int
    backends: list[str]
    label: str
    default_frames: int
    max_frames: int
    default_fps: int
    default_width: int
    default_height: int
    default_steps: int


VIDEO_TIERS: list[VideoTier] = [
    {
        # TOP++ — LTX-2.3 dev (22 B, synced audio+video) in diffusers format,
        # quantized to 4-bit at load (bitsandbytes NF4 → ~12 GB transformer)
        # so it fits a 16 GB card whole. Best-quality tier for the RTX 4080
        # Super / 64 GB RAM class machine.
        "id": "ltx-2-av",
        "label": "LTX-2.3 (synced audio+video · best)",
        "repo": os.getenv("OMNIGEN_LTX2_REPO", "diffusers/LTX-2.3-Diffusers"),
        "extra_repos": [],
        "vram_mb": 12000,
        # Model offload keeps the inactive quantized component (~14 GB Gemma-3
        # text encoder or ~11 GB transformer) plus the bf16 connectors in RAM.
        "ram_required_mb": 32000,
        "any_of": None,
        "generates_audio": True,
        # Pipeline default guidance (4.0) is the recommended setting.
        "default_guidance": None,
        "gguf_repo": None,
        "gguf_file": None,
        "repo_ignore_patterns": None,
        # Whole repo: 40 GB transformer + 42 GB Gemma-3 TE + 12 GB connectors
        # + VAEs/vocoder.
        "download_size_mb": 96000,
        "peak_ram_mb": 28000,
        "backends": ["cuda", "rocm"],
        "default_frames": 121,
        "max_frames": 241,
        "default_fps": 24,
        "default_width": 768,
        "default_height": 512,
        "default_steps": 40,
    },
    {
        # TOP+ — LTX-2.3 DISTILLED with a community GGUF transformer (Q4_K_S
        # 16.7 GB / Q3_K_M 14.7 GB instead of the 40 GB bf16 one), run via
        # group offloading (see _enable_ltx2_group_offload). Distillation
        # (8 steps, CFG 1) is what makes a 22 B model tolerable on small
        # cards. any_of encodes the VRAM↔RAM trade the user specified: a 6 GB
        # card needs only 10 GB of RAM (disk-spilled offload), a 4 GB card
        # needs 30 GB.
        "id": "ltx-2-av-small",
        "label": "LTX-2.3 distilled (synced audio+video · quantized)",
        "repo": os.getenv("OMNIGEN_LTX2_REPO", "diffusers/LTX-2.3-Diffusers"),
        "extra_repos": [],
        "vram_mb": 4096,
        "ram_required_mb": 10240,
        "any_of": [
            {"vram_mb": 6144, "ram_mb": 10240},
            {"vram_mb": 4096, "ram_mb": 30720},
        ],
        "generates_audio": True,
        # Distilled checkpoints are trained for CFG-free sampling.
        "default_guidance": 1.0,
        "gguf_repo": os.getenv("OMNIGEN_LTX2_GGUF_REPO", "QuantStack/LTX-2.3-GGUF"),
        "gguf_file": os.getenv(
            "OMNIGEN_LTX2_GGUF_FILE",
            "LTX-2.3-distilled/LTX-2.3-distilled-Q4_K_S.gguf",
        ),
        # The GGUF replaces the repo transformer — don't download 40 GB of
        # bf16 weights this tier never loads. The Gemma-3 TE (~42 GB) and
        # connectors (~12 GB) ARE still needed — group offloading streams
        # them instead of holding them in RAM.
        "repo_ignore_patterns": ["transformer/*"],
        "download_size_mb": 72000,
        # Group offloading keeps peak RAM at pinning buffers + activations;
        # tight-RAM machines additionally spill the store to disk.
        "peak_ram_mb": 8000,
        "backends": ["cuda", "rocm"],
        "default_frames": 73,
        "max_frames": 121,
        "default_fps": 24,
        "default_width": 576,
        "default_height": 320,
        "default_steps": 8,
    },
    {
        # TOP — RTX 4080 Super (16 GB VRAM, 64 GB RAM) class machines.
        "id": "ltx-video",
        "label": "LTX Video (top · 12 GB+)",
        "repo": "Lightricks/LTX-Video",
        "extra_repos": [],
        "vram_mb": 12000,
        "ram_required_mb": 20000,
        "any_of": None,
        "generates_audio": False,
        "default_guidance": 3.0,
        "gguf_repo": None,
        "gguf_file": None,
        "repo_ignore_patterns": None,
        "download_size_mb": 18000,
        "peak_ram_mb": 18000,
        "backends": ["cuda", "rocm", "metal", "mps"],
        "default_frames": 121,
        "max_frames": 241,
        "default_fps": 24,
        "default_width": 768,
        "default_height": 512,
        "default_steps": 30,
    },
    {
        # MID — RTX 3060 6 GB class. Whole pipeline stays GPU-resident.
        "id": "animatediff-sd15",
        "label": "AnimateDiff + SD 1.5 (mid · 6 GB)",
        "repo": "guoyww/animatediff-motion-adapter-v1-5-3",
        "extra_repos": ["stable-diffusion-v1-5/stable-diffusion-v1-5"],
        "vram_mb": 4500,
        "ram_required_mb": 8000,
        "any_of": None,
        "generates_audio": False,
        "default_guidance": None,
        "gguf_repo": None,
        "gguf_file": None,
        "repo_ignore_patterns": None,
        "download_size_mb": 6000,
        "peak_ram_mb": 5000,
        "backends": ["cuda", "rocm", "metal", "mps", "directml"],
        "default_frames": 16,
        "max_frames": 32,
        "default_fps": 8,
        "default_width": 512,
        "default_height": 512,
        "default_steps": 20,
    },
    {
        # SMALL — GTX 1650 Ti 4 GB class. Same weights as mid; sequential CPU
        # offload keeps peak VRAM under ~3 GB at the cost of speed.
        "id": "animatediff-sd15-small",
        "label": "AnimateDiff + SD 1.5 (small · 4 GB)",
        "repo": "guoyww/animatediff-motion-adapter-v1-5-3",
        "extra_repos": ["stable-diffusion-v1-5/stable-diffusion-v1-5"],
        "vram_mb": 3000,
        "ram_required_mb": 6000,
        "any_of": None,
        "generates_audio": False,
        "default_guidance": None,
        "gguf_repo": None,
        "gguf_file": None,
        "repo_ignore_patterns": None,
        "download_size_mb": 6000,
        "peak_ram_mb": 6000,
        "backends": ["cuda", "rocm", "metal", "mps"],
        "default_frames": 12,
        "max_frames": 24,
        "default_fps": 6,
        "default_width": 448,
        "default_height": 448,
        "default_steps": 14,
    },
    {
        # CPU fallback — works everywhere, slowly, at 256×256.
        "id": "text-to-video-cpu",
        "label": "Text-to-Video MS (CPU)",
        "repo": "damo-vilab/text-to-video-ms-1.7b",
        "extra_repos": [],
        "vram_mb": 0,
        "ram_required_mb": 0,
        "any_of": None,
        "generates_audio": False,
        "default_guidance": None,
        "gguf_repo": None,
        "gguf_file": None,
        "repo_ignore_patterns": None,
        "download_size_mb": 8000,
        "peak_ram_mb": 3500,
        "backends": ["cpu", "cuda", "rocm", "metal", "mps", "directml"],
        "default_frames": 8,
        "max_frames": 16,
        "default_fps": 4,
        "default_width": 256,
        "default_height": 256,
        "default_steps": 10,
    },
]


# Tiers whose runtime support turned out to be missing on this install (e.g.
# diffusers too old for LTX-2). Selection skips them for the process lifetime.
_unavailable_tiers: set[str] = set()

# Below this much total RAM the small LTX-2.3 tier streams its weights from
# DISK (group offloading with offload_to_disk_path) instead of pinning them in
# system RAM, and drops to a lighter GGUF quant. 16 GB-class laptops land here.
_LTX2_TIGHT_RAM_MB = 24576


def _ltx2_is_tight_ram() -> bool:
    total = _get_total_ram_mb()
    return 0 < total < _LTX2_TIGHT_RAM_MB


def _ltx2_gguf_file(tier: VideoTier) -> Optional[str]:
    """GGUF quant for this machine. An explicit OMNIGEN_LTX2_GGUF_FILE wins;
    otherwise tight-RAM machines get Q3_K_M (14.7 GB — re-read from disk every
    step, so smaller is faster) and RAM-rich machines keep the tier's default
    Q4_K_S (16.7 GB, pinned in RAM)."""
    configured = tier.get("gguf_file")
    if not configured:
        return None
    if os.getenv("OMNIGEN_LTX2_GGUF_FILE"):
        return configured
    if _ltx2_is_tight_ram():
        return "LTX-2.3-distilled/LTX-2.3-distilled-Q3_K_M.gguf"
    return configured


class TierUnavailableError(RuntimeError):
    """The tier cannot run on this install (missing pipeline class, etc)."""


def _tier_fits(tier: VideoTier, backend: str, vram: int, total_ram: int) -> bool:
    if tier["id"] in _unavailable_tiers:
        return False
    if backend not in tier["backends"]:
        return False
    # any_of: the tier fits when ANY VRAM/RAM combination is satisfied —
    # models that stream weights through system RAM can trade one for the
    # other. total_ram == 0 means "unknown" — don't block on it.
    any_of = tier.get("any_of")
    if any_of:
        return any(
            vram >= req["vram_mb"]
            and (total_ram == 0 or total_ram >= req["ram_mb"])
            for req in any_of
        )
    if tier["vram_mb"] > vram:
        return False
    if total_ram > 0 and tier["ram_required_mb"] > total_ram:
        return False
    return True


def pick_best_video_tier(forced_tier_id: Optional[str] = None) -> VideoTier:
    """Best tier for this machine. A forced tier id is honored only when it
    actually fits the hardware — forcing a 12 GB model onto a 4 GB GPU used to
    hang the whole pipeline, so we degrade to auto-selection with a warning
    instead."""
    backend = get_backend()
    vram = get_vram_mb()
    total_ram = _get_total_ram_mb()

    if forced_tier_id:
        forced = next((t for t in VIDEO_TIERS if t["id"] == forced_tier_id), None)
        if forced is not None:
            if _tier_fits(forced, backend, vram, total_ram):
                return forced
            log.warning(
                "forced video tier %s does not fit (backend=%s vram=%dMB ram=%dMB) "
                "— auto-selecting instead",
                forced_tier_id,
                backend,
                vram,
                total_ram,
            )
        else:
            log.warning(
                "unknown video tier %r — auto-selecting instead", forced_tier_id
            )

    for tier in VIDEO_TIERS:
        if _tier_fits(tier, backend, vram, total_ram):
            return tier
    return VIDEO_TIERS[-1]


def _check_ram_sufficient(tier: VideoTier) -> None:
    """Raises RuntimeError with an actionable message if there isn't enough
    free RAM to load this video tier. Loading a large model into insufficient
    RAM causes Windows to swap to disk, locking up the entire machine for
    minutes. Refuse fast instead so the user can close other apps."""
    available = _get_available_ram_mb()
    total = _get_total_ram_mb()
    if available <= 0:
        # psutil missing or failed — skip the check rather than block generation.
        return

    required = tier["peak_ram_mb"]
    if available >= required:
        return

    gb_avail = available / 1024
    gb_required = required / 1024
    gb_total = total / 1024 if total > 0 else 0

    suggestion = None
    for t in reversed(VIDEO_TIERS):
        if t["id"] != tier["id"] and t["peak_ram_mb"] <= available:
            suggestion = t["label"]
            break

    hint_lines = [
        f"Not enough free RAM to load {tier['label']}.",
        f"Required: ~{gb_required:.1f} GB free.  Available: ~{gb_avail:.1f} GB"
        + (f" of {gb_total:.1f} GB total." if gb_total else "."),
        "",
        "Try one of:",
        "  • Close other apps to free up RAM, then retry.",
        "  • Restart the OrianBuilder app to free its working memory.",
    ]
    if suggestion:
        hint_lines.append(f"  • Switch to '{suggestion}' — it fits in your available RAM.")
    raise RuntimeError("\n".join(hint_lines))


_pipeline = None
_pipeline_tier_id: Optional[str] = None
_lock = threading.Lock()

_download_progress: dict[str, float] = {}
_download_errors: dict[str, str] = {}
_downloading_tiers: set[str] = set()


def _hf_cache_dir() -> Path:
    hf_home = os.environ.get("HF_HOME", "")
    if hf_home:
        return Path(hf_home) / "hub"
    return Path.home() / ".cache" / "huggingface" / "hub"


def _repo_dir(repo: str) -> Path:
    return _hf_cache_dir() / f"models--{repo.replace('/', '--')}"


def tier_download_specs(tier: VideoTier) -> list[dict]:
    """Everything the tier fetches from HF, as snapshot_download kwargs
    ({repo_id, allow_patterns?, ignore_patterns?}). The GGUF tier pulls one
    quant file from its community repo and skips the multi-GB transformer/
    folder of the base repo that file replaces. Shared with
    scripts/download_models.py so setup pre-fetches exactly what load uses."""
    specs: list[dict] = []
    if tier.get("repo"):
        specs.append(
            {
                "repo_id": tier["repo"],
                "ignore_patterns": tier.get("repo_ignore_patterns"),
            }
        )
    for repo in tier.get("extra_repos") or []:
        specs.append({"repo_id": repo})
    gguf_file = _ltx2_gguf_file(tier)
    if tier.get("gguf_repo") and gguf_file:
        specs.append({"repo_id": tier["gguf_repo"], "allow_patterns": [gguf_file]})
    return specs


def _spec_downloaded(spec: dict) -> bool:
    snaps = _repo_dir(spec["repo_id"]) / "snapshots"
    if not (snaps.is_dir() and any(snaps.iterdir())):
        return False
    # Single-file specs (the GGUF quant): a snapshot existing isn't enough —
    # the exact file must be present (the repo hosts many quant variants).
    for pattern in spec.get("allow_patterns") or []:
        if not any(snaps.glob(f"*/{pattern}")):
            return False
    return True


def tier_status(tier_id: str) -> str:
    if tier_id in _downloading_tiers:
        return "downloading"
    tier = next((t for t in VIDEO_TIERS if t["id"] == tier_id), None)
    if not tier:
        return "not_downloaded"
    specs = tier_download_specs(tier)
    if not specs:
        return "not_downloaded"
    if all(_spec_downloaded(s) for s in specs):
        return "downloaded"
    return "not_downloaded"


def get_download_error(tier_id: str) -> str | None:
    return _download_errors.get(tier_id)


def _dir_size_bytes(path: Path) -> int:
    total = 0
    if not path.exists():
        return 0
    for p in path.rglob("*"):
        try:
            if p.is_file():
                total += p.stat().st_size
        except OSError:
            continue
    return total


# A download attempt with NO disk growth for this long is considered stalled.
# hf_transfer / xet hang silently on flaky networks (verified live: a download
# sat at 0 bytes indefinitely) — kill the attempt and retry with the fancy
# transfer backends disabled; the HF cache resumes where it left off.
_DOWNLOAD_STALL_SECONDS = 90
_DOWNLOAD_ATTEMPT_ENVS: list[dict[str, str]] = [
    {},  # first try: whatever the server env says (hf_transfer/xet enabled)
    {
        "HF_HUB_ENABLE_HF_TRANSFER": "0",
        "HF_XET_HIGH_PERFORMANCE": "0",
        "HF_HUB_DISABLE_XET": "1",
    },
    {
        "HF_HUB_ENABLE_HF_TRANSFER": "0",
        "HF_XET_HIGH_PERFORMANCE": "0",
        "HF_HUB_DISABLE_XET": "1",
    },
]


def _snapshot_download_with_progress(
    spec: dict,
    progress_cb: Optional[ProgressFn],
    total_bytes_hint: int = 0,
    already_bytes: int = 0,
) -> None:
    """Fetches one HF download spec ({repo_id, allow/ignore_patterns}) in a
    killable subprocess, reporting progress from bytes-on-disk (transfer-
    backend agnostic). In-process snapshot_download can hang forever with no
    way to abort it — a subprocess can be killed on stall or cancel, and the
    cache resumes partial blobs on retry."""
    import subprocess
    import sys

    repo = spec["repo_id"]
    code = (
        "from huggingface_hub import snapshot_download; "
        f"snapshot_download(repo_id={repo!r}, "
        f"allow_patterns={spec.get('allow_patterns')!r}, "
        f"ignore_patterns={spec.get('ignore_patterns')!r})"
    )
    repo_dir = _repo_dir(repo)
    last_error = "unknown error"

    for attempt, overrides in enumerate(_DOWNLOAD_ATTEMPT_ENVS, start=1):
        env = dict(os.environ)
        env.update(overrides)
        # tqdm bars on an unread pipe would fill the buffer and freeze the child.
        env["HF_HUB_DISABLE_PROGRESS_BARS"] = "1"
        if overrides:
            log.info(
                "download attempt %d for %s (plain HTTP, hf_transfer/xet off)",
                attempt,
                repo,
            )
        proc = subprocess.Popen(
            [sys.executable, "-c", code],
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            last_size = _dir_size_bytes(repo_dir)
            last_growth = time.monotonic()
            stalled = False
            while proc.poll() is None:
                time.sleep(2)
                size = _dir_size_bytes(repo_dir)
                if size > last_size:
                    last_size = size
                    last_growth = time.monotonic()
                if progress_cb:
                    done = already_bytes + size
                    fraction = (
                        min(0.99, done / total_bytes_hint)
                        if total_bytes_hint > 0
                        else None
                    )
                    progress_cb(f"downloading {repo}", fraction)
                if time.monotonic() - last_growth > _DOWNLOAD_STALL_SECONDS:
                    stalled = True
                    proc.kill()
                    break
        except BaseException:
            # Cancellation (progress_cb raises) or anything else — don't leave
            # an orphan downloader running.
            proc.kill()
            proc.wait(timeout=10)
            raise

        _stdout, stderr = proc.communicate()
        if not stalled and proc.returncode == 0:
            return
        last_error = (
            f"stalled (no progress for {_DOWNLOAD_STALL_SECONDS}s)"
            if stalled
            else (stderr or f"exit code {proc.returncode}").strip()[-500:]
        )
        log.warning("download attempt %d for %s failed: %s", attempt, repo, last_error)

    raise RuntimeError(f"download of {repo} failed: {last_error}")


def ensure_tier_downloaded(
    tier: VideoTier, progress_cb: Optional[ProgressFn] = None
) -> None:
    """Pre-fetches every HF repo the tier needs, reporting download progress.
    Without this, the first generation silently stalls inside from_pretrained
    for the duration of a multi-GB download."""
    specs = tier_download_specs(tier)
    missing = [s for s in specs if not _spec_downloaded(s)]
    if not missing:
        return
    total_hint = tier["download_size_mb"] * 1024 * 1024
    _downloading_tiers.add(tier["id"])
    try:
        for spec in missing:
            repo = spec["repo_id"]
            if progress_cb:
                progress_cb(f"downloading {repo}", None)
            log.info("downloading video model repo %s", repo)
            already = sum(
                _dir_size_bytes(_repo_dir(s["repo_id"]))
                for s in specs
                if s["repo_id"] != repo
            )
            _snapshot_download_with_progress(spec, progress_cb, total_hint, already)
        _download_errors.pop(tier["id"], None)
    except Exception as exc:  # noqa: BLE001
        _download_errors[tier["id"]] = str(exc)
        raise
    finally:
        _downloading_tiers.discard(tier["id"])
        _download_progress.pop(tier["id"], None)


def download_tier(tier_id: str) -> None:
    tier = next((t for t in VIDEO_TIERS if t["id"] == tier_id), None)
    if not tier:
        return
    _downloading_tiers.add(tier_id)
    _download_errors.pop(tier_id, None)
    try:
        ensure_tier_downloaded(
            tier,
            lambda _stage, p: _download_progress.__setitem__(
                tier_id, (p or 0.0) * 100.0
            ),
        )
    except Exception as exc:  # noqa: BLE001
        _download_errors[tier_id] = str(exc)
    finally:
        _downloading_tiers.discard(tier_id)
        _download_progress.pop(tier_id, None)


def _enable_savers(pipe, include_offload: bool = True) -> None:
    fns = [
        "enable_attention_slicing",
        "enable_vae_slicing",
        "enable_vae_tiling",
    ]
    if include_offload:
        fns.append("enable_model_cpu_offload")
    for fn_name in fns:
        fn = getattr(pipe, fn_name, None)
        if callable(fn):
            try:
                fn()
            except Exception:  # noqa: BLE001
                pass


def _resolve_cuda_device(device: str) -> str:
    """Verify the CUDA runtime is actually usable; fall back to CPU loudly."""
    if device != "cuda":
        return device
    try:
        import torch  # type: ignore

        if not torch.cuda.is_available():
            log.warning(
                "device=cuda requested but torch.cuda.is_available()=False; "
                "falling back to CPU — generation will be slow"
            )
            return "cpu"
        cuda_name = torch.cuda.get_device_name(0)
        free_mb, total_mb = (x // (1024 * 1024) for x in torch.cuda.mem_get_info())
        log.info(
            "CUDA OK: device=%s vram_free=%dMB vram_total=%dMB",
            cuda_name,
            free_mb,
            total_mb,
        )
        return device
    except Exception as exc:  # noqa: BLE001
        log.warning("CUDA probe failed (%s); falling back to CPU", exc)
        return "cpu"


def _load_animatediff(tier: VideoTier, device: str, dtype):
    from diffusers import (  # type: ignore
        AnimateDiffPipeline,
        EulerDiscreteScheduler,
        MotionAdapter,
    )

    adapter = MotionAdapter.from_pretrained(tier["repo"], torch_dtype=dtype)
    # stable-diffusion-v1-5/stable-diffusion-v1-5 is a public mirror of
    # runwayml/stable-diffusion-v1-5 that doesn't require HF login.
    pipe = AnimateDiffPipeline.from_pretrained(
        tier["extra_repos"][0],
        motion_adapter=adapter,
        torch_dtype=dtype,
        safety_checker=None,
    )
    pipe.scheduler = EulerDiscreteScheduler.from_config(
        pipe.scheduler.config, timestep_spacing="linspace", beta_schedule="linear"
    )

    # GTX 16xx cards emit NaNs in fp16 UNets (black frames) — get_torch_dtype
    # already upcasts them to fp32. The fp32 weights (~6 GB with the motion
    # adapter) exceed those cards' VRAM, so offload regardless of tier; the
    # VAE upcast stays as belt-and-braces for other fp16 cards.
    fp32_card = device == "cuda" and is_fp16_unreliable_gpu()
    if device == "cuda" and not fp32_card:
        force_fp32_vae(pipe)

    if (tier["id"] == "animatediff-sd15-small" or fp32_card) and device == "cuda":
        # 4 GB-class GPUs: stream layers to the GPU one at a time. Peak VRAM
        # stays under ~3 GB; the 40 GB-RAM host machines this targets hold the
        # rest comfortably.
        try:
            pipe.enable_sequential_cpu_offload()
            log.info("sequential_cpu_offload enabled for small video tier")
        except Exception as exc:  # noqa: BLE001
            log.warning("sequential_cpu_offload failed (%s); using model offload", exc)
            _enable_savers(pipe)
        _enable_savers(pipe, include_offload=False)
    else:
        pipe = pipe.to(device)
        _enable_savers(pipe, include_offload=False)
    return pipe


def _load_ltx(tier: VideoTier, device: str):
    from diffusers import LTXPipeline  # type: ignore
    import torch  # type: ignore

    dtype = torch.bfloat16
    if device == "cuda":
        try:
            if not torch.cuda.is_bf16_supported():
                dtype = torch.float16
        except Exception:  # noqa: BLE001
            dtype = torch.float16

    pipe = LTXPipeline.from_pretrained(
        tier["repo"], torch_dtype=dtype, low_cpu_mem_usage=True
    )
    # The T5-XXL text encoder alone is ~9 GB — model offload keeps the 16 GB
    # cards (the top-tier target) from OOMing while barely costing speed.
    if device == "cuda" and get_vram_mb() < 24000:
        try:
            pipe.enable_model_cpu_offload()
        except Exception:  # noqa: BLE001
            pipe = pipe.to(device)
    else:
        pipe = pipe.to(device)
    _enable_savers(pipe, include_offload=False)
    return pipe


def _ltx2_dtype(device: str):
    """bf16 where the GPU supports it (Ampere+), fp16 otherwise (Turing —
    the GTX 16xx laptop class)."""
    import torch  # type: ignore

    if device == "cuda":
        try:
            if not torch.cuda.is_bf16_supported():
                return torch.float16
        except Exception:  # noqa: BLE001
            return torch.float16
    return torch.bfloat16


def _quantization_config_for_ltx2(dtype):
    """4-bit NF4 quantization for the LTX-2.3 transformer + text encoder when
    bitsandbytes is installed ("heavily quantized" — the 40 GB bf16 transformer
    becomes ~11 GB and the 42 GB Gemma-3 text encoder ~14 GB; model offload
    alternates them through a 16 GB card); None otherwise — the loader then
    falls back to bf16/fp16 with aggressive offload."""
    try:
        import bitsandbytes  # type: ignore # noqa: F401
        from diffusers import PipelineQuantizationConfig  # type: ignore

        return PipelineQuantizationConfig(
            quant_backend="bitsandbytes_4bit",
            quant_kwargs={
                "load_in_4bit": True,
                "bnb_4bit_quant_type": "nf4",
                "bnb_4bit_compute_dtype": dtype,
            },
            components_to_quantize=["transformer", "text_encoder"],
        )
    except Exception as exc:  # noqa: BLE001 — optional dependency
        log.info("bitsandbytes 4-bit unavailable (%s); loading LTX-2.3 unquantized", exc)
        return None


def _load_ltx2_gguf_transformer(tier: VideoTier, dtype):
    """Loads the community GGUF transformer (≈15–17 GB on disk, kept quantized
    in memory) that replaces the repo's bf16 one. Returns None on any failure
    so the caller can decide what to do (the small tier demotes — its hardware
    class can't run the 40 GB bf16 alternative)."""
    gguf_repo = tier.get("gguf_repo")
    gguf_file = _ltx2_gguf_file(tier)
    if not gguf_repo or not gguf_file:
        return None
    try:
        from diffusers import (  # type: ignore
            GGUFQuantizationConfig,
            LTX2VideoTransformer3DModel,
        )

        url = f"https://huggingface.co/{gguf_repo}/blob/main/{gguf_file}"
        log.info("loading LTX-2.3 GGUF transformer from %s", url)
        return LTX2VideoTransformer3DModel.from_single_file(
            url,
            quantization_config=GGUFQuantizationConfig(compute_dtype=dtype),
            torch_dtype=dtype,
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("GGUF transformer load failed: %s", exc)
        return None


def _offload_store_dir() -> Path:
    base = os.getenv("OMNIGEN_MODELS_DIR", str(BACKEND_DIR / "models"))
    return Path(base) / "offload" / "ltx2"


def _enable_ltx2_group_offload(pipe) -> bool:
    """Group offloading for the small LTX-2.3 tier: weight groups stream to
    the GPU as the forward pass reaches them, so nothing has to fit anywhere
    whole — which is the only way the ~42 GB bf16 Gemma-3 text encoder runs
    on a laptop. RAM-rich machines keep the groups pinned in system RAM;
    tight-RAM machines (16 GB class) spill the store to disk and re-read it
    each step (slow but bounded). Returns False when this diffusers/model
    combo doesn't support it so the caller can fall back."""
    import torch  # type: ignore

    kwargs: dict = {
        "onload_device": torch.device("cuda"),
        "offload_device": torch.device("cpu"),
        "offload_type": "leaf_level",
        "use_stream": True,
        # Pin tensors on the fly instead of 2× pre-pinning the model size.
        "low_cpu_mem_usage": True,
    }
    if _ltx2_is_tight_ram():
        store = _offload_store_dir()
        store.mkdir(parents=True, exist_ok=True)
        kwargs["offload_to_disk_path"] = str(store)
    for attempt_kwargs in (kwargs, {k: v for k, v in kwargs.items() if k != "low_cpu_mem_usage"}):
        try:
            pipe.enable_group_offload(**attempt_kwargs)
            log.info(
                "group offload enabled for LTX-2.3 (disk_spill=%s)",
                "offload_to_disk_path" in attempt_kwargs,
            )
            return True
        except TypeError as exc:
            log.info("group offload signature mismatch (%s); retrying reduced", exc)
            continue
        except Exception as exc:  # noqa: BLE001
            log.warning("group offload unavailable: %s", exc)
            return False
    return False


def _load_ltx2(tier: VideoTier, device: str):
    """Loads an LTX-2.3 synced audio+video pipeline (diffusers ≥0.37).

    Variant chain, best available wins:
      1. tier-configured GGUF Q4 transformer (the distilled small tier)
      2. repo checkpoint quantized to 4-bit at load (bitsandbytes NF4)
      3. plain bf16/fp16 + offload (last resort — needs lots of RAM)

    Raises TierUnavailableError when this install's diffusers has no LTX-2
    support — the caller demotes BOTH LTX-2.3 tiers and re-selects, so old
    installs degrade to LTX-Video/AnimateDiff instead of failing the job."""
    try:
        from diffusers import LTX2Pipeline  # type: ignore
    except (ImportError, AttributeError) as exc:
        raise TierUnavailableError(
            f"diffusers has no LTX2Pipeline ({exc}); update the media backend "
            "dependencies (diffusers >= 0.37) to enable synced audio+video"
        ) from exc

    dtype = _ltx2_dtype(device)
    pipe = None

    transformer = _load_ltx2_gguf_transformer(tier, dtype) if device == "cuda" else None
    if transformer is not None:
        # Passing the transformer keeps from_pretrained from downloading the
        # repo's 40 GB bf16 transformer folder.
        pipe = LTX2Pipeline.from_pretrained(
            tier["repo"],
            transformer=transformer,
            torch_dtype=dtype,
            low_cpu_mem_usage=True,
        )
    elif tier.get("gguf_repo"):
        # The small tier without its GGUF would mean the 40 GB bf16
        # transformer + bnb — pointless on this tier's hardware class.
        # Demote so selection lands on LTX-Video/AnimateDiff instead.
        raise TierUnavailableError(
            "GGUF transformer unavailable for the small LTX-2.3 tier"
        )

    if pipe is None:
        quant = _quantization_config_for_ltx2(dtype) if device == "cuda" else None
        load_kwargs: dict = {"torch_dtype": dtype, "low_cpu_mem_usage": True}
        if quant is not None:
            load_kwargs["quantization_config"] = quant
        try:
            pipe = LTX2Pipeline.from_pretrained(tier["repo"], **load_kwargs)
        except Exception:
            if quant is None:
                raise
            # Quantized load failed (bnb/CUDA mismatch, unsupported component…)
            # — retry unquantized before giving up; offload keeps VRAM in check.
            log.warning("quantized LTX-2.3 load failed; retrying without quantization")
            load_kwargs.pop("quantization_config", None)
            pipe = LTX2Pipeline.from_pretrained(tier["repo"], **load_kwargs)

    vram = get_vram_mb()
    if device == "cuda" and transformer is not None:
        # Small tier: nothing here fits anywhere whole (GGUF transformer
        # 15-17 GB, Gemma-3 text encoder 42 GB bf16, connectors 12 GB) —
        # group offloading streams it all, spilling to disk on tight-RAM
        # machines. Sequential offload is the fallback, but it pins every
        # weight in RAM, so warn loudly: that needs a ~70 GB-RAM machine.
        if not _enable_ltx2_group_offload(pipe):
            log.warning(
                "group offload unavailable — falling back to sequential "
                "offload, which pins ~70 GB of weights in system RAM; "
                "expect heavy swapping on smaller machines"
            )
            try:
                pipe.enable_sequential_cpu_offload()
            except Exception as exc:  # noqa: BLE001
                log.warning("sequential offload failed (%s); model offload", exc)
                _enable_savers(pipe)
    elif device == "cuda" and vram < 8000:
        # Full checkpoint on a small card (only reachable via forced tier):
        # stream layers through the GPU one at a time.
        try:
            pipe.enable_sequential_cpu_offload()
            log.info("sequential_cpu_offload enabled for LTX-2.3")
        except Exception as exc:  # noqa: BLE001
            log.warning("sequential offload failed (%s); using model offload", exc)
            _enable_savers(pipe)
    elif device == "cuda" and vram < 24000:
        try:
            pipe.enable_model_cpu_offload()
        except Exception as exc:  # noqa: BLE001
            # bnb-4bit components are device-mapped onto the GPU at load and
            # refuse .to() — keep the load-time placement rather than failing.
            log.warning("model offload failed (%s); keeping load placement", exc)
            try:
                pipe = pipe.to(device)
            except Exception:  # noqa: BLE001
                pass
    else:
        try:
            pipe = pipe.to(device)
        except Exception:  # noqa: BLE001 — quantized components refuse .to()
            pass
    _enable_savers(pipe, include_offload=False)
    return pipe


def get_pipeline(forced_tier_id: Optional[str] = None):
    global _pipeline, _pipeline_tier_id

    tier = pick_best_video_tier(forced_tier_id)
    if _pipeline is not None and _pipeline_tier_id == tier["id"]:
        return _pipeline

    if _pipeline is not None and _pipeline_tier_id != tier["id"]:
        unload_pipeline()

    device = _resolve_cuda_device(get_torch_device())
    dtype = get_torch_dtype()

    # Preflight RAM check — fail fast with a clear message instead of locking
    # up the machine when the model is too big to fit in available RAM.
    _check_ram_sufficient(tier)

    log.info(
        "loading video tier id=%s repo=%s device=%s dtype=%s vram_mb=%d free_ram_mb=%d",
        tier["id"],
        tier["repo"],
        device,
        dtype,
        get_vram_mb(),
        _get_available_ram_mb(),
    )

    if tier["id"] in ("ltx-2-av", "ltx-2-av-small"):
        try:
            pipe = _load_ltx2(tier, device)
        except TierUnavailableError as exc:
            # Both LTX-2.3 tiers need the same pipeline class — demote them
            # together for this process and re-select. generate_video re-reads
            # the loaded tier id, so kwargs match the fallback tier.
            log.warning("LTX-2.3 unavailable: %s — falling back to next tier", exc)
            _unavailable_tiers.update({"ltx-2-av", "ltx-2-av-small"})
            return get_pipeline(None)
    elif tier["id"] == "ltx-video":
        pipe = _load_ltx(tier, device)
    elif tier["id"] in ("animatediff-sd15", "animatediff-sd15-small"):
        pipe = _load_animatediff(tier, device, dtype)
    else:
        # CPU fallback — Text-to-Video MS 1.7B on CPU.
        from diffusers import DiffusionPipeline  # type: ignore
        import torch  # type: ignore

        pipe = DiffusionPipeline.from_pretrained(
            tier["repo"], torch_dtype=torch.float32
        ).to("cpu")

    gc.collect()
    _pipeline = pipe
    _pipeline_tier_id = tier["id"]
    return _pipeline


def unload_pipeline() -> None:
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


def _output_filename() -> str:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return f"video-{timestamp}-{uuid4().hex[:8]}.mp4"


def _is_ltx_family(tier: VideoTier) -> bool:
    return tier["id"].startswith("ltx")


def _quantize_frames(tier: VideoTier, frames: int) -> int:
    frames = max(8, min(frames, tier["max_frames"]))
    if _is_ltx_family(tier):
        # LTX requires num_frames ≡ 1 (mod 8).
        return max(9, ((frames - 1) // 8) * 8 + 1)
    return frames


def _quantize_dim(tier: VideoTier, value: int) -> int:
    # LTX wants multiples of 32; SD-family pipelines need multiples of 8.
    multiple = 32 if _is_ltx_family(tier) else 8
    return max(multiple, (value // multiple) * multiple)


def _dims_for_aspect_ratio(
    tier: VideoTier, aspect_ratio: str
) -> tuple[int, int]:
    """Resolution for an aspect ratio like "16:9"/"9:16"/"1:1", sized to the
    tier's default pixel budget (so a 4 GB card isn't asked to render 720p
    just because the ratio changed) and quantized to the pipeline's grid."""
    try:
        w_str, h_str = aspect_ratio.split(":")
        ratio_w, ratio_h = float(w_str), float(h_str)
        if ratio_w <= 0 or ratio_h <= 0:
            raise ValueError(aspect_ratio)
    except (ValueError, AttributeError):
        return tier["default_width"], tier["default_height"]
    budget = tier["default_width"] * tier["default_height"]
    width = (budget * ratio_w / ratio_h) ** 0.5
    height = width * ratio_h / ratio_w
    return _quantize_dim(tier, int(width)), _quantize_dim(tier, int(height))


def _resolve_frame_count(
    tier: VideoTier,
    num_frames: Optional[int],
    fps: int,
    duration_s: Optional[float],
) -> int:
    if num_frames:
        return _quantize_frames(tier, int(num_frames))
    if duration_s and duration_s > 0:
        return _quantize_frames(tier, round(float(duration_s) * fps))
    return _quantize_frames(tier, tier["default_frames"])


def _extract_audio(result, pipe):
    """Best-effort extraction of the synced audio track from an AV pipeline
    output. Returns (samples ndarray shaped (n, channels), sample_rate), or
    (None, 0) when the output carries no audio."""
    import numpy as np

    audio = getattr(result, "audio", None)
    if audio is None:
        audio = getattr(result, "audios", None)
    if audio is None:
        return None, 0
    if isinstance(audio, (list, tuple)):
        if not audio:
            return None, 0
        audio = audio[0]
    try:
        import torch  # type: ignore

        if isinstance(audio, torch.Tensor):
            audio = audio.detach().to("cpu", dtype=torch.float32).numpy()
    except ImportError:
        pass
    arr = np.squeeze(np.asarray(audio, dtype=np.float32))
    if arr.ndim == 0 or arr.size == 0:
        return None, 0
    # (channels, samples) → (samples, channels) for soundfile.
    if arr.ndim == 2 and arr.shape[0] <= 8 and arr.shape[0] < arr.shape[1]:
        arr = arr.T

    sample_rate = 0
    # LTX-2.3's vocoder publishes the rate as config.output_sampling_rate —
    # check that first, then the generic spellings.
    vocoder_cfg = getattr(getattr(pipe, "vocoder", None), "config", None)
    for value in (
        getattr(vocoder_cfg, "output_sampling_rate", None),
        getattr(vocoder_cfg, "sampling_rate", None),
        getattr(pipe, "audio_sample_rate", None),
        getattr(pipe, "sampling_rate", None),
    ):
        if isinstance(value, (int, float)) and value > 0:
            sample_rate = int(value)
            break
    if sample_rate <= 0:
        sample_rate = int(os.getenv("OMNIGEN_LTX2_AUDIO_SR", "48000"))
    return arr, sample_rate


def _ffmpeg_exe() -> str:
    try:
        import imageio_ffmpeg  # type: ignore

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:  # noqa: BLE001
        return "ffmpeg"


def _mux_audio_into_video(video_path: Path, audio_samples, sample_rate: int) -> bool:
    """Writes the synced track to a wav and muxes it into the mp4 in place
    (AAC). Returns True on success; on failure the silent video survives so
    the job still delivers — callers then fall back to their own soundtrack."""
    import subprocess

    import soundfile as sf

    wav_path = video_path.with_suffix(".wav")
    muxed_path = video_path.with_name(video_path.stem + "-av.mp4")
    try:
        sf.write(str(wav_path), audio_samples, sample_rate)
        cmd = [
            _ffmpeg_exe(), "-y",
            "-i", str(video_path),
            "-i", str(wav_path),
            "-map", "0:v:0",
            "-map", "1:a:0",
            "-c:v", "copy",
            "-c:a", "aac",
            "-b:a", "192k",
            "-shortest",
            "-movflags", "+faststart",
            str(muxed_path),
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0:
            log.warning(
                "audio mux failed (rc=%d): %s", proc.returncode, proc.stderr[-500:]
            )
            return False
        os.replace(muxed_path, video_path)
        return True
    except Exception as exc:  # noqa: BLE001
        log.warning("audio mux failed: %s", exc)
        return False
    finally:
        for leftover in (wav_path, muxed_path):
            try:
                if leftover.exists():
                    leftover.unlink()
            except OSError:
                pass


def generate_video(
    prompt: str,
    forced_tier_id: Optional[str] = None,
    num_frames: Optional[int] = None,
    fps: Optional[int] = None,
    width: Optional[int] = None,
    height: Optional[int] = None,
    steps: Optional[int] = None,
    duration_s: Optional[float] = None,
    aspect_ratio: Optional[str] = None,
    progress_cb: Optional[ProgressFn] = None,
) -> dict:
    """Generates a video and returns {video_path, video_url, model, tier,
    has_audio}. Writes the file under OMNIGEN_OUTPUTS_DIR. progress_cb
    (stage, 0..1|None) receives model-load + per-step progress and doubles as
    the cancel point — it may raise to abort generation. When width/height are
    omitted, aspect_ratio ("16:9", "9:16", …) sizes the clip to the selected
    tier's pixel budget."""
    OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)

    def report(stage: str, progress: Optional[float] = None) -> None:
        if progress_cb:
            progress_cb(stage, progress)

    with _lock:
        tier = pick_best_video_tier(forced_tier_id)
        report(f"loading {tier['label']}", None)
        pipe = get_pipeline(tier["id"])
        # The load may have demoted an unavailable tier (e.g. no LTX-2 support
        # in this install) — re-read what actually loaded so frame counts and
        # dimension grids match the real pipeline.
        if _pipeline_tier_id and _pipeline_tier_id != tier["id"]:
            tier = next(t for t in VIDEO_TIERS if t["id"] == _pipeline_tier_id)
            report(f"using {tier['label']}", None)

        if width or height:
            eff_width = _quantize_dim(tier, width or tier["default_width"])
            eff_height = _quantize_dim(tier, height or tier["default_height"])
        elif aspect_ratio:
            eff_width, eff_height = _dims_for_aspect_ratio(tier, aspect_ratio)
        else:
            eff_width, eff_height = tier["default_width"], tier["default_height"]

        effective_fps = fps or tier["default_fps"]
        frame_count = _resolve_frame_count(tier, num_frames, effective_fps, duration_s)
        kwargs = {
            "num_frames": frame_count,
            "num_inference_steps": steps or tier["default_steps"],
            "width": eff_width,
            "height": eff_height,
        }
        # Distilled checkpoints need CFG 1.0 and LTX-Video 0.9 wants 3.0;
        # None keeps the pipeline's own default (4.0 for LTX-2.3 dev).
        if tier.get("default_guidance") is not None:
            kwargs["guidance_scale"] = tier["default_guidance"]

        # Low-VRAM AV runs: cap clip length so the VAE decode of the whole
        # video tensor fits (community guidance: ~50 frames at 768×512 on
        # 6 GB; our pixel budget is about half that area, so 73 has margin).
        if tier["generates_audio"] and 0 < get_vram_mb() < 8000:
            cap = int(os.getenv("OMNIGEN_LTX2_LOWVRAM_MAX_FRAMES", "73"))
            capped = min(kwargs["num_frames"], _quantize_frames(tier, cap))
            if capped < kwargs["num_frames"]:
                log.info(
                    "low-VRAM cap: %d → %d frames", kwargs["num_frames"], capped
                )
                kwargs["num_frames"] = capped

        total_steps = kwargs["num_inference_steps"]
        log.info(
            "video gen tier=%s frames=%s size=%sx%s steps=%s",
            tier["id"],
            kwargs["num_frames"],
            kwargs["width"],
            kwargs["height"],
            total_steps,
        )
        report("generating video", 0.0)

        def _on_step_end(_pipe, step_index, _timestep, callback_kwargs):
            report("generating video", (step_index + 1) / max(1, total_steps))
            return callback_kwargs

        try:
            result = pipe(prompt, callback_on_step_end=_on_step_end, **kwargs)
        except TypeError:
            # Older pipelines (e.g. TextToVideoSDPipeline) predate the unified
            # callback API — run without per-step progress rather than failing.
            result = pipe(prompt, **kwargs)

    # Diffusers pipelines return either a `.frames` (list of PIL frames) or a
    # `.videos` ndarray; normalize to a list of PIL frames.
    frames = getattr(result, "frames", None)
    if frames is None:
        frames = getattr(result, "videos", None)
    if frames is None:
        raise RuntimeError(f"video pipeline returned no frames (tier={tier['id']})")

    if isinstance(frames, (list, tuple)) and len(frames) > 0 and isinstance(frames[0], (list, tuple)):
        frame_seq = frames[0]
    else:
        frame_seq = frames

    report("exporting video", None)
    from diffusers.utils import export_to_video  # type: ignore

    filename = _output_filename()
    output_path = OUTPUTS_DIR / filename
    export_to_video(frame_seq, str(output_path), fps=effective_fps)

    # AV tiers (LTX-2) return a synced soundtrack with the frames — mux it in
    # so the single mp4 ships with audio. Best-effort: a mux failure delivers
    # the silent video with has_audio=False and callers add their own track.
    has_audio = False
    if tier["generates_audio"]:
        audio_samples, sample_rate = _extract_audio(result, pipe)
        if audio_samples is not None:
            report("muxing synced audio", None)
            has_audio = _mux_audio_into_video(output_path, audio_samples, sample_rate)
        else:
            log.warning(
                "tier %s promised audio but the pipeline returned none", tier["id"]
            )

    return {
        "video_path": str(output_path.resolve()),
        "video_url": f"/outputs/{filename}",
        "model": tier["repo"] or tier["id"],
        "tier": tier["id"],
        "has_audio": has_audio,
    }
