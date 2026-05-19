/**
 * Voice Assistant Utility Functions
 * Core logic ported from React Native Voice Assistant app
 * Handles conversation processing and assistant reply generation
 */

/**
 * Build assistant reply based on user input
 * Implements simple pattern matching for common queries
 * Can be extended with LLM integration in the future
 */
export function buildAssistantReply(input: string): string {
  const normalizedInput = input.toLowerCase().trim();

  if (!normalizedInput) {
    return "I did not catch anything yet. Try asking a short question.";
  }

  if (normalizedInput.includes("weather")) {
    return "I cannot fetch live weather yet, but I can help once weather data is connected. For now, it sounds like you want a weather update.";
  }

  if (normalizedInput.includes("time")) {
    return `The current time on your device is ${new Date().toLocaleTimeString()}.`;
  }

  if (
    normalizedInput.includes("hello") ||
    normalizedInput.includes("hi") ||
    normalizedInput.includes("hey")
  ) {
    return "Hello. I am ready to listen and reply. Ask me anything you want to test.";
  }

  if (normalizedInput.includes("name")) {
    return "I am your voice assistant. You can speak to me with the mic button and replay my answer with the sound button.";
  }

  if (
    normalizedInput.includes("stop") ||
    normalizedInput.includes("silent") ||
    normalizedInput.includes("quiet")
  ) {
    return "You can stop playback at any time with the stop button in the bottom dock.";
  }

  return `You said: "${input}". I heard you clearly, and the speech pipeline is working. Tap the sound button if you want me to read this reply aloud.`;
}

/**
 * Voice state enum for tracking recording/speaking/processing status
 */
export enum VoiceState {
  IDLE = "idle",
  LISTENING = "listening",
  PROCESSING = "processing",
  SPEAKING = "speaking",
}

/**
 * Voice assistant context interface
 */
export interface VoiceAssistantContext {
  userText: string;
  assistantText: string;
  state: VoiceState;
  statusMessage: string;
}

/**
 * Initial voice assistant context
 */
export const getInitialVoiceContext = (): VoiceAssistantContext => ({
  userText: "",
  assistantText: "",
  state: VoiceState.IDLE,
  statusMessage: "Ready to listen.",
});

/**
 * Voice assistant response builder with extended features
 * Can integrate with OpenAI, Claude, or other LLMs
 */
export interface AssistantReplyOptions {
  useLLM?: boolean;
  llmModel?: string;
  customRules?: Array<{
    pattern: RegExp;
    response: string;
  }>;
}

/**
 * Build assistant reply with optional LLM support
 * Falls back to pattern matching if LLM is unavailable
 */
export function buildAssistantReplyWithOptions(
  input: string,
  options?: AssistantReplyOptions,
): string {
  // TODO: Integrate with LLM when needed
  // For now, use pattern matching
  if (options?.customRules) {
    for (const rule of options.customRules) {
      if (rule.pattern.test(input)) {
        return rule.response;
      }
    }
  }

  return buildAssistantReply(input);
}

/**
 * Check if a string is a valid voice command
 */
export function isValidVoiceCommand(input: string): boolean {
  return input.trim().length > 0;
}

/**
 * Format voice assistant error messages
 */
export function formatVoiceError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "An unknown error occurred.";
}
