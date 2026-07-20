import os
import threading
from dataclasses import dataclass
from pathlib import Path

from app.schemas import TextGenerationRequest

BACKEND_DIR = Path(__file__).resolve().parents[2]
MODELS_DIR = Path(os.getenv("OMNIGEN_MODELS_DIR", str(BACKEND_DIR / "models")))


class TextGenerationError(RuntimeError):
    """Base exception for text-generation failures."""


class TextGenerationDependencyError(TextGenerationError):
    """Raised when llama-cpp-python or Hugging Face Hub is missing."""


@dataclass(frozen=True)
class GeneratedText:
    text: str
    model: str
    backend: str
    warning: str | None = None


@dataclass(frozen=True)
class TextGenerationSettings:
    model_path: str | None
    model_repo_id: str
    model_filename: str
    n_ctx: int
    n_gpu_layers: int
    n_threads: int | None

    @classmethod
    def from_environment(cls) -> "TextGenerationSettings":
        return cls(
            model_path=os.getenv("OMNIGEN_TEXT_MODEL_PATH"),
            model_repo_id=os.getenv(
                "OMNIGEN_TEXT_MODEL_REPO",
                "microsoft/Phi-3-mini-4k-instruct-gguf",
            ),
            model_filename=os.getenv(
                "OMNIGEN_TEXT_MODEL_FILE",
                "Phi-3-mini-4k-instruct-q4.gguf",
            ),
            n_ctx=int(os.getenv("OMNIGEN_TEXT_N_CTX", "4096")),
            n_gpu_layers=int(os.getenv("OMNIGEN_TEXT_N_GPU_LAYERS", "-1")),
            n_threads=_optional_int(os.getenv("OMNIGEN_TEXT_N_THREADS")),
        )


def _optional_int(value: str | None) -> int | None:
    if value is None or value.strip() == "":
        return None
    return int(value)


class LlamaCppTextGenerationService:
    def __init__(self, settings: TextGenerationSettings | None = None) -> None:
        self.settings = settings or TextGenerationSettings.from_environment()
        self._llm = None
        self._lock = threading.Lock()
        self._model_path: str | None = None
        self._backend = "llama.cpp"
        self._warning: str | None = None

    def generate(self, request: TextGenerationRequest) -> GeneratedText:
        with self._lock:
            llm = self._load_model()
            output = llm.create_chat_completion(
                messages=[
                    {
                        "role": "system",
                        "content": "You are OmniGen Local, a concise local desktop AI assistant.",
                    },
                    {"role": "user", "content": request.prompt},
                ],
                max_tokens=request.max_tokens,
                temperature=request.temperature,
                top_p=request.top_p,
            )

        text = output["choices"][0]["message"]["content"].strip()
        return GeneratedText(
            text=text,
            model=Path(self._model_path or self.settings.model_filename).name,
            backend=self._backend,
            warning=self._warning,
        )

    def _load_model(self):
        if self._llm is not None:
            return self._llm

        try:
            from huggingface_hub import hf_hub_download
            from llama_cpp import Llama, llama_supports_gpu_offload
        except ImportError as exc:
            raise TextGenerationDependencyError(
                "Text generation dependencies are not installed. Run "
                "`pip install -r requirements.txt` inside the backend virtual environment. "
                "For Vulkan acceleration on AMD, reinstall llama-cpp-python with "
                "`$env:CMAKE_ARGS='-DGGML_VULKAN=ON'` before pip install."
            ) from exc

        model_path = self.settings.model_path
        if model_path is None:
            MODELS_DIR.mkdir(parents=True, exist_ok=True)
            model_path = hf_hub_download(
                repo_id=self.settings.model_repo_id,
                filename=self.settings.model_filename,
                local_dir=str(MODELS_DIR),
            )

        if not Path(model_path).exists():
            raise TextGenerationError(f"Text model file does not exist: {model_path}")

        supports_gpu = bool(llama_supports_gpu_offload())
        n_gpu_layers = self.settings.n_gpu_layers if supports_gpu else 0
        self._backend = "llama.cpp Vulkan/GPU" if supports_gpu and n_gpu_layers != 0 else "llama.cpp CPU"
        self._warning = None if supports_gpu else "llama.cpp GPU offload is unavailable; using CPU fallback."

        kwargs = {
            "model_path": model_path,
            "n_ctx": self.settings.n_ctx,
            "n_gpu_layers": n_gpu_layers,
            "verbose": False,
        }
        if self.settings.n_threads is not None:
            kwargs["n_threads"] = self.settings.n_threads

        try:
            self._llm = Llama(**kwargs)
        except Exception as exc:
            if n_gpu_layers == 0:
                raise TextGenerationError(f"Failed to load text model: {exc}") from exc

            kwargs["n_gpu_layers"] = 0
            self._backend = "llama.cpp CPU"
            self._warning = f"GPU/Vulkan model load failed, retried on CPU: {exc}"
            self._llm = Llama(**kwargs)

        self._model_path = model_path
        return self._llm


text_generation_service = LlamaCppTextGenerationService()


def unload() -> None:
    """Release the legacy in-process llama.cpp model, if it was used."""
    import gc

    with text_generation_service._lock:
        llm = text_generation_service._llm
        text_generation_service._llm = None
        text_generation_service._model_path = None
    close = getattr(llm, "close", None)
    if callable(close):
        close()
    gc.collect()

