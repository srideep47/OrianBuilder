import { describe, expect, it } from "vitest";

import { detectModelFamily } from "./chat_wrapper_resolver";

describe("detectModelFamily", () => {
  it("uses QwenChatWrapper variation 3.5 for Qwen 3.6 GGUFs", () => {
    // Was previously returning null to fall back to the embedded Jinja
    // template, but that template uses `|items` which the C++ Jinja engine
    // in llama.cpp can't parse — tool calls and thinking blocks leaked as
    // raw text. node-llama-cpp's QwenChatWrapper handles the format natively.
    class FakeQwenChatWrapper {
      constructor(public opts: unknown) {}
    }

    const match = detectModelFamily("Qwen3.6-35B-A3B-Q4_K_M.gguf");

    expect(match.family).toBe("qwen");
    expect(match.label).toBe("Qwen 3.5/3.6 (QwenChatWrapper variation 3.5)");
    const wrapper = match.build({
      QwenChatWrapper: FakeQwenChatWrapper,
    } as never) as unknown as FakeQwenChatWrapper;
    expect(wrapper).toBeInstanceOf(FakeQwenChatWrapper);
    expect(wrapper.opts).toMatchObject({
      variation: "3.5",
      keepOnlyLastThought: false,
    });
  });

  it("uses QwenChatWrapper variation 3 for older Qwen models", () => {
    class FakeQwenChatWrapper {
      constructor(public opts: unknown) {}
    }

    const match = detectModelFamily("Qwen2.5-Coder-32B-Instruct.gguf");

    expect(match.family).toBe("qwen");
    const wrapper = match.build({
      QwenChatWrapper: FakeQwenChatWrapper,
    } as never) as unknown as FakeQwenChatWrapper;
    expect(wrapper).toBeInstanceOf(FakeQwenChatWrapper);
    expect(wrapper.opts).toMatchObject({ variation: "3" });
  });
});
