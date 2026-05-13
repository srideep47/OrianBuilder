from pathlib import Path

from fastapi import APIRouter, HTTPException
from starlette.concurrency import run_in_threadpool

from app.schemas import (
    AudioGenerationRequest,
    AudioGenerationResponse,
    ImageGenerationRequest,
    ImageGenerationResponse,
    TextGenerationRequest,
    TextGenerationResponse,
    VideoGenerationRequest,
    VideoGenerationResponse,
)
from app.services.image_generation import (
    ImageGenerationDependencyError,
    ImageGenerationDirectMLError,
    ImageGenerationError,
    image_generation_service,
)
from app.services.text_generation import (
    TextGenerationDependencyError,
    TextGenerationError,
    text_generation_service,
)
from app.services.audio_generation import (
    AudioGenerationDependencyError,
    AudioGenerationError,
    audio_generation_service,
)
from app.services.video_generation import (
    VideoGenerationDependencyError,
    VideoGenerationError,
    video_generation_service,
)

router = APIRouter(prefix="/generate", tags=["generation"])

BACKEND_DIR = Path(__file__).resolve().parents[2]
STATIC_DIR = BACKEND_DIR / "static"
DIRECTML_SAFE_IMAGE_WIDTH = 512
DIRECTML_SAFE_IMAGE_HEIGHT = 512
DIRECTML_SAFE_IMAGE_STEPS = 15
CPU_SAFE_VIDEO_FRAMES = 8
CPU_SAFE_VIDEO_STEPS = 10
CPU_SAFE_VIDEO_WIDTH = 256
CPU_SAFE_VIDEO_HEIGHT = 256


def _asset_path(filename: str) -> str:
    return str((STATIC_DIR / filename).resolve())


@router.post("/text", response_model=TextGenerationResponse)
async def generate_text(request: TextGenerationRequest) -> TextGenerationResponse:
    try:
        generated = await run_in_threadpool(text_generation_service.generate, request)
    except TextGenerationDependencyError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except TextGenerationError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return TextGenerationResponse(
        prompt=request.prompt,
        text=generated.text,
        model=generated.model,
        backend=generated.backend,
        warning=generated.warning,
    )


@router.post("/image", response_model=ImageGenerationResponse)
async def generate_image(request: ImageGenerationRequest) -> ImageGenerationResponse:
    constrained_request = request.model_copy(
        update={
            "width": DIRECTML_SAFE_IMAGE_WIDTH,
            "height": DIRECTML_SAFE_IMAGE_HEIGHT,
            "num_inference_steps": DIRECTML_SAFE_IMAGE_STEPS,
        }
    )
    try:
        generated = await run_in_threadpool(image_generation_service.generate, constrained_request)
    except ImageGenerationDependencyError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ImageGenerationDirectMLError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ImageGenerationError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return ImageGenerationResponse(
        prompt=request.prompt,
        image_path=generated.image_path,
        image_url=generated.image_url,
        model=generated.model,
        provider=generated.provider,
        warning=generated.warning,
    )


@router.post("/audio", response_model=AudioGenerationResponse)
async def generate_audio(request: AudioGenerationRequest) -> AudioGenerationResponse:
    try:
        generated = await run_in_threadpool(audio_generation_service.generate, request)
    except AudioGenerationDependencyError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except AudioGenerationError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return AudioGenerationResponse(
        prompt=request.prompt,
        audio_path=generated.audio_path,
        audio_url=generated.audio_url,
        model=generated.model,
        sample_rate=generated.sample_rate,
        warning=generated.warning,
    )


@router.post("/video", response_model=VideoGenerationResponse)
async def generate_video(request: VideoGenerationRequest) -> VideoGenerationResponse:
    constrained_request = request.model_copy(
        update={
            "num_frames": CPU_SAFE_VIDEO_FRAMES,
            "num_inference_steps": CPU_SAFE_VIDEO_STEPS,
            "width": CPU_SAFE_VIDEO_WIDTH,
            "height": CPU_SAFE_VIDEO_HEIGHT,
        }
    )
    try:
        generated = await run_in_threadpool(video_generation_service.generate, constrained_request)
    except VideoGenerationDependencyError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except VideoGenerationError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return VideoGenerationResponse(
        prompt=request.prompt,
        video_path=generated.video_path,
        video_url=generated.video_url,
        model=generated.model,
        warning=generated.warning,
    )
