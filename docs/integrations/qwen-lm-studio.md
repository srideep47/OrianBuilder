# Qwen 3.x in LM Studio — required configuration

Local Qwen 3.x models (Qwen 3.6 27B, Qwen 3.5, Qwen3-Coder-Next, etc.) need
specific configuration in LM Studio or they fail in subtle ways that look
like model incompetence but are actually integration bugs.

If you see any of these symptoms, this doc is what you want:

- The agent emits tool calls as plain text (e.g. `||call|:set_chat_summary(...)`)
- Chat output contains stray `<think>`, `<thinking>`, `<system-reminder>`, or `<tool_call>` tags
- Agent says "I'll create..." and stops after one tool call
- The local-agent log emits `Possible model-integration issue — model output contains tokens that look like a tool-call/thinking format leaking into text`

The application now applies Qwen's recommended sampling parameters
automatically when it detects a Qwen model — but you still need to fix
LM Studio's chat template manually. The default template shipped with
Qwen 3.x GGUFs uses Python-Jinja syntax that LM Studio's C++ template
engine can't parse, so tool calls and thinking blocks render as raw text.

## Fix: replace the prompt template

1. **Download the fixed template** from
   [`froggeric/Qwen-Fixed-Chat-Templates`](https://huggingface.co/froggeric/Qwen-Fixed-Chat-Templates/blob/main/qwen3.6/chat_template.jinja).
   Pick the file under the directory matching your model:
   - `qwen3.6/chat_template.jinja` for Qwen 3.6
   - `qwen3.5/chat_template.jinja` for Qwen 3.5
   - `qwen3-coder/chat_template.jinja` for Qwen3-Coder-Next

2. **Open the model in LM Studio.**

3. In the right-hand panel, scroll down to **Prompt Template**.

4. Click the pencil/edit icon and paste the contents of the downloaded
   `chat_template.jinja` file. Save.

5. Reload the model (toggle it off and on).

## What the fix changes

The original Qwen 3.x template has four bugs that affect C++-based engines
(LM Studio, llama.cpp, MLX, koboldcpp):

| Bug                                                          | Symptom                                                               | Fix                                     |
| ------------------------------------------------------------ | --------------------------------------------------------------------- | --------------------------------------- |
| `\|items` filter not supported in C++ Jinja                  | Tool-call arguments render as Python repr instead of JSON             | Replace with direct dict key lookups    |
| Arguments arrive as strings, not objects                     | `arguments\|tojson` produces escaped string                           | Type-check before serializing           |
| Model starts `<think>` then immediately tool-calls           | Tool call appears inside an unclosed thinking block; never recognized | Auto-inject `</think>` before tool call |
| Model occasionally emits `</thinking>` instead of `</think>` | Closing tag not recognized; thinking content leaks                    | Detect both variants                    |

## Other recommended settings

The application now passes the right sampling parameters automatically
when it detects a Qwen model. For reference, the values from the official
Qwen 3.6 27B model card are:

| Use case                     | temperature | top_p | top_k | presence_penalty |
| ---------------------------- | ----------- | ----- | ----- | ---------------- |
| Coding (what the agent does) | 0.6         | 0.95  | 20    | 0                |
| General chat (thinking mode) | 1.0         | 0.95  | 20    | 1.5              |
| General chat (non-thinking)  | 0.7         | 0.80  | 20    | 1.5              |

Don't override these in LM Studio's per-model sampling settings — let the
application pass them, or set them to match.

## Diagnostic logging

Every agent stream now emits a one-line structured summary in the logs
(`%APPDATA%\OrianBuilder\logs\main.log`):

```
[INFO] Stream diagnostics: {
  "model": "lmstudio:qwen3.6-27b-q4_k_m",
  "isQwen": true,
  "sampling": { "temperature": 0.6, "topP": 0.95, "topK": 20, ... },
  "parts": { "text-delta": 1247, "tool-call": 0 },
  "toolCalls": 0,
  "textChars": 1893,
  "suspicious": { "qwen_pipe_tool_call": 3, "qwen_thinking_open": 2 }
}
```

If `suspicious` has non-zero counts AND `toolCalls` is zero, the chat
template is still misconfigured. Re-check step 4 above.

## Reference

- [Qwen 3.6 27B model card](https://huggingface.co/Qwen/Qwen3.6-27B)
- [Fixed chat templates](https://huggingface.co/froggeric/Qwen-Fixed-Chat-Templates)
- [Unsloth Qwen 3.6 guide](https://unsloth.ai/docs/models/qwen3.6)
- [llama.cpp function calling docs](https://github.com/ggml-org/llama.cpp/blob/master/docs/function-calling.md)
