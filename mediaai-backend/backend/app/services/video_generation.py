import os
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from app.schemas import VideoGenerationRequest

BACKEND_DIR = Path(__file__).resolve().parents[2]
OUTPUTS_DIR = Path(os.getenv("OMNIGEN_OUTPUTS_DIR", str(BACKEND_DIR / "outputs")))
VIDEO_MODEL_ID = os.getenv("OMNIGEN_VIDEO_MODEL_ID", "damo-vilab/text-to-video-ms-1.7b")
CPU_VIDEO_NUM_FRAMES = 8
CPU_VIDEO_NUM_INFERENCE_STEPS = 10
CPU_VIDEO_HEIGHT = 256
CPU_VIDEO_WIDTH = 256


class VideoGenerationError(RuntimeError):
    """Base exception for video-generation failures."""


class VideoGenerationDependencyError(VideoGenerationError):
    """Raised when video-generation dependencies are missing."""


@dataclass(frozen=True)
class GeneratedVideo:
    video_path: str
    video_url: str
    model: str
    warning: str | None = None


class TextToVideoGenerationService:
    def __init__(self, model_id: str = VIDEO_MODEL_ID) -> None:
        self.model_id = model_id
        self._pipeline = None
        self._lock = threading.Lock()

    def generate(self, request: VideoGenerationRequest) -> GeneratedVideo:
        OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)

        try:
            with self._lock:
                pipe = self._load_pipeline()
                result = pipe(
                    request.prompt,
                    num_frames=CPU_VIDEO_NUM_FRAMES,
                    num_inference_steps=CPU_VIDEO_NUM_INFERENCE_STEPS,
                    height=CPU_VIDEO_HEIGHT,
                    width=CPU_VIDEO_WIDTH,
                )
        except MemoryError as exc:
            raise VideoGenerationError(
                "Text-to-video generation ran out of memory on CPU."
            ) from exc
        except RuntimeError as exc:
            if "out of memory" in str(exc).lower():
                raise VideoGenerationError(
                    "Text-to-video generation ran out of memory on CPU."
                ) from exc
            raise VideoGenerationError(f"Text-to-video generation failed: {exc}") from exc
        except Exception as exc:
            raise VideoGenerationError(f"Text-to-video generation failed: {exc}") from exc

        filename = self._output_filename()
        output_path = OUTPUTS_DIR / filename

        try:
            from diffusers.utils import export_to_video
        except ImportError as exc:
            raise VideoGenerationDependencyError(
                "The `diffusers` package is required to export generated videos. "
                "Run `pip install -r requirements.txt`."
            ) from exc

        try:
            frames = getattr(result, "frames", None)
            if frames is None or len(frames) == 0:
                raise VideoGenerationError("Text-to-video generation returned no frames.")
            export_to_video(frames[0], str(output_path), fps=4)
        except VideoGenerationError:
            raise
        except Exception as exc:
            raise VideoGenerationError(f"Video export failed: {exc}") from exc

        return GeneratedVideo(
            video_path=str(output_path.resolve()),
            video_url=f"/outputs/{filename}",
            model=self.model_id,
            warning=(
                "Video generation ran on CPU with fixed 8 frames at 256x256 and 10 steps."
            ),
        )

    def _load_pipeline(self):
        if self._pipeline is not None:
            return self._pipeline

        try:
            import torch
            from diffusers import DiffusionPipeline
        except ImportError as exc:
            raise VideoGenerationDependencyError(
                "Video generation dependencies are not installed. Run "
                "`pip install -r requirements.txt` inside the backend virtual environment."
            ) from exc

        try:
            self._pipeline = DiffusionPipeline.from_pretrained(
                self.model_id,
                torch_dtype=torch.float32,
            )
            self._pipeline.to("cpu")
        except MemoryError as exc:
            raise VideoGenerationError(
                "Text-to-video model loading ran out of memory on CPU."
            ) from exc
        except RuntimeError as exc:
            if "out of memory" in str(exc).lower():
                raise VideoGenerationError(
                    "Text-to-video model loading ran out of memory on CPU."
                ) from exc
            raise

        return self._pipeline

    @staticmethod
    def _output_filename() -> str:
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        return f"video-{timestamp}-{uuid4().hex[:8]}.mp4"


video_generation_service = TextToVideoGenerationService()
