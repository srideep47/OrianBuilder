# Orian Builder Architecture

This document describes how the Orian Builder desktop app works at a high level. If something is out of date, feel free to suggest a change via a pull request.

## Overview

Orian Builder is an Electron app that is a local, open-source AI app builder. It combines cloud AI providers (Anthropic, OpenAI, Google, etc.) with an embedded local inference engine so you can build apps without sending data to external servers.

## Electron Architecture

Electron apps are similar to a full-stack JavaScript app:

- **Renderer process** — the sandboxed UI layer (React, TanStack Router).
- **Main process** — a privileged Node.js process with access to the filesystem, native modules, and system resources.

The renderer communicates to the main process via [IPC](https://en.wikipedia.org/wiki/Inter-process_communication), analogous to how a browser communicates with a server via HTTP. All IPC contracts are defined in `src/ipc/` using typed schemas (Zod).

## Life of a Request

The core workflow: a user sends a prompt → the AI edits code → changes are previewed.

1. **Construct the LLM request** — the request includes the user prompt, the current codebase (or a smart-filtered subset of it), and a detailed [system prompt](../src/prompts/system_prompt.ts) that instructs the LLM to respond using `<dyad-write>`, `<dyad-delete>`, and other XML-like action tags.

2. **Stream the response to the UI** — we stream the LLM response in real time and parse the `<dyad-*>` tags using a specialized [Markdown parser](../src/components/chat/DyadMarkdownParser.tsx) so the output is displayed as structured UI rather than raw text.

3. **Process the response** — once generation completes and the user approves, the [response processor](../src/ipc/processors/response_processor.ts) in the main process applies each `<dyad-*>` action: writing files, deleting files, adding npm packages, running SQL, etc.

## Embedded Inference Engine

Orian Builder includes a fully local inference engine so you can run LLMs on your own hardware with no API keys.

### llama.cpp Backend

- **Runtime:** `node-llama-cpp` (native Node.js bindings to llama.cpp)
- **Models:** Any GGUF-format model downloaded from HuggingFace or loaded from disk
- **GPU acceleration:** Automatic layer detection; GPU layers are maximized within available VRAM headroom
- **Features:** Flash Attention, configurable context size, temperature/top-p/top-k/repeat-penalty, seed control

The embedded server exposes an OpenAI-compatible `/v1/chat/completions` endpoint internally so the same agent loop works for both cloud and local models.

### TensorRT Backend (NVIDIA GPU)

For maximum GPU throughput on NVIDIA hardware, Orian Builder includes a TensorRT inference path:

- **Architecture:** Electron main → `TensorRtNativeBackend` (TypeScript) → Python sidecar (`native/trt-llm-runner/runner.py`) → TensorRT Python API
- **Engine build pipeline:** HuggingFace download → ONNX export (via `transformers`) → `trtexec` compilation → serialized `.plan` engine
- **Inference:** Tokenize → prefill → decode loop with streaming token events
- **Token streaming:** The Python runner emits JSON-line events; the TypeScript backend relays them via an `onToken` callback
- **Requirements:** NVIDIA GPU, CUDA 12.x, Python 3.10, TensorRT 10.x, `TENSORRT_ROOT` environment variable

### Live Monitor

The Engine screen provides real-time observability:

- Tokens per second (live, average, peak, lowest)
- Prefill throughput
- GPU utilization %, VRAM used/total
- GPU temperature and power draw
- Inference state machine (idle / loading / prefilling / generating / tool_calling)
- Scrollable inference log with timestamps and log levels

## Advanced Agentic System

Orian Builder uses a full tool-calling agent loop instead of a single-shot LLM request.

- **Agent loop** (`src/pro/main/ipc/handlers/local_agent/local_agent_handler.ts`) — keeps calling the LLM until it stops requesting tool calls or hits the max steps per turn.
- **Parallel tool calls** — multiple tools are executed concurrently per step.
- **Tool definitions** (`src/pro/main/ipc/handlers/local_agent/tool_definitions.ts`) — full list of tools available to the agent.
- **TypeScript auto-fix** — compiler errors are detected and fed back into the agent loop automatically (when Auto-fix is enabled).

## Context Engineering

Sending the right context to the AI is critical:

- **Full codebase mode** — simplest approach; effective for small projects.
- **Smart Context** — uses a smaller model to filter the most relevant files before sending them to the main LLM.
- **Select component** — manually pin specific files or components as context.
- **Manual context management** — explicit file selection for large apps.

## FAQ

### Why use XML-like tags instead of actual tool calls?

1. You can define many parallel "tool calls" in a single generation without model-level parallel function calling support.
2. [Evidence from the community](https://aider.chat/2024/08/14/code-in-json.html) shows that forcing code output into JSON (as tool calling requires) can reduce code quality.

The agentic mode (Agent v2) does use native tool calling — the XML format is used for the simpler single-shot code-editing mode.

### Why does the app send the full codebase?

Sending the entire codebase is simple and effective for small projects. For larger codebases, Smart Context, manual file selection, and the "select component" feature let you control what is sent without requiring per-file manual curation.

### How does local inference interact with the agentic loop?

The embedded inference server exposes an OpenAI-compatible API internally. The agent loop calls this endpoint the same way it calls any cloud provider. Tool calling is supported for local models that output JSON tool-call syntax (note: TensorRT backend currently uses llama.cpp for tool-call-heavy workflows).

### What is the Python sidecar and why?

TensorRT-LLM's C++ runtime is not buildable on Windows. The Python API (`tensorrt` wheel) is, and it integrates cleanly with `transformers` and `torch` for tokenization and ONNX export. The sidecar communicates over stdin/stdout using JSON-line events, keeping the boundary minimal and debuggable.
