import io
import os
import threading
import wave
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from app.hardware import get_torch_device
from app.schemas import AudioGenerationRequest

BACKEND_DIR = Path(__file__).resolve().parents[2]
OUTPUTS_DIR = Path(os.getenv("OMNIGEN_OUTPUTS_DIR", str(BACKEND_DIR / "outputs")))


class AudioGenerationError(RuntimeError):
    """Base exception for audio-generation failures."""


class AudioGenerationDependencyError(AudioGenerationError):
    """Raised when SpeechT5 dependencies are missing."""


@dataclass(frozen=True)
class GeneratedAudio:
    audio_path: str
    audio_url: str
    model: str
    sample_rate: int
    warning: str | None = None


class SpeechT5AudioGenerationService:
    def __init__(
        self,
        model_id: str = "microsoft/speecht5_tts",
        vocoder_id: str = "microsoft/speecht5_hifigan",
        fallback_model_id: str = "facebook/mms-tts-eng",
    ) -> None:
        self.model_id = model_id
        self.vocoder_id = vocoder_id
        self.fallback_model_id = fallback_model_id
        self._processor = None
        self._model = None
        self._vocoder = None
        self._speaker_embeddings = None
        self._vits_tokenizer = None
        self._vits_model = None
        self._lock = threading.Lock()

    def generate(self, request: AudioGenerationRequest) -> GeneratedAudio:
        OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)

        try:
            with self._lock:
                speech, sample_rate, model_used, warning = self._generate_speech(request.prompt)
        except MemoryError as exc:
            raise AudioGenerationError(
                "Audio generation ran out of memory on CPU."
            ) from exc
        except RuntimeError as exc:
            if "out of memory" in str(exc).lower():
                raise AudioGenerationError(
                    "Audio generation ran out of memory on CPU."
                ) from exc
            raise AudioGenerationError(f"Audio generation failed: {exc}") from exc
        except Exception as exc:
            raise AudioGenerationError(f"Audio generation failed: {exc}") from exc

        try:
            audio_array = speech.cpu().numpy()
            filename = self._output_filename()
            output_path = OUTPUTS_DIR / filename

            try:
                import soundfile as sf
            except ImportError as exc:
                raise AudioGenerationDependencyError(
                    "The `soundfile` package is required to save WAV files. "
                    "Run `pip install -r requirements.txt`."
                ) from exc

            sf.write(output_path, audio_array, sample_rate)
        except AudioGenerationDependencyError:
            raise
        except Exception as exc:
            raise AudioGenerationError(f"Audio post-processing failed: {exc}") from exc

        return GeneratedAudio(
            audio_path=str(output_path.resolve()),
            audio_url=f"/outputs/{filename}",
            model=model_used,
            sample_rate=sample_rate,
            warning=warning,
        )

    def _generate_speech(self, prompt: str):
        try:
            return self._generate_with_speecht5(prompt)
        except AudioGenerationDependencyError as exc:
            fallback_warning = (
                f"SpeechT5 is unavailable ({exc}). "
                f"Using {self.fallback_model_id} fallback on CPU."
            )
            return self._generate_with_vits(prompt, fallback_warning)

    def _generate_with_speecht5(self, prompt: str):
        processor, model, vocoder, speaker_embeddings, torch = self._load_model()
        device = get_torch_device()
        inputs = processor(text=prompt, return_tensors="pt")

        with torch.inference_mode():
            speech = model.generate_speech(
                inputs["input_ids"].to(device),
                speaker_embeddings,
                vocoder=vocoder,
            )

        sample_rate = self._resolve_sample_rate(model, processor)
        return speech, sample_rate, self.model_id, None

    def _generate_with_vits(self, prompt: str, warning: str):
        try:
            import torch
            from transformers import AutoTokenizer, VitsModel
        except ImportError as exc:
            raise AudioGenerationDependencyError(
                "Audio generation dependencies are not installed. Run "
                "`pip install -r requirements.txt` inside the backend virtual environment."
            ) from exc

        if self._vits_tokenizer is None or self._vits_model is None:
            device = get_torch_device()
            self._vits_tokenizer = AutoTokenizer.from_pretrained(self.fallback_model_id)
            self._vits_model = VitsModel.from_pretrained(self.fallback_model_id).to(device)
            self._vits_model.eval()

        try:
            device = get_torch_device()
            inputs = self._vits_tokenizer(text=prompt, return_tensors="pt")
            with torch.inference_mode():
                output = self._vits_model(**{k: v.to(device) for k, v in inputs.items()})
                speech = output.waveform[0]
        except RuntimeError as exc:
            if "out of memory" in str(exc).lower():
                raise AudioGenerationError("Fallback VITS audio generation ran out of memory on CPU.") from exc
            raise AudioGenerationError(f"Fallback VITS audio generation failed: {exc}") from exc
        except Exception as exc:
            raise AudioGenerationError(f"Fallback VITS audio generation failed: {exc}") from exc

        sample_rate = int(getattr(self._vits_model.config, "sampling_rate", 16000))
        return speech, sample_rate, self.fallback_model_id, warning

    def _load_model(self):
        if (
            self._processor is not None
            and self._model is not None
            and self._vocoder is not None
            and self._speaker_embeddings is not None
        ):
            import torch

            return self._processor, self._model, self._vocoder, self._speaker_embeddings, torch

        try:
            import torch
            from transformers import SpeechT5ForTextToSpeech, SpeechT5HifiGan, SpeechT5Processor
        except ImportError as exc:
            raise AudioGenerationDependencyError(
                "Audio generation dependencies are not installed. Run "
                "`pip install -r requirements.txt` inside the backend virtual environment."
            ) from exc

        try:
            device = get_torch_device()
            self._processor = SpeechT5Processor.from_pretrained(self.model_id)
            self._model = SpeechT5ForTextToSpeech.from_pretrained(self.model_id).to(device)
            self._vocoder = SpeechT5HifiGan.from_pretrained(self.vocoder_id).to(device)
            self._speaker_embeddings = self._load_speaker_embeddings(torch).to(device)
            self._model.eval()
            self._vocoder.eval()
        except MemoryError as exc:
            raise AudioGenerationError(
                "SpeechT5 model loading ran out of memory on CPU."
            ) from exc
        except RuntimeError as exc:
            if "out of memory" in str(exc).lower():
                raise AudioGenerationError(
                    "SpeechT5 model loading ran out of memory on CPU."
                )
            if "sentencepiece" in str(exc).lower():
                raise AudioGenerationDependencyError(
                    "SpeechT5 requires sentencepiece, which is unavailable in this environment."
                ) from exc
            raise AudioGenerationError(f"SpeechT5 model loading failed: {exc}") from exc
        except Exception as exc:
            if "sentencepiece" in str(exc).lower():
                raise AudioGenerationDependencyError(
                    "SpeechT5 requires sentencepiece, which is unavailable in this environment."
                ) from exc
            raise AudioGenerationError(f"SpeechT5 model loading failed: {exc}") from exc

        return self._processor, self._model, self._vocoder, self._speaker_embeddings, torch

    @staticmethod
    def _load_speaker_embeddings(torch):
        # Use a deterministic local embedding to avoid runtime dataset loading
        # failures in constrained/unsupported Python environments.
        generator = torch.Generator(device="cpu").manual_seed(0)
        return torch.randn((1, 512), generator=generator, dtype=torch.float32)

    @staticmethod
    def _output_filename() -> str:
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        return f"audio-{timestamp}-{uuid4().hex[:8]}.wav"

    @staticmethod
    def _resolve_sample_rate(model, processor) -> int:
        config_rate = getattr(getattr(model, "config", None), "sampling_rate", None)
        if config_rate:
            return int(config_rate)

        extractor_rate = getattr(getattr(processor, "feature_extractor", None), "sampling_rate", None)
        if extractor_rate:
            return int(extractor_rate)

        return 16000


