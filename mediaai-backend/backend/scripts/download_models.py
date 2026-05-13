import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path

from huggingface_hub import hf_hub_download, snapshot_download


BACKEND_DIR = Path(__file__).resolve().parents[1]
MODELS_DIR = Path(os.getenv("OMNIGEN_MODELS_DIR", str(BACKEND_DIR / "models")))
HF_CACHE_DIR = Path(os.getenv("OMNIGEN_HF_CACHE_DIR", str(MODELS_DIR / "huggingface")))
MARKER_DIR = MODELS_DIR / ".model-markers"

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
    "video": [
        {
            "kind": "snapshot",
            "repo_id": os.getenv(
                "OMNIGEN_VIDEO_MODEL_ID",
                "damo-vilab/text-to-video-ms-1.7b",
            ),
        },
    ],
}


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
    specs = MODEL_GROUPS[model_group]
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
