import { generateObject, type LanguageModel } from "ai";
import { z } from "zod";

export type NativeTargetIntent = {
  target: "android_apk" | "electron_desktop";
  label: string;
  source?: "rules" | "model";
  confidence?: number;
};

const ANDROID_PATTERNS = [
  /\bandroid\b/i,
  /\bapk\b/i,
  /\baab\b/i,
  /\bplay\s+store\b/i,
  /\bmobile\s+app\b/i,
  /\bphone\s+app\b/i,
];

const DESKTOP_PATTERNS = [
  /\belectron\b/i,
  /\bdesktop\s+app\b/i,
  /\bdesktop\s+installer\b/i,
  /\bwindows\s+(app|installer|exe)\b/i,
  /\bmac(os)?\s+(app|dmg)\b/i,
  /\blinux\s+(app|appimage|deb|rpm)\b/i,
];

export function detectNativeTargetIntent(
  prompt: string,
): NativeTargetIntent | null {
  if (ANDROID_PATTERNS.some((pattern) => pattern.test(prompt))) {
    return { target: "android_apk", label: "Android APK", source: "rules" };
  }

  if (DESKTOP_PATTERNS.some((pattern) => pattern.test(prompt))) {
    return {
      target: "electron_desktop",
      label: "desktop app",
      source: "rules",
    };
  }

  return null;
}

const classificationSchema = z.object({
  target: z.enum(["web_app", "android_apk", "electron_desktop", "unknown"]),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(240),
});

function shouldClassifyWithModel(prompt: string): boolean {
  return /\b(app|build|create|make|develop|generate|package|deploy|install|download|phone|mobile|native|todo|to[-\s]?do)\b/i.test(
    prompt,
  );
}

export function nativeTargetIntentFromClassification(input: {
  target: "web_app" | "android_apk" | "electron_desktop" | "unknown";
  confidence: number;
}): NativeTargetIntent | null {
  if (input.confidence < 0.65) return null;
  if (input.target === "android_apk") {
    return {
      target: "android_apk",
      label: "Android APK",
      source: "model",
      confidence: input.confidence,
    };
  }
  if (input.target === "electron_desktop") {
    return {
      target: "electron_desktop",
      label: "desktop app",
      source: "model",
      confidence: input.confidence,
    };
  }
  return null;
}

export async function detectNativeTargetIntentWithModel(input: {
  prompt: string;
  model: LanguageModel;
}): Promise<NativeTargetIntent | null> {
  const rulesIntent = detectNativeTargetIntent(input.prompt);
  if (rulesIntent) return rulesIntent;
  if (!shouldClassifyWithModel(input.prompt)) return null;

  try {
    const result = await generateObject({
      model: input.model,
      schema: classificationSchema,
      maxRetries: 1,
      system:
        "Classify the user's software build request. Return android_apk only when the user wants a real Android/mobile native app or APK, not merely mobile-responsive styling. Return electron_desktop only for desktop installers/apps. Return web_app for normal websites/web apps.",
      prompt: input.prompt,
    });
    return nativeTargetIntentFromClassification(result.object);
  } catch {
    return null;
  }
}

export function buildNativeTargetReminder(intent: NativeTargetIntent): string {
  const artifact =
    intent.target === "android_apk"
      ? "an Android APK and native-download-site/"
      : "a desktop installer/archive and native-download-site/";

  return `[System] The user's current request targets a native ${intent.label}. Do not treat this as only a responsive web UI or visual style request. Build the app UI, verify it, then package ${artifact} before you claim the task is complete. Use package_native_artifact with target="${intent.target}". If this is an Android request and the project is Expo/React Native, build through its native android/ Gradle project; if it is only Vite/React/web, initialize Capacitor and create the android/ project before finalizing. If native packaging fails, inspect and fix the project/dependency/build issue and retry instead of asking the user to press Rebuild or Restart.`;
}
