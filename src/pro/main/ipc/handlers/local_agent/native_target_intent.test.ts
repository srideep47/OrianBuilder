import { describe, expect, it } from "vitest";
import {
  buildNativeTargetReminder,
  detectNativeTargetIntent,
  nativeTargetIntentFromClassification,
} from "./native_target_intent";

describe("native target intent", () => {
  it("detects Android app prompts as APK targets", () => {
    expect(
      detectNativeTargetIntent("build a android to list app"),
    ).toMatchObject({
      target: "android_apk",
      label: "Android APK",
    });
    expect(detectNativeTargetIntent("make me a todo APK")).toMatchObject({
      target: "android_apk",
      label: "Android APK",
    });
  });

  it("detects desktop app prompts separately", () => {
    expect(
      detectNativeTargetIntent("build an electron todo app"),
    ).toMatchObject({
      target: "electron_desktop",
      label: "desktop app",
    });
  });

  it("does not detect normal web prompts", () => {
    expect(detectNativeTargetIntent("build a todo list web app")).toBeNull();
  });

  it("builds a packaging reminder with an explicit tool target", () => {
    expect(
      buildNativeTargetReminder({
        target: "android_apk",
        label: "Android APK",
      }),
    ).toContain('target="android_apk"');
  });

  it("maps confident model classifications to native targets", () => {
    expect(
      nativeTargetIntentFromClassification({
        target: "android_apk",
        confidence: 0.82,
      }),
    ).toMatchObject({
      target: "android_apk",
      source: "model",
    });
  });

  it("ignores low-confidence model classifications", () => {
    expect(
      nativeTargetIntentFromClassification({
        target: "android_apk",
        confidence: 0.4,
      }),
    ).toBeNull();
  });
});
