import { describe, it, expect } from "vitest";
import {
  buildAssistantReply,
  buildAssistantReplyWithOptions,
  isValidVoiceCommand,
  formatVoiceError,
  VoiceState,
  getInitialVoiceContext,
} from "@/lib/voiceAssistant";

describe("voiceAssistant utilities", () => {
  describe("buildAssistantReply", () => {
    it("should handle empty input", () => {
      const result = buildAssistantReply("");
      expect(result).toBe("I did not catch anything yet. Try asking a short question.");
    });

    it("should handle whitespace-only input", () => {
      const result = buildAssistantReply("   ");
      expect(result).toBe("I did not catch anything yet. Try asking a short question.");
    });

    it("should respond to weather queries", () => {
      const result = buildAssistantReply("what is the weather");
      expect(result).toContain("weather data");
    });

    it("should respond to time queries", () => {
      const result = buildAssistantReply("what time is it");
      expect(result).toContain("current time");
    });

    it("should respond to greeting queries", () => {
      const result = buildAssistantReply("hello");
      expect(result).toContain("Hello");
    });

    it("should respond to name queries", () => {
      const result = buildAssistantReply("what is your name");
      expect(result).toContain("voice assistant");
    });

    it("should respond to stop commands", () => {
      const result = buildAssistantReply("stop");
      expect(result).toContain("stop button");
    });

    it("should echo unknown input", () => {
      const input = "something unknown";
      const result = buildAssistantReply(input);
      expect(result).toContain("You said");
      expect(result).toContain(input);
    });

    it("should be case-insensitive", () => {
      const result1 = buildAssistantReply("HELLO");
      const result2 = buildAssistantReply("hello");
      expect(result1).toBe(result2);
    });
  });

  describe("buildAssistantReplyWithOptions", () => {
    it("should apply custom rules", () => {
      const customRules = [
        {
          pattern: /test/i,
          response: "Custom test response",
        },
      ];

      const result = buildAssistantReplyWithOptions("this is a test", {
        customRules,
      });

      expect(result).toBe("Custom test response");
    });

    it("should fallback to default pattern matching if no custom rules match", () => {
      const customRules = [
        {
          pattern: /nonexistent/i,
          response: "Should not appear",
        },
      ];

      const result = buildAssistantReplyWithOptions("hello", {
        customRules,
      });

      expect(result).toContain("Hello");
    });
  });

  describe("isValidVoiceCommand", () => {
    it("should return true for non-empty strings", () => {
      expect(isValidVoiceCommand("hello")).toBe(true);
    });

    it("should return false for empty strings", () => {
      expect(isValidVoiceCommand("")).toBe(false);
    });

    it("should return false for whitespace-only strings", () => {
      expect(isValidVoiceCommand("   ")).toBe(false);
    });

    it("should trim whitespace before validation", () => {
      expect(isValidVoiceCommand("  hello  ")).toBe(true);
    });
  });

  describe("formatVoiceError", () => {
    it("should format Error objects", () => {
      const error = new Error("Test error");
      expect(formatVoiceError(error)).toBe("Test error");
    });

    it("should format string errors", () => {
      expect(formatVoiceError("String error")).toBe("String error");
    });

    it("should handle unknown error types", () => {
      expect(formatVoiceError({})).toBe("An unknown error occurred.");
    });
  });

  describe("VoiceState enum", () => {
    it("should have all expected states", () => {
      expect(VoiceState.IDLE).toBe("idle");
      expect(VoiceState.LISTENING).toBe("listening");
      expect(VoiceState.PROCESSING).toBe("processing");
      expect(VoiceState.SPEAKING).toBe("speaking");
    });
  });

  describe("getInitialVoiceContext", () => {
    it("should return initial context with correct defaults", () => {
      const context = getInitialVoiceContext();

      expect(context.userText).toBe("");
      expect(context.assistantText).toBe("");
      expect(context.state).toBe(VoiceState.IDLE);
      expect(context.statusMessage).toBe("Ready to listen.");
    });

    it("should return a new object each call", () => {
      const context1 = getInitialVoiceContext();
      const context2 = getInitialVoiceContext();

      expect(context1).not.toBe(context2);
      expect(context1).toEqual(context2);
    });
  });
});
