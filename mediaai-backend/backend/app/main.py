import hashlib
import os
import time
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool

from app.routes.generation import router as generation_router
from app import hardware
from app.models import image as image_model
from app.models import tts as tts_model
from app.models import stt as stt_model
from app.models import video as video_model
from app.models import music as music_model

BACKEND_DIR = Path(__file__).resolve().parents[1]
STATIC_DIR = BACKEND_DIR / "static"
OUTPUTS_DIR = Path(os.getenv("OMNIGEN_OUTPUTS_DIR", str(BACKEND_DIR / "outputs")))

STATIC_DIR.mkdir(parents=True, exist_ok=True)
OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(
    title="OmniGen Local Backend",
    description="Local multimodal AI backend with hardware-aware generation.",
    version="0.3.0",
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


@app.post("/v1/pipeline/unload")
async def unload_pipeline() -> dict:
    """Evict the in-memory image pipeline so it reloads (on the correct device)
    on the next generation request. Useful when the first generation ran on CPU
    because CUDA was not yet visible at startup."""
    image_model.unload_pipeline()
    return {"status": "ok", "message": "pipeline evicted"}


# ─── Filename helpers ────────────────────────────────────────────────────────


def _outputs_url(filename: str) -> str:
    return f"/outputs/{filename}"


def _unique_filename(ext: str, seed: str) -> str:
    digest = hashlib.sha1(f"{seed}{time.time_ns()}".encode("utf-8")).hexdigest()[:12]
    return f"v1-{digest}.{ext}"


# ─── v1 image generation ─────────────────────────────────────────────────────


class V1ImageRequest(BaseModel):
    prompt: str
    steps: int = 20
    guidance: float = 7.5
    width: int = 512
    height: int = 512
    tier: str | None = None
    seed: int | None = None


class V1ImageResponse(BaseModel):
    image_url: str
    tier: str


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
            req.seed,
        )
    except Exception as exc:  # noqa: BLE001 — surface generation errors verbatim
        raise HTTPException(status_code=500, detail=f"image generation failed: {exc}") from exc
    filename = _unique_filename("png", req.prompt)
    out_path = OUTPUTS_DIR / filename
    out_path.write_bytes(data)
    tier = image_model.pick_best_tier(req.tier)
    return V1ImageResponse(image_url=_outputs_url(filename), tier=tier["id"])


# ─── v1 video generation ─────────────────────────────────────────────────────


class V1VideoRequest(BaseModel):
    prompt: str
    tier: str | None = None
    num_frames: int | None = None
    fps: int | None = None
    width: int | None = None
    height: int | None = None
    steps: int | None = None


class V1VideoResponse(BaseModel):
    video_url: str
    tier: str
    model: str


@app.post("/v1/generate/video", response_model=V1VideoResponse)
async def v1_generate_video(req: V1VideoRequest) -> V1VideoResponse:
    try:
        result = await run_in_threadpool(
            video_model.generate_video,
            req.prompt,
            req.tier,
            req.num_frames,
            req.fps,
            req.width,
            req.height,
            req.steps,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"video generation failed: {exc}") from exc

    # video.generate_video already wrote the file under OUTPUTS_DIR and returned
    # a server-relative URL. Forward it.
    return V1VideoResponse(
        video_url=result["video_url"],
        tier=result["tier"],
        model=result["model"],
    )


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


# ─── v1 Music generation (ACE-Step 1.5) ──────────────────────────────────────


class V1MusicTierInfo(BaseModel):
    id: str
    label: str
    description: str
    vram_mb: int
    download_size_mb: int
    backends: list[str]
    uses_lm: bool
    repo_url: str
    available_for_backend: bool
    status: str  # "downloaded" | "downloading" | "not_downloaded"
    download_progress: float | None = None
    selected: bool


class V1MusicTiersResponse(BaseModel):
    tiers: list[V1MusicTierInfo]
    selected_tier_id: str


