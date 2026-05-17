import { describe, expect, it } from "vitest";
import { autoSelectTemplate } from "./template_auto_select";

describe("autoSelectTemplate", () => {
  it("selects Expo for explicit Android app prompts", () => {
    expect(
      autoSelectTemplate("Create a basic Android app with Hello World"),
    ).toBe("expo");
  });

  it("selects Electron for desktop app prompts", () => {
    expect(autoSelectTemplate("Build a Windows desktop app for notes")).toBe(
      "electron-app",
    );
  });
});
