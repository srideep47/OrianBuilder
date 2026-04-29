import { registerOllamaHandlers } from "./local_model_ollama_handler";
import { registerLMStudioHandlers } from "./local_model_lmstudio_handler";
import { registerEmbeddedLocalModelHandlers } from "./local_model_embedded_handler";

export function registerLocalModelHandlers() {
  registerOllamaHandlers();
  registerLMStudioHandlers();
  registerEmbeddedLocalModelHandlers();
}
