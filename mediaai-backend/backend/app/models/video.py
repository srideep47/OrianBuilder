"""Tiered text-to-video generation.

Four production tiers plus a CPU fallback, matched to the hardware OrianBuilder
actually targets. Order is best → worst; pick_best_video_tier returns the first
tier whose VRAM *and* system-RAM requirements fit the live machine:

    ltx-2-av-small          top   LTX-2.3 · synced AUDIO+VIDEO, GGUF transformer
                                  (Q4_K_S 16.7 GB), 8 steps CFG 1 — fits when
                                  (≥6 GB VRAM and ≥10 GB RAM) OR (≥4 GB VRAM and
                                  ≥30 GB RAM). Best-quality AV route.
    ltx-video               top   LTX-Video 0.9 (no audio) · ≥12 GB VRAM, ≥20 GB RAM
    animatediff-sd15        mid   RTX 3060 6 GB class   · ≥4.5 GB VRAM, ≥8 GB RAM
    animatediff-sd15-small  small GTX 1650 Ti 4 GB class· ≥3 GB VRAM, ≥6 GB RAM
    text-to-video-cpu       cpu   anything (256×256, slow)

The LTX-2.3 tier generates a synced soundtrack along with the frames
(LTX2Pipeline, diffusers ≥0.37) — callers see `has_audio: true` and skip their
own music/mux pass. Its text encoder is Gemma-3-27B (~42 GB bf16, plus ~12 GB of
connectors), so nothing holds it resident: it runs through diffusers group
offloading, which streams weight groups to the GPU as they're needed. RAM-rich
machines (≥24 GB) keep the groups pinned in system RAM (faster); tight machines
spill the offload store to DISK so peak RAM stays low. The GGUF transformer
(~16.7 GB) replaces the 40 GB bf16 one — that, plus the distilled checkpoint
(8 steps, guidance 1.0), is what makes a 22 B model run on a 16 GB card.

(Historical note: a full bf16 "dev" tier using bitsandbytes 4-bit at load was
dropped — on current torch/diffusers it leaves a "meta tensor" during model
offload and fails generation. The GGUF transformer path is the reliable route.)

When the installed diffusers has no LTX-2 support, the tier demotes itself at
load time and selection re-runs without it — no job ever hard-fails.

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


class _VideoTierOptional(TypedDict, total=False):
    # Wan 2.2 A14B ships TWO transformer experts (high-noise + low-noise);
    # the second GGUF loads as the pipeline's `transformer_2`.
    gguf_file_2: Optional[str]
    # Optional distillation LoRA (lightx2v "Lightning") enabling few-step
    # CFG-free sampling. lora_file targets `transformer`, lora_file_2 targets
    # `transformer_2`. Load failure degrades to full-step sampling.
    lora_repo: Optional[str]
    lora_file: Optional[str]
    lora_file_2: Optional[str]
    # Image conditioning (i2v): "required" = the model only animates a supplied
    # keyframe image; "optional" = t2v by default, i2v when an image arrives.
    # Absent = text-to-video only (a supplied image is ignored).
    image_conditioning: Optional[str]


class VideoTier(_VideoTierOptional):
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
        # TOP (image-to-video) — Wan 2.2 A14B, the strongest open video model on
        # 16 GB-class cards. Two 14 B transformer experts (high-noise composes
        # motion, low-noise refines detail) as Q4_K_S GGUFs (~8.7 GB each), plus
        # the lightx2v Lightning LoRA for 4-step CFG-free sampling — the exact
        # community-proven recipe (ComfyUI reference workflow) reproduced in
        # diffusers. i2v ONLY: it animates a supplied keyframe image, which is
        # how the storyboard pipeline drives it (Z Image Turbo keyframe → Wan
        # motion). No synced audio — callers lay music/narration in the edit.
        "id": "wan-2.2-i2v",
        "label": "Wan 2.2 14B (image-to-video, best quality)",
        "repo": os.getenv("OMNIGEN_WAN22_REPO", "Wan-AI/Wan2.2-I2V-A14B-Diffusers"),
        "extra_repos": [],
        "vram_mb": 10240,
        "ram_required_mb": 24576,
        "any_of": None,
        "generates_audio": False,
        # Lightning LoRA is distilled for CFG-free sampling. When the LoRA
        # fails to load, generate_video overrides to 20 steps / CFG 3.5.
        "default_guidance": 1.0,
        "gguf_repo": "QuantStack/Wan2.2-I2V-A14B-GGUF",
        "gguf_file": os.getenv(
            "OMNIGEN_WAN22_GGUF_HIGH",
            "HighNoise/Wan2.2-I2V-A14B-HighNoise-Q4_K_S.gguf",
        ),
        "gguf_file_2": os.getenv(
            "OMNIGEN_WAN22_GGUF_LOW",
            "LowNoise/Wan2.2-I2V-A14B-LowNoise-Q4_K_S.gguf",
        ),
        # The env overrides (like the GGUF ones above) also accept ABSOLUTE
        # LOCAL FILE PATHS — e.g. a ComfyUI install's models/loras files —
        # which are then used directly and skipped from the download plan.
        "lora_repo": "lightx2v/Wan2.2-Lightning",
        "lora_file": os.getenv(
            "OMNIGEN_WAN22_LORA_HIGH",
            "Wan2.2-I2V-A14B-4steps-lora-rank64-Seko-V1/high_noise_model.safetensors",
        ),
        "lora_file_2": os.getenv(
            "OMNIGEN_WAN22_LORA_LOW",
            "Wan2.2-I2V-A14B-4steps-lora-rank64-Seko-V1/low_noise_model.safetensors",
        ),
        "image_conditioning": "required",
        # The GGUFs replace BOTH bf16 transformer folders (~28 GB each) — the
        # base download is just the UMT5-XXL text encoder + VAE + configs.
        "repo_ignore_patterns": ["transformer/*", "transformer_2/*"],
        "download_size_mb": 31000,
        # Both GGUF experts + the streamed UMT5 pass through system RAM under
        # model offload; load peak on the 64 GB target is well under this.
        "peak_ram_mb": 26000,
        "backends": ["cuda", "rocm"],
        # Wan 2.2 14B is a 16 fps model; 81 frames ≈ 5 s. 832×480 is its native
        # 480p budget — the concat re-encode upscales to the final resolution.
        "default_frames": 81,
        # ~10 s at 16 fps. Group offload + VAE slicing keep the longer decode
        # in budget on 16 GB; for clips beyond this, use the storyboard pipeline
        # (it stitches many i2v shots into one long video).
        "max_frames": 161,
        "default_fps": 16,
        "default_width": 832,
        "default_height": 480,
        "default_steps": 4,
    },
    {
        # TOP — LTX-2.3 (synced audio+video) via a community GGUF transformer
        # (Q4_K_S 16.7 GB instead of the 40 GB bf16 one), run through group
        # offloading (see _enable_ltx2_group_offload). The full bf16 dev tier
        # was dropped: on a 16 GB card it needs bitsandbytes 4-bit, which on
        # current torch/diffusers leaves a "meta tensor" during model offload
        # and fails generation. The GGUF transformer + group offload path is
        # the reliable best-quality AV route — the ~16.7 GB transformer plus
        # the streamed Gemma-3 text encoder use the GPU and ~20 GB of RAM
        # together, which is exactly the 16 GB-VRAM / RAM-rich target.
        #
        # Distillation (8 steps, CFG 1) keeps it fast. any_of encodes the
        # VRAM↔RAM trade: a 6 GB card needs only 10 GB of RAM (disk-spilled
        # offload), a 4 GB card needs 30 GB. RAM-rich machines (≥24 GB) pin
        # the offload groups in system RAM instead of disk for speed.
        "id": "ltx-2-av-small",
        "label": "LTX-2.3 (synced audio+video)",
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
        # them instead of holding them in RAM. (~16.7 GB GGUF + ~55 GB shared
        # base = ~72 GB on a fresh machine; far less when the base is present.)
        "repo_ignore_patterns": ["transformer/*"],
        "download_size_mb": 72000,
        # Group offloading keeps peak RAM at pinning buffers + activations;
        # tight-RAM machines additionally spill the store to disk.
        "peak_ram_mb": 8000,
        "backends": ["cuda", "rocm"],
        # 768×512 @ 73 frames (~3 s, 24 fps) is the quality/speed sweet spot for
        # a 16 GB card with RAM offload; VAE tiling lets smaller cards run it too
        # (slower). Override per-clip in the UI settings.
        "default_frames": 73,
        "max_frames": 121,
        "default_fps": 24,
        "default_width": 768,
        "default_height": 512,
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
        # MID-HIGH — Wan 2.2 TI2V-5B for 6 GB-VRAM / 16 GB-RAM machines (the
        # supported hardware floor). Q4_K_S GGUF transformer (~3.1 GB) with the
        # UMT5-XXL text encoder streamed via group offload. Text-to-video here;
        # i2v on small machines goes through the LTX-2.3 tier above.
        "id": "wan-2.2-5b",
        "label": "Wan 2.2 5B (small GPU)",
        "repo": os.getenv("OMNIGEN_WAN22_5B_REPO", "Wan-AI/Wan2.2-TI2V-5B-Diffusers"),
        "extra_repos": [],
        "vram_mb": 5120,
        "ram_required_mb": 10240,
        "any_of": None,
        "generates_audio": False,
        "default_guidance": None,
        "gguf_repo": "QuantStack/Wan2.2-TI2V-5B-GGUF",
        "gguf_file": os.getenv(
            "OMNIGEN_WAN22_5B_GGUF", "Wan2.2-TI2V-5B-Q4_K_S.gguf"
        ),
        "repo_ignore_patterns": ["transformer/*"],
        "download_size_mb": 15000,
        "peak_ram_mb": 9000,
        "backends": ["cuda", "rocm"],
        # The 5B is a 24 fps model; 49 frames ≈ 2 s at a 6 GB-friendly budget.
        "default_frames": 49,
        "max_frames": 121,
        "default_fps": 24,
        "default_width": 704,
        "default_height": 448,
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


def _is_local_weight(value: Optional[str]) -> bool:
    """True when a tier's gguf/lora "file" is an absolute path to an existing
    local file (e.g. reused from a ComfyUI install via the OMNIGEN_WAN22_*
    env overrides) — loaded directly, excluded from the download plan."""
    if not value:
        return False
    p = Path(value)
    return p.is_absolute() and p.is_file()


def _tier_gguf_files(tier: VideoTier) -> list[str]:
    """GGUF file(s) this tier loads. LTX tiers swap to a lighter quant on
    tight-RAM machines (_ltx2_gguf_file); Wan tiers use their configured files
    as-is (high-noise expert + optional low-noise expert)."""
    if tier["id"].startswith("wan"):
        return [
            f for f in (tier.get("gguf_file"), tier.get("gguf_file_2")) if f
        ]
    single = _ltx2_gguf_file(tier)
    return [single] if single else []


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


def pick_best_video_tier(
    forced_tier_id: Optional[str] = None, has_image: bool = False
) -> VideoTier:
    """Best tier for this machine. A forced tier id is honored only when it
    actually fits the hardware — forcing a 12 GB model onto a 4 GB GPU used to
    hang the whole pipeline, so we degrade to auto-selection with a warning
    instead. i2v-only tiers (Wan 2.2 14B) are only eligible when the request
    carries a conditioning image (has_image)."""
    backend = get_backend()
    vram = get_vram_mb()
    total_ram = _get_total_ram_mb()

    def _usable(tier: VideoTier) -> bool:
        if tier.get("image_conditioning") == "required" and not has_image:
            return False
        return _tier_fits(tier, backend, vram, total_ram)

    if forced_tier_id:
        forced = next((t for t in VIDEO_TIERS if t["id"] == forced_tier_id), None)
        if forced is not None:
            if _usable(forced):
                return forced
            if forced.get("image_conditioning") == "required" and not has_image:
                log.warning(
                    "forced video tier %s needs a conditioning image and none "
                    "was provided — auto-selecting a text-to-video tier",
                    forced_tier_id,
                )
            else:
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
        if _usable(tier):
            return tier
    return VIDEO_TIERS[-1]


def _check_ram_sufficient(tier: VideoTier) -> None:
    """Raises RuntimeError with an actionable message if there isn't enough
    free RAM to load this video tier. Loading a large model into insufficient
    RAM causes Windows to swap to disk, locking up the entire machine for
    minutes. Refuse fast instead so the user can close other apps."""
    # Reclaim memory a just-unloaded pipeline freed but Python/torch hasn't
    # returned yet — otherwise switching tiers (e.g. an LTX fallback → Wan
    # retry) leaves the previous model's RAM counted as "in use" and this check
    # false-fails a model that actually fits.
    gc.collect()
    try:
        import torch  # type: ignore

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:  # noqa: BLE001
        pass
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
# Derived image-to-video view of the cached pipeline (from_pipe — shares the
# same loaded components, no extra weights). Reset whenever _pipeline changes.
_i2v_pipeline = None
_lock = threading.Lock()

_download_progress: dict[str, float] = {}
_download_bytes_on_disk: dict[str, int] = {}
_download_speed_bps: dict[str, float] = {}
_download_errors: dict[str, str] = {}
_downloading_tiers: set[str] = set()


def _hf_cache_dir() -> Path:
    hf_home = os.environ.get("HF_HOME", "")
    if hf_home:
        return Path(hf_home) / "hub"
    return Path.home() / ".cache" / "huggingface" / "hub"


def _repo_dir(repo: str) -> Path:
    return _hf_cache_dir() / f"models--{repo.replace('/', '--')}"


def _partial_marker_path(tier_id: str) -> Path:
    return _hf_cache_dir() / ".orianbuilder_partial" / tier_id


def _mark_download_started(tier_id: str) -> None:
    marker = _partial_marker_path(tier_id)
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.touch()


def _clear_partial_marker(tier_id: str) -> None:
    _partial_marker_path(tier_id).unlink(missing_ok=True)


def _is_partial_download(tier_id: str) -> bool:
    return _partial_marker_path(tier_id).exists()


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
    # Local-file overrides (OMNIGEN_WAN22_* envs) need no download.
    gguf_files = [f for f in _tier_gguf_files(tier) if not _is_local_weight(f)]
    if tier.get("gguf_repo") and gguf_files:
        specs.append({"repo_id": tier["gguf_repo"], "allow_patterns": gguf_files})
    lora_files = [
        f
        for f in (tier.get("lora_file"), tier.get("lora_file_2"))
        if f and not _is_local_weight(f)
    ]
    if tier.get("lora_repo") and lora_files:
        specs.append({"repo_id": tier["lora_repo"], "allow_patterns": lora_files})
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
    if all(_spec_downloaded(s) for s in specs) and not _is_partial_download(tier_id):
        return "downloaded"
    if _is_partial_download(tier_id):
        return "partial"
    return "not_downloaded"


def get_download_error(tier_id: str) -> str | None:
    return _download_errors.get(tier_id)


def delete_tier(tier_id: str) -> None:
    """Remove a downloaded video tier's weights from the HF cache so the UI can
    reclaim space. Removes every repo the tier fetches (tier_download_specs).
    Tiers that share a repo (e.g. the two LTX-2.3 tiers reuse the same diffusers
    repo + text encoder) will both report not_downloaded afterward — that's
    correct, the shared weights are gone and either can be re-downloaded."""
    import shutil

    global _pipeline, _pipeline_tier_id

    tier = next((t for t in VIDEO_TIERS if t["id"] == tier_id), None)
    if not tier:
        return
    # Drop the cached pipeline if it's this tier so the files aren't held open.
    with _lock:
        if _pipeline_tier_id == tier_id:
            _pipeline = None
            _pipeline_tier_id = None
            gc.collect()
    for spec in tier_download_specs(tier):
        shutil.rmtree(_repo_dir(spec["repo_id"]), ignore_errors=True)
    _download_errors.pop(tier_id, None)
    _clear_partial_marker(tier_id)


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


# Two-phase stall detection:
#   - Before first bytes arrive: allow a long grace period for the HF metadata
#     fetch (resolving file list, checking cache). Large repos like LTX-2.3 can
#     take several minutes just fetching the index, especially on slow connections.
#   - After first bytes arrive: revert to a short stall window to catch hung
#     transfers (hf_transfer / xet can hang silently on flaky networks).
_DOWNLOAD_INITIAL_GRACE_SECONDS = 600  # 10 min for metadata fetch before first byte
_DOWNLOAD_STALL_SECONDS = 90  # stall window once data has started flowing
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
            seen_first_byte = last_size > 0
            # Use the long grace period until the first byte arrives, then
            # switch to the short stall window to catch hung transfers.
            stall_limit = (
                _DOWNLOAD_STALL_SECONDS
                if seen_first_byte
                else _DOWNLOAD_INITIAL_GRACE_SECONDS
            )
            stalled = False
            while proc.poll() is None:
                time.sleep(2)
                size = _dir_size_bytes(repo_dir)
                if size > last_size:
                    last_size = size
                    last_growth = time.monotonic()
                    if not seen_first_byte:
                        seen_first_byte = True
                        stall_limit = _DOWNLOAD_STALL_SECONDS
                if progress_cb:
                    done = already_bytes + size
                    fraction = (
                        min(0.99, done / total_bytes_hint)
                        if total_bytes_hint > 0
                        else None
                    )
                    progress_cb(f"downloading {repo}", fraction)
                if time.monotonic() - last_growth > stall_limit:
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
            f"stalled (no progress for {stall_limit}s)"
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
    # When a partial marker exists HF may have already created the snapshot dir
    # (it does so early, before files are complete), so _spec_downloaded() would
    # incorrectly return True. Force re-verify every spec so snapshot_download
    # resumes/completes the partial files rather than silently skipping them.
    if _is_partial_download(tier["id"]):
        missing = specs
    else:
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
    _mark_download_started(tier_id)
    _downloading_tiers.add(tier_id)
    _download_errors.pop(tier_id, None)
    total_hint = tier["download_size_mb"] * 1024 * 1024
    _last_cb: dict[str, object] = {"time": time.monotonic(), "bytes": 0.0}
    succeeded = False

    def _progress_cb(stage: str, p: Optional[float]) -> None:
        fraction = p or 0.0
        _download_progress[tier_id] = fraction * 100.0
        if p is not None and total_hint > 0:
            bytes_done = int(fraction * total_hint)
            _download_bytes_on_disk[tier_id] = bytes_done
            now = time.monotonic()
            dt = now - float(_last_cb["time"])
            prev_bytes = float(_last_cb["bytes"])
            if dt >= 1.0 and bytes_done > prev_bytes:
                _download_speed_bps[tier_id] = (bytes_done - prev_bytes) / dt
                _last_cb["time"] = now
                _last_cb["bytes"] = float(bytes_done)

    try:
        ensure_tier_downloaded(tier, _progress_cb)
        succeeded = True
    except Exception as exc:  # noqa: BLE001
        _download_errors[tier_id] = str(exc)
    finally:
        _downloading_tiers.discard(tier_id)
        _download_progress.pop(tier_id, None)
        _download_bytes_on_disk.pop(tier_id, None)
        _download_speed_bps.pop(tier_id, None)
        if succeeded:
            _clear_partial_marker(tier_id)


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


def _try_pipe_method(pipe, name: str) -> None:
    fn = getattr(pipe, name, None)
    if callable(fn):
        try:
            fn()
        except Exception:  # noqa: BLE001
            pass


def _enable_ltx2_savers(pipe, vram_mb: int) -> None:
    """Memory savers tuned for LTX-2.

    LTX's video VAE *tiling* is the problem: the spatial tiles decode with
    slightly different normalization, producing visible seams, color shifts and
    the neon oversaturation seen on a 16 GB card. VAE *slicing* (temporal, decode
    a few frames at a time) is memory-safe and artifact-free, so keep it on.
    Spatial tiling is only enabled when VRAM is genuinely tight (<12 GB), where a
    seamed-but-present frame beats an OOM. Attention slicing is cheap, always on."""
    _try_pipe_method(pipe, "enable_attention_slicing")
    _try_pipe_method(pipe, "enable_vae_slicing")
    if vram_mb and vram_mb < 12000:
        _try_pipe_method(pipe, "enable_vae_tiling")
    else:
        # Clean, untiled spatial decode on cards with the headroom for it.
        _try_pipe_method(pipe, "disable_vae_tiling")


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
    # Attention + VAE slicing are artifact-free; spatial VAE tiling decodes in
    # patches that seam and oversaturate (the neon-green melt). Only tile when
    # VRAM is genuinely tight (<12 GB) — a 16 GB card decodes untiled and clean.
    _try_pipe_method(pipe, "enable_attention_slicing")
    _try_pipe_method(pipe, "enable_vae_slicing")
    if get_vram_mb() and get_vram_mb() < 12000:
        _try_pipe_method(pipe, "enable_vae_tiling")
    else:
        _try_pipe_method(pipe, "disable_vae_tiling")
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


def _offload_store_dir(subdir: str = "ltx2") -> Path:
    base = os.getenv("OMNIGEN_MODELS_DIR", str(BACKEND_DIR / "models"))
    return Path(base) / "offload" / subdir


def _enable_ltx2_selective_offload(pipe) -> bool:
    """Stream ONLY the two huge components — the LTX-2 transformer (~16.7 GB
    GGUF) and the Gemma-3 text encoder (~42 GB) — through group offloading, and
    keep the small ones (video VAE, audio VAE, connectors, vocoder) RESIDENT on
    the GPU.

    Whole-pipe offload (the fallback below) streams the VAE too, so it decodes a
    few KB at a time on a card that has 10 GB free — slow, and it leaves the GPU
    barely used (the ~5.5 GB we saw). Decoding the video VAE resident is faster
    and avoids the tiling/streaming color artifacts. Returns False if the
    per-module API or the expected component layout isn't present so the caller
    can fall back to whole-pipe offload."""
    import torch  # type: ignore

    try:
        from diffusers.hooks import apply_group_offloading  # type: ignore
    except Exception as exc:  # noqa: BLE001
        log.info("per-module group offload unavailable (%s)", exc)
        return False

    cuda = torch.device("cuda")
    cpu = torch.device("cpu")
    stream_components = ("transformer", "text_encoder")
    resident_components = ("vae", "audio_vae", "connectors", "vocoder")

    offload_kwargs: dict = {
        "onload_device": cuda,
        "offload_device": cpu,
        "offload_type": "leaf_level",
        "use_stream": True,
        "low_cpu_mem_usage": True,
    }
    if _ltx2_is_tight_ram():
        store = _offload_store_dir()
        store.mkdir(parents=True, exist_ok=True)
        offload_kwargs["offload_to_disk_path"] = str(store)

    try:
        for name in stream_components:
            module = getattr(pipe, name, None)
            if module is None:
                log.info("LTX-2 component %r absent; using whole-pipe offload", name)
                return False
            try:
                apply_group_offloading(module, **offload_kwargs)
            except TypeError:
                reduced = {k: v for k, v in offload_kwargs.items()
                           if k != "low_cpu_mem_usage"}
                apply_group_offloading(module, **reduced)
        for name in resident_components:
            module = getattr(pipe, name, None)
            if module is not None:
                try:
                    module.to(cuda)
                except Exception as exc:  # noqa: BLE001
                    log.info("could not keep %s resident on GPU (%s)", name, exc)
        log.info(
            "LTX-2 selective offload: streaming %s, GPU-resident %s",
            stream_components,
            resident_components,
        )
        return True
    except Exception as exc:  # noqa: BLE001
        log.warning(
            "LTX-2 selective offload failed (%s); using whole-pipe offload", exc
        )
        return False


def _enable_whole_pipe_group_offload(pipe, store_subdir: str = "ltx2") -> bool:
    """Whole-pipe group offloading: weight groups stream to the GPU as the
    forward pass reaches them, so nothing has to fit anywhere whole — which is
    the only way e.g. the ~42 GB bf16 Gemma-3 text encoder runs on a laptop.
    RAM-rich machines keep the groups pinned in system RAM; tight-RAM machines
    (16 GB class) spill the store to disk and re-read it each step (slow but
    bounded). Returns False when this diffusers/model combo doesn't support it
    so the caller can fall back."""
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
        store = _offload_store_dir(store_subdir)
        store.mkdir(parents=True, exist_ok=True)
        kwargs["offload_to_disk_path"] = str(store)
    for attempt_kwargs in (kwargs, {k: v for k, v in kwargs.items() if k != "low_cpu_mem_usage"}):
        try:
            pipe.enable_group_offload(**attempt_kwargs)
            log.info(
                "group offload enabled (disk_spill=%s)",
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
        if quant is None and device == "cuda":
            # No GGUF transformer and no bitsandbytes → the only path left is the
            # full bf16 checkpoint: ~40 GB transformer + ~42 GB Gemma-3 text
            # encoder. That exceeds system RAM on every consumer machine and
            # OOM-segfaults the process mid-load (Windows 0xC0000005). Refuse
            # cleanly so get_pipeline demotes BOTH LTX-2.3 tiers to LTX-Video
            # instead of crashing the backend.
            raise TierUnavailableError(
                "LTX-2.3 needs 4-bit quantization (install bitsandbytes) or a "
                "GGUF transformer to fit in memory; neither is available on this "
                "install. Falling back to a tier that fits."
            )
        load_kwargs: dict = {"torch_dtype": dtype, "low_cpu_mem_usage": True}
        if quant is not None:
            load_kwargs["quantization_config"] = quant
        try:
            pipe = LTX2Pipeline.from_pretrained(tier["repo"], **load_kwargs)
        except Exception:
            if quant is None or device != "cuda":
                raise
            # Quantized load failed (bnb/CUDA mismatch, unsupported component…).
            # On CUDA the unquantized retry would mean the full ~80 GB bf16
            # checkpoint → OOM segfault, so demote instead of attempting it.
            log.warning(
                "quantized LTX-2.3 load failed on CUDA; demoting tier "
                "(unquantized bf16 would not fit in RAM)"
            )
            raise TierUnavailableError(
                "LTX-2.3 4-bit load failed and the unquantized model does not "
                "fit in memory — falling back to a tier that fits."
            )

    vram = get_vram_mb()
    if device == "cuda" and transformer is not None:
        # The GGUF transformer (15-17 GB) and Gemma-3 text encoder (42 GB bf16)
        # can't sit on a 16 GB card whole, so they stream. Prefer SELECTIVE
        # offload — stream only those two, keep the small VAE/connectors/vocoder
        # resident on the GPU for a fast, clean, untiled video decode. Fall back
        # to whole-pipe offload, then sequential, on older diffusers.
        if not (
            _enable_ltx2_selective_offload(pipe)
            or _enable_whole_pipe_group_offload(pipe)
        ):
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
        # Loading the 95 GB checkpoint leaves transient buffers pinned in RAM;
        # free them first so model offload (which needs a little headroom to
        # build its hooks) doesn't fail on a tight-RAM machine.
        gc.collect()
        try:
            import torch  # type: ignore

            torch.cuda.empty_cache()
        except Exception:  # noqa: BLE001
            pass
        try:
            pipe.enable_model_cpu_offload()
        except Exception as exc:  # noqa: BLE001
            # Out of RAM for model offload's hooks — fall back to sequential
            # offload, which streams one module at a time and needs far less
            # headroom. bnb-4bit components are device-mapped at load and refuse
            # .to(), so keeping the load placement is the last resort.
            log.warning("model offload failed (%s); trying sequential offload", exc)
            try:
                pipe.enable_sequential_cpu_offload()
                log.info("sequential_cpu_offload enabled for LTX-2.3 (fallback)")
            except Exception as exc2:  # noqa: BLE001
                log.warning(
                    "sequential offload failed (%s); keeping load placement", exc2
                )
                try:
                    pipe = pipe.to(device)
                except Exception:  # noqa: BLE001
                    pass
    else:
        try:
            pipe = pipe.to(device)
        except Exception:  # noqa: BLE001 — quantized components refuse .to()
            pass
    _enable_ltx2_savers(pipe, vram)
    return pipe


# The canonical Wan negative prompt (from the model card / reference
# workflows). Only used when sampling WITH classifier-free guidance — the
# Lightning LoRA path runs CFG-free (guidance 1.0) and never encodes it.
_WAN_NEGATIVE_PROMPT = (
    "色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，"
    "整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，"
    "画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，"
    "静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走"
)

# True when the resident Wan pipeline has the Lightning LoRA active (4-step
# CFG-free sampling). Without it generate_video falls back to 20 steps + CFG.
_wan_lightning_loaded = False


def _load_wan(tier: VideoTier, device: str):
    """Loads a Wan 2.2 pipeline (diffusers ≥ 0.38): the 14B i2v tier with two
    GGUF transformer experts (high/low noise) + the lightx2v Lightning LoRA,
    or the 5B t2v tier with one GGUF transformer. Raises TierUnavailableError
    when this install can't run it so selection demotes cleanly."""
    global _wan_lightning_loaded
    try:
        from diffusers import (  # type: ignore
            GGUFQuantizationConfig,
            WanImageToVideoPipeline,
            WanPipeline,
            WanTransformer3DModel,
        )
    except (ImportError, AttributeError) as exc:
        raise TierUnavailableError(
            f"diffusers has no Wan 2.2 support ({exc}); update the media "
            "backend dependencies (diffusers >= 0.38)"
        ) from exc
    import torch  # type: ignore

    dtype = _ltx2_dtype(device)

    def _gguf_transformer(gguf_file: str, subfolder: str):
        source = (
            gguf_file
            if _is_local_weight(gguf_file)
            else f"https://huggingface.co/{tier['gguf_repo']}/blob/main/{gguf_file}"
        )
        log.info("loading Wan GGUF transformer (%s) from %s", subfolder, source)
        return WanTransformer3DModel.from_single_file(
            source,
            quantization_config=GGUFQuantizationConfig(compute_dtype=dtype),
            config=tier["repo"],
            subfolder=subfolder,
            torch_dtype=dtype,
        )

    load_kwargs: dict = {"torch_dtype": dtype, "low_cpu_mem_usage": True}
    if tier.get("gguf_file"):
        try:
            load_kwargs["transformer"] = _gguf_transformer(
                tier["gguf_file"], "transformer"
            )
            if tier.get("gguf_file_2"):
                load_kwargs["transformer_2"] = _gguf_transformer(
                    tier["gguf_file_2"], "transformer_2"
                )
        except Exception as exc:  # noqa: BLE001
            # Without the GGUFs the bf16 experts are ~28 GB each — not loadable
            # on this tier's hardware class. Demote instead of OOMing.
            raise TierUnavailableError(
                f"Wan GGUF transformer load failed: {exc}"
            ) from exc

    is_i2v = tier.get("image_conditioning") == "required"
    pipeline_cls = WanImageToVideoPipeline if is_i2v else WanPipeline
    pipe = pipeline_cls.from_pretrained(tier["repo"], **load_kwargs)

    # Lightning LoRA: 4-step CFG-free sampling distilled by lightx2v. Loaded
    # into BOTH experts (transformer + transformer_2). Best-effort — without
    # it the model still works at 20 steps with CFG, just ~8× slower.
    _wan_lightning_loaded = False
    if tier.get("lora_repo") and os.getenv("OMNIGEN_WAN_LIGHTNING", "1") != "0":

        def _load_one_lora(lora_file: str, adapter_name: str, **kw) -> None:
            # Local file (e.g. reused from a ComfyUI install): diffusers'
            # Wan LoRA converter handles the ComfyUI key format directly.
            if _is_local_weight(lora_file):
                pipe.load_lora_weights(lora_file, adapter_name=adapter_name, **kw)
            else:
                pipe.load_lora_weights(
                    tier["lora_repo"],
                    weight_name=lora_file,
                    adapter_name=adapter_name,
                    **kw,
                )

        try:
            _load_one_lora(tier["lora_file"], "lightning")
            adapters = ["lightning"]
            if (
                tier.get("lora_file_2")
                and getattr(pipe, "transformer_2", None) is not None
            ):
                _load_one_lora(
                    tier["lora_file_2"],
                    "lightning_2",
                    load_into_transformer_2=True,
                )
                adapters.append("lightning_2")
            pipe.set_adapters(adapters, adapter_weights=[1.0] * len(adapters))
            _wan_lightning_loaded = True
            log.info(
                "Wan Lightning LoRA active (%s) — 4-step CFG-free sampling",
                ", ".join(adapters),
            )
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "Wan Lightning LoRA failed to load (%s) — falling back to "
                "full-step sampling (20 steps, CFG 3.5)",
                exc,
            )

    vram = get_vram_mb()
    if device == "cuda":
        gc.collect()
        try:
            torch.cuda.empty_cache()
        except Exception:  # noqa: BLE001
            pass
        # Wan 2.2 14B i2v OOMs a 16 GB card under whole-MODEL offload: that
        # keeps the entire active 8.7 GB expert resident, and with the i2v image
        # latents + 81-frame activations the first denoise step exceeds VRAM and
        # the worker dies with a native 0xC0000005 (exit 3221225477). Stream the
        # transformer in BLOCK groups instead (the diffusers equivalent of
        # ComfyUI's block-swap) on anything below a 24 GB card so only a few
        # blocks sit on the GPU at once — peak VRAM stays well under 16 GB while
        # the ~28 GB of weights live in system RAM (this 64 GB machine has the
        # headroom). Reserve the faster whole-model offload for 24 GB+ cards
        # that actually fit a whole expert.
        offloaded = False
        if vram and vram < 24000:
            offloaded = _enable_whole_pipe_group_offload(pipe, store_subdir="wan")
            if not offloaded:
                log.warning(
                    "Wan group offload unavailable; falling back to model offload "
                    "(may OOM on a 16 GB card)"
                )
        if not offloaded:
            try:
                pipe.enable_model_cpu_offload()
                offloaded = True
            except Exception as exc:  # noqa: BLE001
                log.warning("model offload failed (%s); trying sequential", exc)
        if not offloaded:
            try:
                pipe.enable_sequential_cpu_offload()
            except Exception as exc:  # noqa: BLE001
                log.warning("sequential offload failed (%s)", exc)
        # VAE slicing (temporal — decode a few frames at a time) is memory-safe
        # and artifact-free, so always on. Spatial TILING, by contrast, decodes
        # in patches that normalize differently → visible seams + color shift +
        # neon oversaturation (the same artifact seen on LTX). With block-level
        # group offload already keeping VRAM low, slicing alone fits the 81-frame
        # decode on a 16 GB card, so only tile on genuinely tiny (<8 GB) cards
        # where a seamed frame beats an OOM.
        _try_pipe_method(pipe, "enable_vae_slicing")
        if vram and vram < 8000:
            _try_pipe_method(pipe, "enable_vae_tiling")
        else:
            _try_pipe_method(pipe, "disable_vae_tiling")
    else:
        pipe = pipe.to(device)
    return pipe


