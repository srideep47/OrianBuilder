# Orian Builder

**Orian Builder** is a local, open-source AI app builder by **Legion Studios** — fast, private, and fully under your control. Like Lovable, v0, or Bolt, but running right on your machine with full GPU-accelerated local inference.

> Built on the foundation of [Dyad](https://github.com/dyad-sh/dyad) and supercharged with Legion Studios' embedded inference engine, NVIDIA TensorRT acceleration, and advanced agentic system.

## Features

### Core

- **Local first**: Fast, private, zero lock-in — your data never leaves your machine.
- **Bring your own keys**: Use OpenAI, Anthropic, Google, Azure, or any compatible provider.
- **Cross-platform**: Runs on Windows and macOS via Electron.

### Embedded Inference Engine (No API Keys Required)

- **Zero API cost**: Run GGUF-format models entirely on your own hardware.
- **HuggingFace Marketplace**: Browse, search, and download models directly inside the app.
- **llama.cpp backend**: Efficient CPU + GPU inference via `node-llama-cpp`.
- **Live Monitor**: Real-time tokens-per-second, GPU/VRAM utilization, temperature, power draw, and inference logs — all updated live.
- **Tool calling**: Full tool-use support for local models in agentic workflows.
- **Smart VRAM management**: Automatic GPU-layer detection with manual override and VRAM headroom control.
- **Flash Attention & context tuning**: Configurable context size, batch size, temperature, top-p/k, and repeat penalty.

### NVIDIA TensorRT Acceleration

- **GPU-compiled inference**: Build TRT engine plans compiled specifically for your GPU architecture.
- **One-click engine build**: Downloads the model from HuggingFace, exports ONNX, and compiles via `trtexec` — all in-app.
- **Streaming token generation**: Real-time output via a Python sidecar (no TensorRT-LLM required on Windows).
- **dtype selection**: Choose `fp16` or `fp32` precision for the engine build.
- **Engine format detection**: Automatic badge shows engine format (`tensorrt-llm` / `tensorrt-plan`).
- **Supported models**: Qwen2.5 series (0.5B → 7B Instruct) out of the box, extensible to any HuggingFace model.

### Advanced Agentic System

- **Full tool-calling agent loop**: Multi-step agentic execution — the agent keeps calling tools until the task is complete.
- **Parallel tool calls**: Multiple tools executed simultaneously per turn for maximum throughput.
- **Multi-project-type support**: Web apps, mobile apps, APIs, data pipelines, and scripts — all first-class.
- **TypeScript auto-fix**: Automatic detection and resolution of compiler errors in the agent loop.
- **Smart context selection**: Intelligent file filtering using smaller models so only relevant code is sent to the LLM.
- **Manual context management**: Explicitly select files and components to include as context.
- **Version history**: Built-in app versioning with rollback support.
- **Plan mode**: Agent drafts a plan before executing, giving you visibility and control.

### AI Provider Support

- Anthropic (Claude)
- OpenAI (GPT-4, o1/o3/o4 series)
- Google (Gemini)
- Azure OpenAI
- Amazon Bedrock
- Local / embedded (llama.cpp + TensorRT)

## Download

Binaries and releases: [github.com/srideep47/OrianBuilder/releases](https://github.com/srideep47/OrianBuilder/releases)

No sign-up required. Download, launch, and start building.

## Quick Start

### Cloud AI (API key required)

1. Launch the app and go to **Settings**.
2. Add your API key for any supported provider.
3. Create a new app and start prompting.

### Local Inference (no API key)

1. Open the **Engine** screen from the sidebar.
2. Browse the HuggingFace marketplace and download a model (e.g. Qwen2.5-1.5B-Instruct).
3. Click **Load** — inference starts immediately on CPU + GPU.
4. Go to **Settings** → AI Model and switch to `Local / Embedded`.

### TensorRT (NVIDIA GPU, maximum speed)

1. Open the **Engine** screen and go to the **TensorRT** tab.
2. Select a model and click **Build Engine** (takes 10–40 min on first build).
3. Once complete, load the engine and use it as your inference backend.

> **Requirements for TensorRT:** NVIDIA GPU (RTX series recommended), CUDA 12.x, Python 3.10, and TensorRT 10.x installed. Set the `TENSORRT_ROOT` environment variable to your TensorRT installation directory.

## Development Setup

**Install dependencies:**

```sh
npm install
```

**Create the userData directory (required for local database):**

```sh
# Windows PowerShell:
mkdir userData

# macOS / Linux:
mkdir -p userData
```

**Run in development mode:**

```sh
npm start
```

**Type-check:**

```sh
npm run ts
```

**Lint and format:**

```sh
npm run fmt
npm run lint
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full development guide.

## Architecture

- **Electron** desktop app with a secure main/renderer IPC boundary
- **React 19** + TanStack Router for the UI
- **Drizzle ORM** + SQLite for local persistence
- **Vercel AI SDK** for cloud LLM integration
- **node-llama-cpp** for local GGUF model inference
- **Python sidecar** (`native/trt-llm-runner/runner.py`) for TensorRT engine build and inference

Full technical overview: [docs/architecture.md](./docs/architecture.md)

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

## License

- Code outside `src/pro/` — open-source under **Apache 2.0** ([LICENSE](./LICENSE))
- Code inside `src/pro/` — fair-source under **Functional Source License 1.1 (Apache 2.0)** ([src/pro/LICENSE](./src/pro/LICENSE))
