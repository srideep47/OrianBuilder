import hashlib
import os
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from app.routes.generation import router as generation_router
from app import hardware
from app.models import image as image_model
from app.models import tts as tts_model
from app.models import stt as stt_model

BACKEND_DIR = Path(__file__).resolve().parents[1]
STATIC_DIR = BACKEND_DIR / "static"
OUTPUTS_DIR = Path(os.getenv("OMNIGEN_OUTPUTS_DIR", str(BACKEND_DIR / "outputs")))

STATIC_DIR.mkdir(parents=True, exist_ok=True)
OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(
    title="OmniGen Local Backend",
    description="Local multimodal AI backend with hardware-aware generation.",
    version="0.2.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["null"],
    allow_origin_regex=r"http://(localhost|127\.0\.0\.1)(:\d+)?",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
app.mount("/outputs", StaticFiles(directory=str(OUTPUTS_DIR)), name="outputs")
app.include_router(generation_router)


@app.get("/health")
async def health_check() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/v1/hardware")
async def hardware_info() -> dict:
    return hardware.describe()


# ─── v1 image generation ─────────────────────────────────────────────────────

class V1ImageRequest(BaseModel):
    prompt: str
    steps: int = 20
    guidance: float = 7.5
    width: int = 512
    height: int = 512
    tier: str | None = None


class V1ImageResponse(BaseModel):
    image_url: str
    tier: str


def _outputs_url(filename: str) -> str:
    return f"/outputs/{filename}"


def _unique_filename(ext: str, seed: str) -> str:
    digest = hashlib.sha1(f"{seed}{time.time_ns()}".encode("utf-8")).hexdigest()[:12]
    return f"v1-{digest}.{ext}"


@app.post("/v1/generate/image", response_model=V1ImageResponse)
async def v1_generate_image(req: V1ImageRequest) -> V1ImageResponse:
    try:
        data = await run_in_threadpool(
            image_model.generate_image,
            req.prompt,
            req.steps,
            req.guidance,
            req.width,
            req.height,
            req.tier,
        )
    except Exception as exc:  # noqa: BLE001 — surface generation errors verbatim
        raise HTTPException(status_code=500, detail=f"image generation failed: {exc}") from exc
    filename = _unique_filename("png", req.prompt)
    out_path = OUTPUTS_DIR / filename
    out_path.write_bytes(data)
    tier = image_model.pick_best_tier(req.tier)
    return V1ImageResponse(image_url=_outputs_url(filename), tier=tier["id"])


# ─── v1 TTS ───────────────────────────────────────────────────────────────────

class V1TtsRequest(BaseModel):
    text: str
    voice: str | None = None
    tier: str | None = None


class V1TtsResponse(BaseModel):
    audio_url: str
    tier: str


@app.post("/v1/generate/audio/tts", response_model=V1TtsResponse)
async def v1_generate_tts(req: V1TtsRequest) -> V1TtsResponse:
    try:
        data = await run_in_threadpool(
            tts_model.generate_speech, req.text, req.voice, req.tier
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"tts failed: {exc}") from exc
    filename = _unique_filename("wav", req.text[:40])
    out_path = OUTPUTS_DIR / filename
    out_path.write_bytes(data)
    tier = tts_model.pick_tts_tier(req.tier)
    return V1TtsResponse(audio_url=_outputs_url(filename), tier=tier["id"])


# ─── v1 STT (Whisper) ─────────────────────────────────────────────────────────

class V1TranscribeRequest(BaseModel):
    audio_path: str
    language: str | None = None


class V1TranscribeResponse(BaseModel):
    text: str


@app.post("/v1/transcribe", response_model=V1TranscribeResponse)
async def v1_transcribe(req: V1TranscribeRequest) -> V1TranscribeResponse:
    if not os.path.exists(req.audio_path):
        raise HTTPException(status_code=400, detail=f"file not found: {req.audio_path}")
    try:
        text = await run_in_threadpool(stt_model.transcribe, req.audio_path, req.language)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"transcription failed: {exc}") from exc
    return V1TranscribeResponse(text=text)


# ─── v1 model registry ────────────────────────────────────────────────────────

class V1ModelEntry(BaseModel):
    id: str
    type: str
    loaded: bool
    vram_required_mb: int
    available_for_backend: bool


@app.get("/v1/models/available", response_model=list[V1ModelEntry])
async def v1_models_available() -> list[V1ModelEntry]:
    backend = hardware.get_backend()
    entries: list[V1ModelEntry] = []
    for tier in image_model.IMAGE_MODEL_TIERS:
        entries.append(
            V1ModelEntry(
                id=tier["id"],
                type="image",
                loaded=image_model._pipeline_tier_id == tier["id"],
                vram_required_mb=tier["vram_mb"],
                available_for_backend=backend in tier["backends"],
            )
        )
    for tier in tts_model.TTS_TIERS:
        entries.append(
            V1ModelEntry(
                id=tier["id"],
                type="audio",
                loaded=False,
                vram_required_mb=tier["vram_mb"],
                available_for_backend=backend in tier["backends"],
            )
        )
    return entries


class V1UnloadRequest(BaseModel):
    model_type: str


class V1UnloadResponse(BaseModel):
    ok: bool


@app.post("/v1/models/unload", response_model=V1UnloadResponse)
async def v1_unload(req: V1UnloadRequest) -> V1UnloadResponse:
    if req.model_type == "image":
        image_model.unload_pipeline()
    elif req.model_type == "audio":
        tts_model.unload()
    elif req.model_type == "video":
        # Video uses the existing service; nothing to unload here yet.
        pass
    else:
        raise HTTPException(status_code=400, detail=f"unknown model_type: {req.model_type}")
    return V1UnloadResponse(ok=True)


class V1LoadRequest(BaseModel):
    model_type: str
    tier: str | None = None


@app.post("/v1/models/load", response_model=V1UnloadResponse)
async def v1_load(req: V1LoadRequest) -> V1UnloadResponse:
    if req.model_type == "image":
        await run_in_threadpool(image_model.get_pipeline, req.tier)
        return V1UnloadResponse(ok=True)
    raise HTTPException(status_code=400, detail=f"load not supported for: {req.model_type}")