def get_pipeline(forced_tier_id: Optional[str] = None, has_image: bool = False):
    global _pipeline, _pipeline_tier_id

    tier = pick_best_video_tier(forced_tier_id, has_image=has_image)
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

    if tier["id"].startswith("wan"):
        try:
            pipe = _load_wan(tier, device)
        except TierUnavailableError as exc:
            # No Wan support on this install (or the GGUF failed) — demote for
            # this process and re-select. generate_video re-reads the loaded
            # tier id, so kwargs match the fallback tier.
            log.warning("%s unavailable: %s — falling back", tier["id"], exc)
            _unavailable_tiers.add(tier["id"])
            return get_pipeline(None, has_image=has_image)
    elif tier["id"] == "ltx-2-av-small":
        try:
            pipe = _load_ltx2(tier, device)
        except TierUnavailableError as exc:
            # No LTX-2 support on this install (or no GGUF) — demote for this
            # process and re-select. generate_video re-reads the loaded tier id,
            # so kwargs match the fallback tier.
            log.warning("LTX-2.3 unavailable: %s — falling back to next tier", exc)
            _unavailable_tiers.add("ltx-2-av-small")
            return get_pipeline(None, has_image=has_image)
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
    global _i2v_pipeline
    _i2v_pipeline = None
    _pipeline = pipe
    _pipeline_tier_id = tier["id"]
    return _pipeline


