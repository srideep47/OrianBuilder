# llama-server binaries

This directory holds the native `llama-server` executables we ship with the
app. Binaries themselves are **not committed** — they're fetched by the
downloader script and bundled at packaging time.

## Layout

```
resources/llama-server/
├── win-cuda/llama-server.exe        # Windows + NVIDIA (CUDA)
├── win-vulkan/llama-server.exe      # Windows + AMD/Intel (Vulkan)
├── win-cpu/llama-server.exe         # Windows fallback (CPU only)
├── linux-cuda/llama-server          # Linux + NVIDIA
├── linux-vulkan/llama-server        # Linux + AMD/Intel
├── linux-cpu/llama-server           # Linux fallback
└── mac-metal/llama-server           # macOS (universal — Metal)
```

The runtime variant is picked from the hardware profile by
`src/main/llm/llama_server_binary.ts::pickLlamaServerVariant`.

## Acquiring binaries

```sh
# From the project root:
node scripts/download-llama-server.mjs           # downloads all platforms
node scripts/download-llama-server.mjs --here    # downloads only the current OS/arch
```

Both forms fetch the latest release artifact from
[ggerganov/llama.cpp](https://github.com/ggerganov/llama.cpp/releases) and
extract `llama-server` (or `llama-server.exe`) into the appropriate variant
subdirectory.

## Overriding for local development

To point at a custom build (e.g. a debug-build llama-server you compiled
yourself), set `LLAMA_SERVER_PATH` to an absolute path to the binary:

```sh
# bash / zsh
export LLAMA_SERVER_PATH="/Users/me/src/llama.cpp/build/bin/llama-server"

# PowerShell
$env:LLAMA_SERVER_PATH = "D:\src\llama.cpp\build\bin\llama-server.exe"
```

The env override skips variant detection entirely.

## Bundling

`forge.config.ts` has `resources/llama-server` listed in `extraResource`,
which copies this whole tree to `<app-resources>/llama-server/` in packaged
builds. CI must run the downloader before `npm run package` so the binaries
exist by the time Electron Forge copies them.
