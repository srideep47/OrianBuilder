# Qwen 3.x with the embedded inference engine (primary path)

OrianBuilder runs Qwen 3.x GGUFs through the bundled `node-llama-cpp`
inference server. As of commit `chat_wrapper_resolver` rev 2, this path is
configured end-to-end inside the app — you don't need to do anything in
LM Studio or edit any templates. Just point the Models page at a Qwen 3.5
or 3.6 GGUF file and load it.

If you've ever used LM Studio in parallel, ignore the
[`qwen-lm-studio.md`](./qwen-lm-studio.md) doc — that's only relevant when
running outside the embedded engine.

## What the app does for you

### 1. Picks the right chat wrapper

[`chat_wrapper_resolver.ts`](../../src/ipc/utils/chat_wrapper_resolver.ts)
detects Qwen 3.5 / 3.6 by filename and constructs
`QwenChatWrapper({ variation: "3.5", keepOnlyLastThought: false })` from
node-llama-cpp. This wrapper handles:

- Tool calls as structured `function_call` events instead of stringified
  XML in the assistant text
- `<think>...</think>` reasoning blocks as separate reasoning chunks
  (the agent renders these as collapsible thoughts, not chat content)
- Cross-turn thinking preservation, so the model doesn't re-derive
  context from scratch each step (matches Qwen 3.6's documented
  "Thinking Preservation" feature)

The previous code returned `null` from this branch on the assumption that
the GGUF's embedded Jinja template would work. It doesn't: Qwen 3.x's
official Jinja uses `|items`, which the C++ Jinja engine in llama.cpp
can't parse. Tool calls leaked into text as `||call|:tool_name(...)`,
the agent loop saw zero structured tool calls, and runs dead-ended.

### 2. Applies Qwen's official sampling parameters

[`qwen_sampling.ts`](../../src/pro/main/ipc/handlers/local_agent/qwen_sampling.ts)
overrides Vercel AI SDK defaults when a Qwen model is selected. For
agentic / coding work the app sends:

| Parameter        | Value | Source                                                    |
| ---------------- | ----- | --------------------------------------------------------- |
| temperature      | 0.6   | Qwen 3.6 27B model card — "Thinking mode, precise coding" |
| top_p            | 0.95  | Qwen 3.6 27B model card                                   |
| top_k            | 20    | Qwen 3.6 27B model card                                   |
| presence_penalty | 0     | Qwen 3.6 27B model card (coding profile)                  |

The AI SDK's default of `temperature: 0` is the documented Qwen failure
mode — it collapses the distribution and causes repetition / tool-calls-
as-text behavior.

### 3. Emits diagnostic logging

Every stream attempt produces a one-line structured trace in the main log
(`%APPDATA%\OrianBuilder\logs\main.log` on Windows):

```
Stream diagnostics: {
  "model":"embedded:Qwen3.6-27B-Q4_K_M.gguf",
  "isQwen":true,
  "sampling":{"temperature":0.6,"topP":0.95,"topK":20,...},
  "parts":{"text-delta":1247,"tool-call":3,...},
  "toolCalls":3,
  "suspicious":{}
}
```

| Field        | Healthy                       | Misconfigured                                                        |
| ------------ | ----------------------------- | -------------------------------------------------------------------- |
| `toolCalls`  | > 0 when the agent uses tools | 0                                                                    |
| `suspicious` | empty `{}`                    | non-zero counts of `qwen_pipe_tool_call`, `qwen_thinking_open`, etc. |

If `toolCalls: 0` AND `suspicious` is non-empty, something regressed in
the chat-wrapper-resolver path. File an issue with this log line.

## Quantization recommendation

`Q4_K_M` (the default download for most Qwen 3.6 GGUFs) works for tool
calling but loses a small amount of accuracy compared to higher
quantizations. From the unsloth/Qwen3.6-27B-GGUF benchmarks:

| Quant  | Size     | Use case                                                            |
| ------ | -------- | ------------------------------------------------------------------- |
| Q4_K_M | ~17.6 GB | Default. Works on a 24 GB GPU comfortably.                          |
| Q5_K_M | ~20 GB   | Marginal quality gain over Q4_K_M.                                  |
| Q6_K   | ~22.5 GB | Closer to BF16 output distribution. Recommended if you have 24+ GB. |
| Q8_0   | ~28 GB   | Production-grade. Needs 32+ GB VRAM.                                |

If you have a 24 GB card (RTX 3090 / 4090 / 5090), prefer Q6_K. The
extra ~5 GB buys noticeably better instruction-following on multi-step
agent tasks. If you only have 16 GB, stick with Q4_K_M.

## Reference

- [Qwen 3.6 27B model card](https://huggingface.co/Qwen/Qwen3.6-27B)
- [node-llama-cpp QwenChatWrapper source](https://node-llama-cpp.withcat.ai/api/classes/QwenChatWrapper)
- [Unsloth Qwen 3.6 guide](https://unsloth.ai/docs/models/qwen3.6)