def unload_pipeline() -> None:
    global _pipeline, _pipeline_tier_id, _i2v_pipeline, _wan_lightning_loaded
    _pipeline = None
    _pipeline_tier_id = None
    _i2v_pipeline = None
    _wan_lightning_loaded = False
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


def _is_wan_family(tier: VideoTier) -> bool:
    return tier["id"].startswith("wan")


def _quantize_frames(tier: VideoTier, frames: int) -> int:
    frames = max(8, min(frames, tier["max_frames"]))
    if _is_ltx_family(tier):
        # LTX requires num_frames ≡ 1 (mod 8).
        return max(9, ((frames - 1) // 8) * 8 + 1)
    if _is_wan_family(tier):
        # Wan's VAE has temporal stride 4: num_frames ≡ 1 (mod 4).
        return max(13, ((frames - 1) // 4) * 4 + 1)
    return frames


def _quantize_dim(tier: VideoTier, value: int) -> int:
    # LTX wants multiples of 32; Wan multiples of 16 (patchified 8× VAE);
    # SD-family pipelines need multiples of 8.
    multiple = 32 if _is_ltx_family(tier) else 16 if _is_wan_family(tier) else 8
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


def _i2v_view(tier: VideoTier, pipe):
    """An image-to-video pipeline over the SAME loaded components as `pipe`
    (diffusers from_pipe — no second copy of the weights, offload hooks stay
    on the shared modules). Returns None when this tier has no i2v variant.
    The Wan 14B tier IS its i2v pipeline already; LTX tiers derive one."""
    global _i2v_pipeline
    if tier.get("image_conditioning") == "required":
        return pipe
    if _i2v_pipeline is not None:
        return _i2v_pipeline
    try:
        if tier["id"] == "ltx-2-av-small":
            from diffusers import LTX2ImageToVideoPipeline  # type: ignore

            _i2v_pipeline = LTX2ImageToVideoPipeline.from_pipe(_pipeline)
        elif tier["id"] == "ltx-video":
            from diffusers import LTXImageToVideoPipeline  # type: ignore

            _i2v_pipeline = LTXImageToVideoPipeline.from_pipe(_pipeline)
        else:
            return None
    except Exception as exc:  # noqa: BLE001
        log.warning(
            "no i2v variant for tier %s (%s) — generating text-to-video",
            tier["id"],
            exc,
        )
        return None
    return _i2v_pipeline


def _to_frame_sequence(frames):
    """Normalize whatever a video pipeline returned into a sequence of
    (H, W, C) frames that diffusers' export_to_video accepts.

    Pipelines disagree on the shape: LTX returns a batched list[list[PIL]];
    Wan returns a batched ndarray (batch, frames, H, W, C) — and the old
    list-only unwrap passed that 5-D array straight to export_to_video, which
    crashed with "Image must have 1, 2, 3 or 4 channels". Handle tensors,
    ndarrays (extra batch dims, channels-first), and batched PIL lists."""
    import numpy as np

    try:
        import torch  # type: ignore

        if isinstance(frames, torch.Tensor):
            frames = frames.detach().to("cpu", dtype=torch.float32).numpy()
    except ImportError:
        pass

    if isinstance(frames, np.ndarray):
        # Drop leading batch dims down to (frames, H, W, C).
        while frames.ndim > 4:
            frames = frames[0]
        # Channels-first (frames, C, H, W) → channels-last.
        if (
            frames.ndim == 4
            and frames.shape[1] in (1, 3, 4)
            and frames.shape[-1] not in (1, 3, 4)
        ):
            frames = np.transpose(frames, (0, 2, 3, 1))
        return frames

    if isinstance(frames, (list, tuple)) and frames:
        first = frames[0]
        # Batched list of videos (list[list[PIL]]) → the first video.
        if isinstance(first, (list, tuple)):
            return first
        # A single-element wrapper around a tensor/ndarray video.
        try:
            import torch  # type: ignore

            if isinstance(first, torch.Tensor):
                return _to_frame_sequence(first)
        except ImportError:
            pass
        if isinstance(first, np.ndarray) and first.ndim == 4:
            return _to_frame_sequence(first)
    return frames


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
    image_path: Optional[str] = None,
    seed: Optional[int] = None,
    negative_prompt: Optional[str] = None,
    progress_cb: Optional[ProgressFn] = None,
) -> dict:
    """Generates a video and returns {video_path, video_url, model, tier,
    has_audio}. Writes the file under OMNIGEN_OUTPUTS_DIR. progress_cb
    (stage, 0..1|None) receives model-load + per-step progress and doubles as
    the cancel point — it may raise to abort generation. When width/height are
    omitted, aspect_ratio ("16:9", "9:16", …) sizes the clip to the selected
    tier's pixel budget. image_path supplies a keyframe for image-to-video
    tiers (Wan 2.2 14B requires one; LTX tiers use it when given; others
    ignore it)."""
    OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)

    def report(stage: str, progress: Optional[float] = None) -> None:
        if progress_cb:
            progress_cb(stage, progress)

    has_image = bool(image_path)
    with _lock:
        tier = pick_best_video_tier(forced_tier_id, has_image=has_image)
        report(f"loading {tier['label']}", None)
        pipe = get_pipeline(tier["id"], has_image=has_image)
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

        # Seed for reproducible output. A CPU generator works across every
        # offload mode (the execution device varies under group/model offload);
        # absent seed = fresh random noise each run.
        if seed is not None:
            import torch  # type: ignore

            kwargs["generator"] = torch.Generator(device="cpu").manual_seed(int(seed))

        # Image conditioning: load the keyframe for tiers that can use it.
        image = None
        if image_path and tier.get("image_conditioning"):
            from PIL import Image

            image = Image.open(image_path).convert("RGB")
        elif image_path:
            log.info(
                "tier %s is text-to-video only — ignoring keyframe", tier["id"]
            )
        if tier.get("image_conditioning") == "required" and image is None:
            raise RuntimeError(
                f"{tier['label']} is an image-to-video model and needs a "
                "keyframe image (image_path) — or pick a text-to-video tier"
            )

        if _is_wan_family(tier):
            lightning = bool(tier.get("lora_repo")) and _wan_lightning_loaded
            if tier.get("lora_repo") and not _wan_lightning_loaded:
                # The Lightning LoRA didn't load (or was disabled via
                # OMNIGEN_WAN_LIGHTNING=0 for higher quality): its 4-step
                # schedule produces noise without it, so run full CFG sampling.
                # Step count is configurable via OMNIGEN_WAN_STEPS — more steps
                # = better motion/detail at a near-linear time cost. 12 is a
                # strong quality/speed balance vs the 4-step Lightning draft.
                _full_steps = int(os.getenv("OMNIGEN_WAN_STEPS", "12"))
                kwargs["num_inference_steps"] = steps or _full_steps
                kwargs["guidance_scale"] = 3.5
                lightning = False
            if not lightning:
                # CFG is active: use the caller's negative prompt if supplied,
                # else the canonical Wan one (measurably cleans up motion/
                # anatomy). Both are unused/unencoded at CFG 1.0 Lightning.
                kwargs["negative_prompt"] = negative_prompt or _WAN_NEGATIVE_PROMPT
        elif negative_prompt:
            # LTX / AnimateDiff / Text-to-Video pipelines take a negative prompt
            # directly (effective only when their guidance > 1).
            kwargs["negative_prompt"] = negative_prompt

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

        call_pipe = pipe
        if image is not None:
            i2v = _i2v_view(tier, pipe)
            if i2v is None:
                image = None  # tier has no i2v variant — plain t2v
            else:
                call_pipe = i2v
        if image is not None:
            kwargs["image"] = image

        try:
            result = call_pipe(
                prompt=prompt, callback_on_step_end=_on_step_end, **kwargs
            )
        except TypeError:
            # Older pipelines (e.g. TextToVideoSDPipeline) predate the unified
            # callback API — run without per-step progress rather than failing.
            result = call_pipe(prompt=prompt, **kwargs)

    # Diffusers pipelines return either a `.frames` (list of PIL frames) or a
    # `.videos` ndarray; normalize to a sequence export_to_video accepts.
    frames = getattr(result, "frames", None)
    if frames is None:
        frames = getattr(result, "videos", None)
    if frames is None:
        raise RuntimeError(f"video pipeline returned no frames (tier={tier['id']})")

    frame_seq = _to_frame_sequence(frames)

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
