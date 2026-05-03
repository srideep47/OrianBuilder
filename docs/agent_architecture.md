# Agent Architecture

Orian Builder uses a full tool-calling agent loop for its local agent mode. Instead of the earlier pseudo tool-calling strategy (custom XML tags), the agent now uses the model's native function-calling capabilities, which enables parallel tool calls and easier extensibility.

## Core loop

The heart of the local agent is `src/pro/main/ipc/handlers/local_agent/local_agent_handler.ts`. It implements the agent loop:

1. Send the current context + user message to the LLM with the available tool schemas.
2. Execute any tool calls the LLM requests (in parallel where possible).
3. Append tool results and loop back to step 1.
4. Stop when the LLM produces a response with no tool calls, or when the maximum step count for the turn is reached.

Tool definitions live in `src/pro/main/ipc/handlers/local_agent/tool_definitions.ts`.

## Add a tool

1. Create a new tool file in `src/pro/main/ipc/handlers/local_agent/tools/`. Use an existing tool as a template.
2. Import the tool and add it to `src/pro/main/ipc/handlers/local_agent/tool_definitions.ts`.
3. Define how to render the corresponding `<dyad-$tool-name>` tag inside `src/components/chat/DyadMarkdownParser.tsx` — typically by creating a new React component for the tag.

## Testing

E2E tests for the local agent are in `e2e-tests/` and named like `local_agent*.spec.ts`.

Tool-call testing fixtures live at `e2e-tests/fixtures/engine/` and let you simulate a tool call response without hitting a real LLM.

## Local model support

The agent loop is backend-agnostic. It calls an OpenAI-compatible `/v1/chat/completions` endpoint. When the embedded inference engine is active (llama.cpp or TensorRT backend), the loop routes requests to the local server at `http://localhost:<port>/v1`. Tool calling works with any local model that supports the `tools` parameter in the chat completion API.

> **Note:** The TensorRT backend does not yet implement tool-call JSON parsing. For agentic workflows requiring tool calling, use the llama.cpp backend.
