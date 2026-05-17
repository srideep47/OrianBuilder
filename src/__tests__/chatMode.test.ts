import { describe, expect, it } from "vitest";
import { normalizeStoredChatMode, resolveChatMode } from "@/lib/chatMode";
import type { UserSettings } from "@/lib/schemas";

function makeSettings(overrides: Partial<UserSettings> = {}): UserSettings {
  return {
    selectedModel: { provider: "auto", name: "auto" },
    providerSettings: {},
    selectedTemplateId: "react",
    enableAutoUpdate: true,
    releaseChannel: "stable",
    ...overrides,
  } as UserSettings;
}

describe("chat mode resolution", () => {
  it("migrates deprecated agent mode to build", () => {
    expect(normalizeStoredChatMode("agent")).toBe("build");
  });

  it("uses the effective default when a chat has no stored mode", () => {
    const settings = makeSettings({ defaultChatMode: "ask" });

    expect(
      resolveChatMode({
        storedChatMode: null,
        settings,
        envVars: {},
      }),
    ).toEqual({ mode: "ask" });
  });

  it("uses a stored mode when it is available", () => {
    const settings = makeSettings({ defaultChatMode: "build" });

    expect(
      resolveChatMode({
        storedChatMode: "plan",
        settings,
        envVars: {},
      }),
    ).toEqual({ mode: "plan" });
  });

  it("local-agent mode is always available regardless of provider", () => {
    const settings = makeSettings({ defaultChatMode: "build" });

    expect(
      resolveChatMode({
        storedChatMode: "local-agent",
        settings,
        envVars: {},
      }),
    ).toEqual({ mode: "local-agent" });
  });

  it("local-agent mode is always available regardless of quota", () => {
    const settings = makeSettings({
      defaultChatMode: "build",
      providerSettings: {
        openai: { apiKey: { value: "test-key" } },
      },
    });

    expect(
      resolveChatMode({
        storedChatMode: "local-agent",
        settings,
        envVars: {},
        freeAgentQuotaAvailable: false,
      }),
    ).toEqual({ mode: "local-agent" });
  });

  it("does not treat unknown quota as exhausted", () => {
    const settings = makeSettings({
      defaultChatMode: "build",
      providerSettings: {
        openai: { apiKey: { value: "test-key" } },
      },
    });

    expect(
      resolveChatMode({
        storedChatMode: "local-agent",
        settings,
        envVars: {},
        freeAgentQuotaAvailable: undefined,
      }),
    ).toEqual({ mode: "local-agent" });
  });
});
