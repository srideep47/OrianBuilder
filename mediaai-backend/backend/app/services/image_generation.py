import os
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
import json
from pathlib import Path
from uuid import uuid4

from app.schemas import ImageGenerationRequest

BACKEND_DIR = Path(__file__).resolve().parents[2]
OUTPUTS_DIR = Path(os.getenv("OMNIGEN_OUTPUTS_DIR", str(BACKEND_DIR / "outputs")))


class ImageGenerationError(RuntimeError):
    """Base exception for image-generation failures."""


class ImageGenerationDependencyError(ImageGenerationError):
    """Raised when optional image-generation dependencies are missing."""


class ImageGenerationDirectMLError(ImageGenerationError):
    """Raised when DirectML is unavailable or misconfigured."""


@dataclass(frozen=True)
class GeneratedImage:
    image_path: str
    image_url: str
    model: str
    provider: str
    warning: str | None = None


@dataclass(frozen=True)
class ImageGenerationSettings:
    model_id: str
    provider: str
    allow_cpu_fallback: bool
    export_to_onnx: bool
    cache_dir: str | None

    @classmethod
    def from_environment(cls) -> "ImageGenerationSettings":
        return cls(
            model_id=os.getenv(
                "OMNIGEN_IMAGE_MODEL_ID",
                "nmkd/stable-diffusion-1.5-onnx-fp16",
            ),
            provider="CPUExecutionProvider",
            allow_cpu_fallback=_env_flag("OMNIGEN_IMAGE_ALLOW_CPU_FALLBACK", default=True),
            export_to_onnx=_env_flag("OMNIGEN_IMAGE_EXPORT_ONNX", default=False),
            cache_dir=os.getenv("OMNIGEN_HF_CACHE_DIR"),
        )


