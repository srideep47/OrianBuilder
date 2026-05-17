from pydantic import BaseModel, Field, model_validator


class PromptRequest(BaseModel):
    prompt: str = Field(..., min_length=1, examples=["Generate a futuristic city at sunset."])


class TextGenerationRequest(PromptRequest):
    max_tokens: int = Field(default=128, ge=1, le=4096)
    temperature: float = Field(default=0.7, ge=0.0, le=2.0)
    top_p: float = Field(default=0.95, ge=0.0, le=1.0)


class ImageGenerationRequest(PromptRequest):
    width: int = Field(default=512, ge=64, le=1024)
    height: int = Field(default=512, ge=64, le=1024)
    num_inference_steps: int = Field(default=20, ge=1, le=50)
    guidance_scale: float = Field(default=7.5, ge=0.0, le=20.0)
    negative_prompt: str | None = Field(default=None)
    seed: int | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def validate_stable_diffusion_size(self) -> "ImageGenerationRequest":
        if self.width % 8 != 0 or self.height % 8 != 0:
            raise ValueError("width and height must be divisible by 8")
        return self


class AudioGenerationRequest(PromptRequest):
    pass


class VideoGenerationRequest(PromptRequest):
    num_frames: int = Field(default=8, ge=1, le=16)
    num_inference_steps: int = Field(default=10, ge=1, le=25)
    height: int = Field(default=256, ge=128, le=512)
    width: int = Field(default=256, ge=128, le=512)


class TextGenerationResponse(BaseModel):
    prompt: str
    text: str
    model: str
    backend: str | None = None
    warning: str | None = None


class ImageGenerationResponse(BaseModel):
    prompt: str
    image_path: str
    image_url: str
    model: str
    provider: str | None = None
    warning: str | None = None


class AudioGenerationResponse(BaseModel):
    prompt: str
    audio_path: str
    audio_url: str
    model: str
    sample_rate: int | None = None
    warning: str | None = None


class VideoGenerationResponse(BaseModel):
    prompt: str
    video_path: str
    video_url: str
    model: str
    warning: str
