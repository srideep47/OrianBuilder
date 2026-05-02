# Orian TensorRT Runner

Windows-native sidecar process for loading a compiled TensorRT / TensorRT-LLM
engine from OrianBuilder without WSL.

The Electron main process starts `OrianTensorRtRunner.exe` and talks to it over
stdin/stdout JSON lines. This keeps TensorRT DLL loading out of the Electron
process while still running fully native on Windows.

## Protocol

Each request is one JSON object per line:

```json
{"id":"...","type":"load","engineDir":"C:\\path\\to\\engine"}
{"id":"...","type":"chat","system":"...","prompt":"...","maxTokens":512}
{"id":"...","type":"unload"}
```

Each response is one JSON object per line:

```json
{"id":"...","ok":true}
{"id":"...","ok":true,"text":"...","tokenCount":128,"decodeTps":42.5,"durationMs":3012}
{"id":"...","ok":false,"error":"..."}
```

## Build Placement

Build output expected by the app in development:

```text
native/tensorrt-runner/bin/OrianTensorRtRunner.exe
```

Packaged app placement:

```text
resources/tensorrt-runner/OrianTensorRtRunner.exe
```

## Runtime Notes

This folder intentionally avoids a Node native addon. TensorRT and TensorRT-LLM
DLL lifetime is isolated in the runner process, which prevents Electron crashes
from tearing down the UI process while loading experimental engines.

## Windows Setup for Development

1. Install a current NVIDIA driver for the target GPU.
2. Install CUDA Toolkit supported by the TensorRT version you choose.
3. Download and extract NVIDIA TensorRT for Windows from NVIDIA.
4. Set `TENSORRT_ROOT` to the extracted folder, for example:

```powershell
$env:TENSORRT_ROOT = "C:\NVIDIA\TensorRT-10.16.1.9"
```

5. Build the runner:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-tensorrt-runner.ps1
```

The app discovers TensorRT DLLs from `ORIAN_TENSORRT_ROOT`, `TENSORRT_ROOT`,
`userData/runtimes/tensorrt`, packaged `resources/tensorrt-runtime`, or `PATH`.

## Local Engine Builds

OrianBuilder does not ship per-GPU TensorRT engines. TensorRT plans are hardware,
TensorRT-version, and shape-profile sensitive, so the app starts a one-time local
build on the user's machine when the hardware and NVIDIA runtime are available.

The packaged app includes `scripts/build-tensorrt-engine.ps1`. The current native
builder supports ONNX-to-TensorRT smoke tests through NVIDIA `trtexec`:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-tensorrt-engine.ps1 `
  -OnnxPath C:\models\model.onnx `
  -OutputDir "$env:APPDATA\OrianBuilder\models\trt_engines\qwen3-4b"
```

For Hugging Face Qwen model IDs, the app has the control plane and UI in place,
but the Windows-native Qwen-to-TensorRT-LLM conversion step still needs a
compatible builder before full chat generation can run end to end.