@app.get("/v1/generate/music/tiers", response_model=V1MusicTiersResponse)
async def v1_music_tiers() -> V1MusicTiersResponse:
    """Return all music tiers with download status and which one is selected."""
    best = music_model.pick_best_music_tier()
    backend = hardware.get_backend()
    normalized_backend = "mps" if backend == "metal" else backend
    tiers = [
        V1MusicTierInfo(
            id=t["id"],
            label=t["label"],
            description=t["description"],
            vram_mb=t["vram_mb"],
            download_size_mb=t["download_size_mb"],
            backends=t["backends"],
            uses_lm=t["uses_lm"],
            repo_url=t["repo_url"],
            available_for_backend=normalized_backend in t["backends"],
            status=music_model.tier_status(t["id"]),
            download_progress=music_model._download_progress.get(t["id"]) if music_model.tier_status(t["id"]) == "downloading" else None,
            selected=(t["id"] == best["id"]),
        )
        for t in music_model.MUSIC_TIERS
    ]
    return V1MusicTiersResponse(tiers=tiers, selected_tier_id=best["id"])


class V1MusicDownloadRequest(BaseModel):
    tier_id: str


class V1MusicDownloadResponse(BaseModel):
    ok: bool
    tier_id: str
    status: str


@app.post("/v1/generate/music/download", response_model=V1MusicDownloadResponse)
async def v1_music_download(req: V1MusicDownloadRequest) -> V1MusicDownloadResponse:
    """Trigger a background download of the model weights for the given tier."""
    import asyncio

    # Validate before we hand work to a background thread, otherwise bad tier
    # names only fail in the server log while the renderer keeps polling.
    music_model.pick_best_music_tier(req.tier_id)
    loop = asyncio.get_running_loop()
    loop.run_in_executor(None, music_model.download_tier, req.tier_id)
    return V1MusicDownloadResponse(
        ok=True,
        tier_id=req.tier_id,
        status=music_model.tier_status(req.tier_id),
    )


class V1MusicRequest(BaseModel):
    prompt: str
    duration_seconds: float = 15.0
    tier: str | None = None


class V1MusicResponse(BaseModel):
    audio_url: str
    tier: str
    duration_seconds: float


@app.post("/v1/generate/music", response_model=V1MusicResponse)
async def v1_generate_music(req: V1MusicRequest) -> V1MusicResponse:
    try:
        data = await run_in_threadpool(
            music_model.generate_music,
            req.prompt,
            req.duration_seconds,
            req.tier,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"music generation failed: {exc}") from exc
    filename = _unique_filename("wav", req.prompt[:40])
    out_path = OUTPUTS_DIR / filename
    out_path.write_bytes(data)
    tier = music_model.pick_best_music_tier(req.tier)
    return V1MusicResponse(
        audio_url=_outputs_url(filename),
        tier=tier["id"],
        duration_seconds=req.duration_seconds,
    )


# ─── v1 STT (Whisper) ─────────────────────────────────────────────────────────

class V1TranscribeResponse(BaseModel):
    text: str
    tier: str


@app.post("/v1/transcribe", response_model=V1TranscribeResponse)
async def v1_transcribe(
    audio: UploadFile = File(...),
    language: str | None = Form(default=None),
    tier: str | None = Form(default=None),
) -> V1TranscribeResponse:
    import tempfile
    import shutil as _shutil
    suffix = Path(audio.filename or "audio.wav").suffix or ".wav"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        _shutil.copyfileobj(audio.file, tmp)
        tmp_path = tmp.name
    try:
        text = await run_in_threadpool(stt_model.transcribe, tmp_path, language, tier)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"transcription failed: {exc}") from exc
    finally:
        try:
            os.unlink(tmp_path)
        except Exception:
            pass
    stt_tier = stt_model.pick_stt_tier(tier)
    return V1TranscribeResponse(text=text, tier=stt_tier["id"])


# ─── v1 model registry ────────────────────────────────────────────────────────


class V1ModelEntry(BaseModel):
    id: str
    type: str
    label: str
    loaded: bool
    vram_required_mb: int
    download_size_mb: int
    available_for_backend: bool
    hf_repo: str | None = None


