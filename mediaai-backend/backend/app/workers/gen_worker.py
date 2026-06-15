"""Isolated generation worker — runs ONE generation job, then exits.

Invoked as a subprocess by app.jobs:

    python -m app.workers.gen_worker <spec_json_path>

`spec_json_path` points at a JSON file: {"kind", "params", "result_path"}.

Communication with the parent is over stdout, one directive per line:

    @@PROGRESS@@{"stage": "...", "progress": 0.42}   periodic progress
    @@DONE@@                                          success; result written to result_path
    @@ERROR@@<message>                                clean Python-level failure

A native crash (segfault / OOM kill) simply terminates this process with a
non-zero exit code and no @@DONE@@ — the parent treats that as a hard failure
and can retry with a safer fallback. Because the process exits after one job,
all VRAM/RAM is reclaimed by the OS regardless of how generation ended, which
also gives us true single-residency for free.
"""

from __future__ import annotations

import json
import sys
import traceback
from typing import Optional


def _emit(line: str) -> None:
    """Write a directive line and flush immediately so the parent sees progress
    in real time (stdout is a pipe; without the flush it would buffer)."""
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def _make_progress_cb():
    def report(stage: str, progress: Optional[float] = None) -> None:
        payload = {"stage": stage, "progress": progress}
        _emit("@@PROGRESS@@" + json.dumps(payload))

    return report


def _run_video(params: dict, report) -> dict:
    from app.models import video as video_model

    # An optional load-strategy hint lets the parent retry a crashed tier with a
    # safer one (e.g. demote LTX-2.3 → LTX-Video). Absent = normal selection.
    # image_path (a keyframe) makes i2v-only tiers (Wan 2.2 14B) eligible.
    forced_tier = params.get("tier")
    image_path = params.get("image_path")
    report("resolving model tier", None)
    tier = video_model.pick_best_video_tier(forced_tier, has_image=bool(image_path))
    video_model.ensure_tier_downloaded(tier, report)
    result = video_model.generate_video(
        prompt=params["prompt"],
        forced_tier_id=tier["id"],
        num_frames=params.get("num_frames"),
        fps=params.get("fps"),
        width=params.get("width"),
        height=params.get("height"),
        steps=params.get("steps"),
        duration_s=params.get("duration_s"),
        aspect_ratio=params.get("aspect_ratio"),
        image_path=image_path,
        seed=params.get("seed"),
        negative_prompt=params.get("negative_prompt"),
        progress_cb=report,
    )
    return {
        "video_url": result["video_url"],
        "tier": result["tier"],
        "model": result["model"],
        "has_audio": bool(result.get("has_audio")),
    }


_RUNNERS = {
    "video": _run_video,
}


def _register_selftest_runners() -> None:
    """Lightweight runners for exercising the isolation harness without a GPU.
    Only active when GEN_WORKER_SELFTEST=1 so production behaviour is unchanged."""

    def _ok(params, report):
        report("step 1", 0.5)
        report("step 2", 1.0)
        return {"video_url": "/outputs/selftest.mp4", "tier": "selftest",
                "model": "selftest", "has_audio": False}

    def _crash(params, report):
        report("about to crash", 0.1)
        # Abrupt exit bypassing all Python cleanup — mimics a native segfault/
        # OOM that emits no @@DONE@@ (139 == 128+SIGSEGV).
        _os._exit(139)

    def _err(params, report):
        raise ValueError("clean python error from worker")

    _RUNNERS.update({"selftest_ok": _ok, "selftest_crash": _crash, "selftest_err": _err})


import os as _os

if _os.environ.get("GEN_WORKER_SELFTEST") == "1":
    _register_selftest_runners()


def _run_one(spec_path: str) -> None:
    """Runs ONE spec file, emitting exactly one terminal directive
    (@@DONE@@ or @@ERROR@@). Never raises — the serve loop must survive
    clean Python failures so the model cache stays warm."""
    try:
        with open(spec_path, "r", encoding="utf-8") as f:
            spec = json.load(f)
    except Exception as exc:  # noqa: BLE001
        _emit(f"@@ERROR@@gen_worker: cannot read spec: {exc}")
        return

    kind = spec.get("kind")
    params = spec.get("params") or {}
    result_path = spec.get("result_path")
    runner = _RUNNERS.get(kind)
    if runner is None:
        _emit(f"@@ERROR@@gen_worker: unknown kind {kind!r}")
        return

    report = _make_progress_cb()
    try:
        result = runner(params, report)
    except Exception as exc:  # noqa: BLE001 — surface to parent
        traceback.print_exc(file=sys.stderr)
        _emit("@@ERROR@@" + (str(exc) or exc.__class__.__name__))
        return

    try:
        with open(result_path, "w", encoding="utf-8") as f:
            json.dump(result, f)
    except Exception as exc:  # noqa: BLE001
        _emit(f"@@ERROR@@gen_worker: cannot write result: {exc}")
        return

    _emit("@@DONE@@")


def _release_gpu_scratch() -> None:
    """Between serve-mode jobs: return the CUDA allocator's cached scratch
    (activations, KV blocks) to the driver so an idle-but-alive worker holds
    minimal VRAM. The model weights stay cached (mostly offloaded to RAM) —
    that's the whole point of staying alive."""
    try:
        import torch  # type: ignore

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:  # noqa: BLE001
        pass


def main(argv: list[str]) -> int:
    if len(argv) >= 2 and argv[1] == "--serve":
        # Persistent mode: one spec path per stdin line, one terminal
        # directive per job. Module-level model caches (app.models.video
        # _pipeline etc.) survive between jobs, so a storyboard's N clips pay
        # the multi-minute model load ONCE. The parent owns the lifecycle —
        # it kills us on cancel/idle/shutdown; stdin EOF means exit.
        for line in sys.stdin:
            spec_path = line.strip()
            if not spec_path:
                continue
            _run_one(spec_path)
            _release_gpu_scratch()
        return 0

    if len(argv) < 2:
        _emit("@@ERROR@@gen_worker: missing spec file argument")
        return 2
    _run_one(argv[1])
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