audio_generation_service = SpeechT5AudioGenerationService()


class TieredAudioGenerationService:
    """Delegates to the tiered TTS model system so GPU-capable tiers are used."""

    def generate(self, request: AudioGenerationRequest) -> GeneratedAudio:
        # Lazy import avoids circular dependency (models/tts.py imports this module
        # for its SpeechT5 fallback path).
        from app.models import tts as tts_model  # noqa: PLC0415

        OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)
        try:
            audio_bytes = tts_model.generate_speech(request.prompt)
        except Exception as exc:
            raise AudioGenerationError(f"Audio generation failed: {exc}") from exc

        sample_rate = 22050
        try:
            with wave.open(io.BytesIO(audio_bytes)) as wf:
                sample_rate = wf.getframerate()
        except Exception:
            pass

        filename = self._output_filename()
        output_path = OUTPUTS_DIR / filename
        output_path.write_bytes(audio_bytes)

        tier = tts_model.pick_tts_tier()
        return GeneratedAudio(
            audio_path=str(output_path.resolve()),
            audio_url=f"/outputs/{filename}",
            model=tier["id"],
            sample_rate=sample_rate,
        )

    @staticmethod
    def _output_filename() -> str:
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        return f"audio-{timestamp}-{uuid4().hex[:8]}.wav"


tiered_audio_generation_service = TieredAudioGenerationService()


def unload() -> None:
    """Release SpeechT5/VITS fallback caches used by the legacy TTS path."""
    import gc

    with audio_generation_service._lock:
        audio_generation_service._processor = None
        audio_generation_service._model = None
        audio_generation_service._vocoder = None
        audio_generation_service._speaker_embeddings = None
        audio_generation_service._vits_tokenizer = None
        audio_generation_service._vits_model = None
    gc.collect()