@app.get("/v1/models/available", response_model=list[V1ModelEntry])
async def v1_models_available() -> list[V1ModelEntry]:
    backend = hardware.get_backend()
    entries: list[V1ModelEntry] = []
    for tier in image_model.IMAGE_MODEL_TIERS:
        entries.append(
            V1ModelEntry(
                id=tier["id"],
                type="image",
                label=tier["label"],
                loaded=image_model._pipeline_tier_id == tier["id"],
                vram_required_mb=tier["vram_mb"],
                download_size_mb=tier["download_size_mb"],
                available_for_backend=backend in tier["backends"],
                hf_repo=tier["repo"],
            )
        )
    for tier in video_model.VIDEO_TIERS:
        entries.append(
            V1ModelEntry(
                id=tier["id"],
                type="video",
                label=tier["label"],
                loaded=video_model._pipeline_tier_id == tier["id"],
                vram_required_mb=tier["vram_mb"],
                download_size_mb=tier["download_size_mb"],
                available_for_backend=backend in tier["backends"],
                hf_repo=tier["repo"],
            )
        )
    for tier in tts_model.TTS_TIERS:
        entries.append(
            V1ModelEntry(
                id=tier["id"],
                type="audio",
                label=tier["label"],
                loaded=tts_model._loaded_tier_id == tier["id"],
                vram_required_mb=tier["vram_mb"],
                download_size_mb=tier["download_size_mb"],
                available_for_backend=backend in tier["backends"],
                hf_repo=tier["repo"],
            )
        )
    for tier in stt_model.STT_TIERS:
        entries.append(
            V1ModelEntry(
                id=tier["id"],
                type="stt",
                label=tier["label"],
                loaded=stt_model._pipeline_tier_id == tier["id"],
                vram_required_mb=tier["vram_mb"],
                download_size_mb=tier["download_size_mb"],
                available_for_backend=backend in tier["backends"],
                hf_repo=tier["repo"],
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
    elif req.model_type == "video":
        video_model.unload_pipeline()
    elif req.model_type == "audio":
        tts_model.unload()
    elif req.model_type == "stt":
        stt_model.unload()
    elif req.model_type == "music":
        music_model.unload()
    elif req.model_type == "all":
        image_model.unload_pipeline()
        video_model.unload_pipeline()
        tts_model.unload()
        stt_model.unload()
        music_model.unload()
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
    if req.model_type == "video":
        await run_in_threadpool(video_model.get_pipeline, req.tier)
        return V1UnloadResponse(ok=True)
    if req.model_type == "stt":
        await run_in_threadpool(stt_model.get_pipeline, req.tier)
        return V1UnloadResponse(ok=True)
    raise HTTPException(status_code=400, detail=f"load not supported for: {req.model_type}")


# ─── v1 model download (pre-cache via huggingface_hub) ───────────────────────


class V1DownloadRequest(BaseModel):
    model_type: str
    tier: str


class V1DownloadResponse(BaseModel):
    ok: bool
    cached_path: str | None = None
    error: str | None = None


def _resolve_repo(model_type: str, tier_id: str) -> str | None:
    if model_type == "image":
        for t in image_model.IMAGE_MODEL_TIERS:
            if t["id"] == tier_id:
                return t["repo"]
    if model_type == "video":
        for t in video_model.VIDEO_TIERS:
            if t["id"] == tier_id:
                return t["repo"]
    if model_type == "audio":
        for t in tts_model.TTS_TIERS:
            if t["id"] == tier_id:
                return t["repo"]
    if model_type == "stt":
        for t in stt_model.STT_TIERS:
            if t["id"] == tier_id:
                return t["repo"]
    return None


def _do_download(repo_id: str) -> str:
    from huggingface_hub import snapshot_download  # type: ignore

    return snapshot_download(repo_id=repo_id)


@app.post("/v1/models/download", response_model=V1DownloadResponse)
async def v1_download(req: V1DownloadRequest) -> V1DownloadResponse:
    repo = _resolve_repo(req.model_type, req.tier)
    if not repo:
        return V1DownloadResponse(
            ok=False, error=f"no hf repo configured for {req.model_type}/{req.tier}"
        )
    try:
        cached = await run_in_threadpool(_do_download, repo)
    except Exception as exc:  # noqa: BLE001
        return V1DownloadResponse(ok=False, error=f"download failed: {exc}")
    return V1DownloadResponse(ok=True, cached_path=cached)
