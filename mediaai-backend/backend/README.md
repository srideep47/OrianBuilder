# OmniGen Local Backend

Local FastAPI backend for the OmniGen Local desktop app.

## Setup

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

## Run

Normal local run:

```powershell
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Keep this PowerShell window open while the backend is running. Open a second PowerShell window for `Invoke-RestMethod` requests. If you press `Ctrl+C`, the backend stops and requests to `127.0.0.1:8000` will fail until you start it again.

Development run with reload:

```powershell
uvicorn app.main:app --reload --reload-exclude ".venv/*" --reload-exclude "outputs/*" --host 127.0.0.1 --port 8000
```

Health check:

```powershell
Invoke-RestMethod http://127.0.0.1:8000/health
```

Mock generation endpoints:

- `POST /generate/text`
- `POST /generate/image`
- `POST /generate/audio`
- `POST /generate/video`

## Image Generation

`POST /generate/image` uses Hugging Face Optimum ONNX Runtime with the DirectML execution provider. The first image request can take a long time because the model may need to download and export to ONNX.

Default model. This is a pre-exported FP16 SD 1.5 ONNX model, which avoids runtime ONNX export issues on Python 3.13+:

```powershell
$env:OMNIGEN_IMAGE_MODEL_ID="nmkd/stable-diffusion-1.5-onnx-fp16"
```

DirectML provider:

```powershell
$env:OMNIGEN_IMAGE_PROVIDER="DmlExecutionProvider"
```

Check that DirectML is visible to ONNX Runtime:

```powershell
python scripts/check_directml.py
```

Example request:

```powershell
Invoke-RestMethod -Method Post `
  -Uri http://127.0.0.1:8000/generate/image `
  -ContentType 'application/json' `
  -Body '{"prompt":"a compact cyberpunk workstation, cinematic lighting","width":512,"height":512,"num_inference_steps":20,"guidance_scale":7.5}'
```

Generated images are saved in `outputs/` and returned as both `image_path` and `image_url`.

If DirectML returns a flat gray image for a model/runtime combination, the service retries the same request with `CPUExecutionProvider` and includes a `warning` field in the response. This keeps the endpoint usable on AMD systems where a specific ONNX export fails silently on DirectML.

Runtime export from PyTorch Diffusers checkpoints is disabled by default:

```powershell
$env:OMNIGEN_IMAGE_EXPORT_ONNX="false"
```

Only enable runtime export if you are running Python 3.12:

```powershell
$env:OMNIGEN_IMAGE_MODEL_ID="stable-diffusion-v1-5/stable-diffusion-v1-5"
$env:OMNIGEN_IMAGE_EXPORT_ONNX="true"
```

For Optimum-format SD 1.5 experiments, set:

```powershell
$env:OMNIGEN_IMAGE_MODEL_ID="onnx-community/stable-diffusion-v1-5-ONNX"
```

Then use standard SD 1.5 settings:

```json
{
  "prompt": "a compact cyberpunk workstation, cinematic lighting",
  "width": 512,
  "height": 512,
  "num_inference_steps": 20,
  "guidance_scale": 7.5
}
```

On 4 GB GPUs, full SD 1.5 ONNX can still be very slow. The FP16 default is the safer starting point.

## Text Generation

`POST /generate/text` uses `llama-cpp-python` with a GGUF model. By default it downloads:

```text
microsoft/Phi-3-mini-4k-instruct-gguf / Phi-3-mini-4k-instruct-q4.gguf
```

Override the model path:

```powershell
$env:OMNIGEN_TEXT_MODEL_PATH="C:\path\to\model.gguf"
```

Override the Hugging Face model source:

```powershell
$env:OMNIGEN_TEXT_MODEL_REPO="microsoft/Phi-3-mini-4k-instruct-gguf"
$env:OMNIGEN_TEXT_MODEL_FILE="Phi-3-mini-4k-instruct-q4.gguf"
```

The installed `llama-cpp-python` build falls back to CPU when GPU offload is unavailable. To try Vulkan acceleration on AMD, reinstall it before running the backend:

```powershell
$env:CMAKE_ARGS="-DGGML_VULKAN=ON"
pip install --force-reinstall --no-cache-dir llama-cpp-python==0.3.21
```

## Audio Generation

`POST /generate/audio` uses `suno/bark-small` from Hugging Face Transformers. It always runs on CPU to preserve GPU VRAM, saves WAV files to `outputs/`, and returns `audio_path` plus `audio_url`.

Example:

```powershell
Invoke-RestMethod -Method Post `
  -Uri http://127.0.0.1:8000/generate/audio `
  -ContentType 'application/json' `
  -Body '{"prompt":"hello from OmniGen Local","voice":"v2/en_speaker_6","max_new_tokens":100}'
```
