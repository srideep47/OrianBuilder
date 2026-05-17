import { describe, expect, it } from "vitest";

import { detectModelFamily } from "./chat_wrapper_resolver";

describe("detectModelFamily", () => {
  it("lets Qwen 3.6 GGUFs use their embedded Jinja template", () => {
    const match = detectModelFamily("Qwen3.6-35B-A3B-Q4_K_M.gguf");

    expect(match.family).toBe("qwen");
    expect(match.label).toBe("Qwen 3.5/3.6 (GGUF Jinja template)");
    expect(match.build({} as never)).toBeNull();
  });

  it("keeps the specialized wrapper for older Qwen models", () => {
    class FakeQwenChatWrapper {}

    const match = detectModelFamily("Qwen2.5-Coder-32B-Instruct.gguf");

    expect(match.family).toBe("qwen");
    expect(
      match.build({
        QwenChatWrapper: FakeQwenChatWrapper,
      } as never),
    ).toBeInstanceOf(FakeQwenChatWrapper);
  });
});
