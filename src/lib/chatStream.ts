const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
export const EMBEDDED_MODEL_URL = "http://127.0.0.1:11435/v1/chat/completions";
export const PROXY_MODEL_URL = "http://127.0.0.1:11436/v1/chat/completions";

const FALLBACK_FREE_MODELS = [
  "meta-llama/llama-3.3-70b-instruct:free",
  "qwen/qwen3-14b:free",
  "google/gemma-3-27b-it:free",
  "microsoft/phi-4-reasoning:free",
  "deepseek/deepseek-r1-0528:free",
];

let _cachedFreeModels: string[] | null = null;

export async function getOpenRouterFreeModels(
  apiKey: string,
): Promise<string[]> {
  if (_cachedFreeModels) return _cachedFreeModels;
  try {
    const res = await fetch(OPENROUTER_MODELS_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return FALLBACK_FREE_MODELS;

    const data = (await res.json()) as {
      data: Array<{
        id: string;
        context_length?: number;
        pricing?: { prompt?: string | number };
      }>;
    };

    const free = data.data
      .filter((m) => {
        const p = String(m.pricing?.prompt ?? "");
        return p === "0" || m.id.endsWith(":free") || m.id.endsWith("/free");
      })
      .sort((a, b) => (b.context_length ?? 0) - (a.context_length ?? 0))
      .map((m) => m.id)
      .slice(0, 8);

    _cachedFreeModels = free.length > 0 ? free : FALLBACK_FREE_MODELS;
    return _cachedFreeModels;
  } catch {
    return FALLBACK_FREE_MODELS;
  }
}

export interface StreamCallbacks {
  onChunk: (delta: string) => void;
  onEnd: () => void;
  onError: (msg: string) => void;
}

export async function consumeSSEStream(
  response: Response,
  callbacks: StreamCallbacks,
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) {
    callbacks.onError("No response body received.");
    return;
  }
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === "data: [DONE]") continue;
        if (trimmed.startsWith("data: ")) {
          try {
            const json = JSON.parse(trimmed.slice(6));
            const delta = json.choices?.[0]?.delta?.content;
            if (typeof delta === "string" && delta) callbacks.onChunk(delta);
          } catch {
            // skip malformed SSE line
          }
        }
      }
    }
    callbacks.onEnd();
  } catch (err: unknown) {
    if ((err as { name?: string })?.name !== "AbortError") {
      callbacks.onError(
        (err as { message?: string })?.message ?? "Stream read error.",
      );
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Stream a chat response.
 * Priority: OpenRouter free models (discovered live) → local/remote model.
 *
 * Pass localModelUrl to override the default embedded server URL — use
 * PROXY_MODEL_URL (port 11436) when a remote peer is the compute target.
 */
export async function streamChatResponse(
  messages: { role: string; content: string }[],
  openRouterApiKey: string | undefined,
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
  localModelUrl: string = EMBEDDED_MODEL_URL,
): Promise<void> {
  if (openRouterApiKey) {
    const freeModels = await getOpenRouterFreeModels(openRouterApiKey);

    for (const model of freeModels) {
      let response: Response;
      try {
        response = await fetch(OPENROUTER_CHAT_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${openRouterApiKey}`,
            "HTTP-Referer": "https://orianbuilder.com",
            "X-Title": "OrianBuilder",
          },
          body: JSON.stringify({
            model,
            messages,
            stream: true,
            max_tokens: 1024,
          }),
          signal,
        });
      } catch (err: unknown) {
        if ((err as { name?: string })?.name === "AbortError") return;
        continue;
      }

      if (response.ok) {
        return consumeSSEStream(response, callbacks);
      }
    }
  }

  let localResponse: Response;
  try {
    localResponse = await fetch(localModelUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "local",
        messages,
        stream: true,
        temperature: 0.7,
        max_tokens: 1024,
      }),
      signal,
    });
  } catch (err: unknown) {
    if ((err as { name?: string })?.name === "AbortError") return;
    callbacks.onError(
      openRouterApiKey
        ? "All OpenRouter free models are currently unavailable. Please try again in a moment."
        : "No AI provider configured. Add an OpenRouter API key in Settings → Engine, or load a local model in Settings → Local AI.",
    );
    return;
  }

  if (!localResponse.ok) {
    callbacks.onError(
      localModelUrl === PROXY_MODEL_URL
        ? "Remote compute device is not responding. Make sure the device is online and has a model loaded in the Engine screen."
        : "Local AI model is not loaded. Go to Engine screen and load a model.",
    );
    return;
  }

  return consumeSSEStream(localResponse, callbacks);
}
