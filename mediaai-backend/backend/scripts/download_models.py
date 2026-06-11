import argparse
import json
import os
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path

from huggingface_hub import hf_hub_download, snapshot_download
import huggingface_hub.utils as hf_utils

BACKEND_DIR = Path(__file__).resolve().parents[1]
MODELS_DIR = Path(os.getenv("OMNIGEN_MODELS_DIR", str(BACKEND_DIR / "models")))
HF_CACHE_DIR = Path(os.getenv("OMNIGEN_HF_CACHE_DIR", str(MODELS_DIR / "huggingface")))
MARKER_DIR = MODELS_DIR / ".model-markers"

class DownloadProgressTracker:
    def __init__(self):
        self.active_downloads = {}
        self.lock = threading.Lock()
        self.last_reported = -1.0

    def update(self, tqdm_id, downloaded, total):
        with self.lock:
            self.active_downloads[tqdm_id] = (downloaded, total)
            total_bytes = sum(t for d, t in self.active_downloads.values() if t)
            downloaded_bytes = sum(d for d, t in self.active_downloads.values() if t)
            if total_bytes > 0:
                progress = round((downloaded_bytes / total_bytes) * 100.0, 1)
                # Only print if it changed by at least 0.1% to avoid spamming
                if progress > self.last_reported + 0.5 or progress == 100.0:
                    self.last_reported = progress
                    print(json.dumps({"type": "progress", "percentage": progress}), flush=True)

tracker = DownloadProgressTracker()
original_tqdm = hf_utils.tqdm

class JsonProgressTqdm(original_tqdm):
    def update(self, n=1):
        super().update(n)
        if getattr(self, "unit", "") in ("B", "iB", "bytes") or getattr(self, "unit_scale", False):
            if hasattr(self, "total") and self.total and self.total > 100000:
                tracker.update(id(self), self.n, self.total)

hf_utils.tqdm = JsonProgressTqdm


MODEL_GROUPS = {
    "text": [
        {
            "kind": "file",
            "repo_id": os.getenv(
                "OMNIGEN_TEXT_MODEL_REPO",
                "microsoft/Phi-3-mini-4k-instruct-gguf",
            ),
            "filename": os.getenv(
                "OMNIGEN_TEXT_MODEL_FILE",
                "Phi-3-mini-4k-instruct-q4.gguf",
            ),
        },
    ],
    "image": [
        {
            "kind": "snapshot",
            "repo_id": os.getenv(
                "OMNIGEN_IMAGE_MODEL_ID",
                "nmkd/stable-diffusion-1.5-onnx-fp16",
            ),
        },
    ],
    "audio": [
        {"kind": "snapshot", "repo_id": "microsoft/speecht5_tts"},
        {"kind": "snapshot", "repo_id": "microsoft/speecht5_hifigan"},
        {"kind": "snapshot", "repo_id": "facebook/mms-tts-eng"},
    ],
    # Resolved dynamically in _video_specs(): downloads the tier that
    # pick_best_video_tier selects for THIS machine (top/mid/small/cpu), so
    # setup pre-fetches the weights generation will actually use.
    "video": [],
    # Tier-specific image entries, exposed in the Media AI page dropdown.
    "image-sd-turbo": [
        {"kind": "snapshot", "repo_id": "stabilityai/sd-turbo"},
    ],
    "image-z-image-turbo": [
        {"kind": "snapshot", "repo_id": "Tongyi-MAI/Z-Image-Turbo"},
    ],
    # Whisper Base CT2 weights — pre-downloads the default tier for /v1/transcribe
    # so the first transcription doesn't block on a HF fetch. faster-whisper
    # accepts the model name ("base") and pulls from Systran/faster-whisper-base.
    "whisper": [
        {"kind": "snapshot", "repo_id": "Systran/faster-whisper-base"},
    ],
}


def _video_specs() -> list[dict]:
    """Hardware-matched video tier repos. Importing app.models.video works
    because the Electron host runs this script with PYTHONPATH=<backend dir>
    and the same ORIANBUILDER_* hardware env vars the server gets.

    Video specs use kind "snapshot_cache": they download into the default HF
    cache (HF_HOME/hub — the host sets HF_HOME) because that is where the
    backend's from_pretrained/tier_status look. The local_dir copy the other
    groups make is invisible to the video loader, which would silently
    re-download tens of GB at first generation."""
    override = os.getenv("OMNIGEN_VIDEO_MODEL_ID")
    if override:
        return [{"kind": "snapshot_cache", "repo_id": override}]
    try:
        from app.models.video import pick_best_video_tier, tier_download_specs

        tier = pick_best_video_tier()
        print(f"Video tier for this machine: {tier['id']}", flush=True)
        return [
            {
                "kind": "snapshot_cache",
                "repo_id": spec["repo_id"],
                "allow_patterns": spec.get("allow_patterns"),
                "ignore_patterns": spec.get("ignore_patterns"),
            }
            for spec in tier_download_specs(tier)
        ]
    except Exception as exc:  # noqa: BLE001 — fall back to the CPU-safe model
        print(f"Video tier resolution failed ({exc}); using CPU fallback", flush=True)
        return [
            {"kind": "snapshot_cache", "repo_id": "damo-vilab/text-to-video-ms-1.7b"}
        ]


def write_marker(model_group: str, downloaded_paths: list[str]) -> None:
    MARKER_DIR.mkdir(parents=True, exist_ok=True)
    marker_path = MARKER_DIR / f"{model_group}.json"
    marker_path.write_text(
        json.dumps(
            {
                "modelGroup": model_group,
                "downloadedAt": datetime.now(timezone.utc).isoformat(),
                "paths": downloaded_paths,
            },
            indent=2,
        ),
        encoding="utf-8",
    )


def download_group(model_group: str) -> None:
    specs = _video_specs() if model_group == "video" else MODEL_GROUPS[model_group]
    downloaded_paths = []
    for spec in specs:
        repo_id = spec["repo_id"]
        print(f"Downloading {model_group}: {repo_id}", flush=True)
        if spec["kind"] == "file":
            path = hf_hub_download(
                repo_id=repo_id,
                filename=spec["filename"],
                local_dir=str(MODELS_DIR),
                cache_dir=str(HF_CACHE_DIR),
            )
        elif spec["kind"] == "snapshot_cache":
            # Default HF cache (HF_HOME/hub) — the same place the backend
            # server loads from, so the pre-fetch is actually used.
            path = snapshot_download(
                repo_id=repo_id,
                allow_patterns=spec.get("allow_patterns"),
                ignore_patterns=spec.get("ignore_patterns"),
            )
        else:
            path = snapshot_download(
                repo_id=repo_id,
                cache_dir=str(HF_CACHE_DIR),
                local_dir=str(HF_CACHE_DIR / "snapshots" / repo_id.replace("/", "__")),
                local_dir_use_symlinks=False,
            )
        downloaded_paths.append(str(path))
    write_marker(model_group, downloaded_paths)
    print(f"Completed {model_group}", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description="Download OmniGen model assets.")
    parser.add_argument(
        "models",
        nargs="+",
        choices=sorted(MODEL_GROUPS.keys()),
        help="Model groups to download.",
    )
    args = parser.parse_args()

    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    HF_CACHE_DIR.mkdir(parents=True, exist_ok=True)

    for model_group in args.models:
        download_group(model_group)


if __name__ == "__main__":
    main()
