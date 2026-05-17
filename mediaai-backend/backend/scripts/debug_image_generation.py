import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.schemas import ImageGenerationRequest
from app.services.image_generation import image_generation_service


def main() -> None:
    request = ImageGenerationRequest(
        prompt="debug test image",
        width=512,
        height=512,
        num_inference_steps=4,
        guidance_scale=7.5,
    )
    generated = image_generation_service.generate(request)
    print(generated)


if __name__ == "__main__":
    main()
