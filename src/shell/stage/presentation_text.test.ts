import { describe, expect, it } from "vitest";

import { sanitizeAssistantPresentation } from "./presentation_text";

describe("assistant presentation boundary", () => {
  it("removes complete and partial tool protocol frames", () => {
    expect(
      sanitizeAssistantPresentation(
        "I am checking. <tool_call><function=marta_listTasks /></tool_call> All clear.",
      ),
    ).toBe("I am checking.  All clear.");
    expect(
      sanitizeAssistantPresentation(
        "Working now.\n<tool_call><function=app_searchFiles />",
      ),
    ).toBe("Working now.");
  });

  it("omits internal instruction lines but keeps normal narration", () => {
    expect(
      sanitizeAssistantPresentation(
        "SYSTEM: never show this\nI handed the task to Claude.\nInternal prompt: hidden",
      ),
    ).toBe("I handed the task to Claude.");
  });
});