def _env_flag(name: str, *, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


class DirectMLImageGenerationService:
    def __init__(self, settings: ImageGenerationSettings | None = None) -> None:
        self.settings = settings or ImageGenerationSettings.from_environment()
        self._pipeline = None
        self._pipeline_backend: str | None = None
        self._cpu_fallback_pipeline = None
        self._cpu_fallback_backend: str | None = None
        self._pipeline_lock = threading.Lock()

    def generate(self, request: ImageGenerationRequest) -> GeneratedImage:
        OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)

        with self._pipeline_lock:
            pipeline, backend = self._load_pipeline(self.settings.provider)
            try:
                result = pipeline(**self._pipeline_kwargs(request, backend))
            except Exception as exc:
                raise ImageGenerationError(f"Image generation failed: {exc}") from exc

            image = result.images[0]
            provider = self.settings.provider
            warning = None

            if self._is_flat_image(image):
                if not self.settings.allow_cpu_fallback:
                    raise ImageGenerationError(
                        "DirectML returned a flat image. This usually means the selected "
                        "ONNX model is not compatible with this DirectML runtime."
                    )

                cpu_pipeline, cpu_backend = self._load_pipeline("CPUExecutionProvider")
                try:
                    result = cpu_pipeline(**self._pipeline_kwargs(request, cpu_backend))
                except Exception as exc:
                    raise ImageGenerationError(
                        "DirectML returned a flat image, and CPU fallback failed: "
                        f"{type(exc).__name__}: {exc}"
                    ) from exc

                image = result.images[0]
                provider = "CPUExecutionProvider"
                warning = (
                    "DirectML returned a flat image for this ONNX model, so the request "
                    "was retried with CPUExecutionProvider."
                )

        filename = self._output_filename()
        output_path = OUTPUTS_DIR / filename
        image.save(output_path)

        return GeneratedImage(
            image_path=str(output_path.resolve()),
            image_url=f"/outputs/{filename}",
            model=self.settings.model_id,
            provider=provider,
            warning=warning,
        )

    def _load_pipeline(self, provider: str):
        if provider == self.settings.provider and self._pipeline is not None:
            return self._pipeline, self._pipeline_backend
        if provider == "CPUExecutionProvider" and self._cpu_fallback_pipeline is not None:
            return self._cpu_fallback_pipeline, self._cpu_fallback_backend

        try:
            import onnxruntime as ort
            from diffusers import OnnxStableDiffusionPipeline
            from huggingface_hub import hf_hub_download
            from optimum.onnxruntime import ORTStableDiffusionPipeline
        except ImportError as exc:
            raise ImageGenerationDependencyError(
                "Image generation dependencies are not installed. Run "
                "`pip install -r requirements.txt` inside the backend virtual environment."
            ) from exc

        available_providers = ort.get_available_providers()
        if self.settings.provider not in available_providers:
            raise ImageGenerationDirectMLError(
                f"{self.settings.provider} is not available. Installed ONNX Runtime "
                f"providers: {available_providers}. Make sure onnxruntime-directml is "
                "installed and no CPU-only onnxruntime package is shadowing it."
            )

        backend = self._pipeline_backend_name(hf_hub_download)
        session_options = ort.SessionOptions()
        session_options.enable_mem_pattern = False
        session_options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        session_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_DISABLE_ALL

        try:
            if backend == "diffusers_onnx":
                pipeline = OnnxStableDiffusionPipeline.from_pretrained(
                    self.settings.model_id,
                    provider=provider,
                    provider_options={},
                    sess_options=session_options,
                    cache_dir=self.settings.cache_dir,
                    safety_checker=None,
                )
            else:
                pipeline = ORTStableDiffusionPipeline.from_pretrained(
                    self.settings.model_id,
                    export=self.settings.export_to_onnx,
                    providers=[provider],
                    session_options=session_options,
                    cache_dir=self.settings.cache_dir,
                    use_io_binding=False,
                    safety_checker=None,
                )
        except Exception as exc:
            raise ImageGenerationError(
                f"Failed to load ONNX image model '{self.settings.model_id}' with "
                f"{self.settings.provider}: {type(exc).__name__}: {exc}. If "
                "OMNIGEN_IMAGE_EXPORT_ONNX=true, use Python 3.12; Optimum ONNX export "
                "currently fails on this Python 3.14 environment."
            ) from exc

        if hasattr(pipeline, "set_progress_bar_config"):
            pipeline.set_progress_bar_config(disable=True)

        if provider == self.settings.provider:
            self._pipeline = pipeline
            self._pipeline_backend = backend
        elif provider == "CPUExecutionProvider":
            self._cpu_fallback_pipeline = pipeline
            self._cpu_fallback_backend = backend

        return pipeline, backend

    def _pipeline_backend_name(self, hf_hub_download) -> str:
        try:
            model_index_path = hf_hub_download(
                self.settings.model_id,
                "model_index.json",
                cache_dir=self.settings.cache_dir,
            )
            with open(model_index_path, encoding="utf-8") as model_index_file:
                class_name = json.load(model_index_file).get("_class_name")
        except Exception:
            class_name = None

        if class_name == "OnnxStableDiffusionPipeline":
            return "diffusers_onnx"
        return "optimum_ort"

    def _pipeline_kwargs(self, request: ImageGenerationRequest, backend: str) -> dict:
        kwargs = {
            "prompt": request.prompt,
            "height": request.height,
            "width": request.width,
            "num_inference_steps": request.num_inference_steps,
            "guidance_scale": request.guidance_scale,
            "num_images_per_prompt": 1,
        }
        if request.negative_prompt:
            kwargs["negative_prompt"] = request.negative_prompt
        if request.seed is not None:
            if backend == "diffusers_onnx":
                try:
                    import numpy as np
                except ImportError as exc:
                    raise ImageGenerationDependencyError(
                        "The `numpy` package is required for seeded ONNX generation."
                    ) from exc
                kwargs["generator"] = np.random.RandomState(request.seed)
            else:
                try:
                    import torch
                except ImportError as exc:
                    raise ImageGenerationDependencyError(
                        "The `torch` package is required for seeded generation."
                    ) from exc
                kwargs["generator"] = torch.Generator(device="cpu").manual_seed(request.seed)
        return kwargs

    @staticmethod
    def _is_flat_image(image) -> bool:
        from PIL import ImageStat

        stat = ImageStat.Stat(image.convert("RGB"))
        return max(stat.stddev) < 1.0

    @staticmethod
    def _output_filename() -> str:
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        return f"image-{timestamp}-{uuid4().hex[:8]}.png"


image_generation_service = DirectMLImageGenerationService()
