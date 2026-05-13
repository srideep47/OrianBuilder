/**
 * Last-resort one-shot code generator for Expo `app/index.tsx`.
 *
 * Why this exists: weak local models (Qwen3-27B-Q4 class) can call tools
 * once but fail at multi-step agentic plans. They'll call `create_project`,
 * see the working baseline, and then emit "I'll create..." prose forever
 * without actually issuing a `write_file`. After our follow-up loop has
 * given the agent multiple chances and it still hasn't customized, we stop
 * asking and do the work ourselves: ask the same model to *just* complete
 * the file content for the user's prompt — no tool plumbing, no agent loop,
 * just code completion which models are much better at.
 *
 * If the generated code is invalid or empty, we leave the baseline alone
 * so the pipeline still ships *something* working.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { generateText, type LanguageModel } from "ai";
import log from "electron-log";
import { waitForInferenceFree } from "@/ipc/utils/embedded_inference_server";

const logger = log.scope("auto_implement");

function isBusyError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const message = err.message ?? "";
  // The embedded server returns HTTP 429 with body
  // `{"error":{"message":"Inference busy — one request at a time","type":"busy"}}`.
  // Vercel AI SDK preserves the message text in the thrown error.
  return /inference busy|one request at a time|\b429\b/i.test(message);
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

const SYSTEM_PROMPT = `You are a React Native code generator for Expo Router projects.

Output ONLY the complete TypeScript contents of \`app/index.tsx\`. No prose, no explanation, no preamble.
Wrap the code in a single \`\`\`tsx ... \`\`\` fence.

Hard rules:
- Import from "react" and "react-native" ONLY. Do not import anything else (no expo-router, no third-party libraries).
- Default-export a function component named HomeScreen with no props.
- Use a top-level View with flex: 1 and padding so the layout works on phone and desktop.
- For lists of items longer than 5 rows, use ScrollView so content can scroll.
- Use StyleSheet.create at the bottom of the file for all styles. No inline style objects.
- Render concrete, fully-implemented UI. No placeholders, no TODO comments, no "..." in JSX.
- No external images, no fetch calls, no async work — just the UI the user asked for.
- The first character of your output must be three backticks. The last character must be three backticks. Nothing outside the fence.`;

const TSX_FENCE_RE = /```(?:tsx|jsx|typescript|ts)?\s*([\s\S]*?)```/i;

function extractTsx(raw: string): string | null {
  if (!raw) return null;
  const match = raw.match(TSX_FENCE_RE);
  const code = match ? match[1] : raw;
  const trimmed = code.trim();
  if (!trimmed) return null;
  // Sanity-check: must default-export a component and import react-native.
  if (!/export\s+default\s+function\s+/.test(trimmed)) return null;
  if (!/from\s+["']react-native["']/.test(trimmed)) return null;
  return trimmed.endsWith("\n") ? trimmed : `${trimmed}\n`;
}

export interface AutoImplementParams {
  appPath: string;
  userPrompt: string;
  model: LanguageModel;
}

export interface AutoImplementResult {
  success: boolean;
  wrote: boolean;
  reason: string;
  bytes: number;
}

export async function autoImplementAppIndex(
  params: AutoImplementParams,
): Promise<AutoImplementResult> {
  const indexPath = path.join(params.appPath, "app", "index.tsx");

  // The embedded inference server enforces "one request at a time" and
  // returns HTTP 429 to concurrent /v1/chat/completions calls. After the
  // agent's streamText finishes there's a short window before the server's
  // isInferring flag clears — calling generateText too eagerly here will
  // collide with that window. Wait for it to clear first, then retry on
  // 429 with backoff (in case it didn't clear in time).
  const freedInTime = await waitForInferenceFree(15_000);
  if (!freedInTime) {
    logger.warn(
      "Auto-implement: inference server still busy after 15s; will attempt anyway",
    );
  }

  let raw = "";
  let lastError: unknown = null;
  const MAX_ATTEMPTS = 6;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const result = await generateText({
        model: params.model,
        system: SYSTEM_PROMPT,
        prompt: `User request: ${params.userPrompt.trim().slice(0, 800)}\n\nGenerate the full contents of app/index.tsx now.`,
        maxRetries: 0, // we handle retries ourselves below
        temperature: 0.2,
      });
      raw = result.text ?? "";
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
      if (!isBusyError(err) || attempt === MAX_ATTEMPTS) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn(
          `Auto-implement generation failed on attempt ${attempt}/${MAX_ATTEMPTS}: ${message}`,
        );
        break;
      }
      const backoffMs = Math.min(500 * 2 ** (attempt - 1), 4_000);
      logger.warn(
        `Auto-implement attempt ${attempt}/${MAX_ATTEMPTS} hit inference-busy; waiting ${backoffMs}ms then retrying`,
      );
      // Wait for the server to be free, then add a small jitter so two
      // simultaneous retry waves don't sync up against each other.
      await waitForInferenceFree(backoffMs);
      await delay(50 + Math.floor(Math.random() * 100));
    }
  }

  if (lastError) {
    const message =
      lastError instanceof Error ? lastError.message : String(lastError);
    return { success: false, wrote: false, reason: message, bytes: 0 };
  }

  const code = extractTsx(raw);
  if (!code) {
    logger.warn(
      "Auto-implement output did not parse to valid React Native code; leaving baseline in place",
    );
    return {
      success: false,
      wrote: false,
      reason: "Generated output failed validation",
      bytes: 0,
    };
  }

  try {
    await fs.writeFile(indexPath, code, "utf-8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Auto-implement write failed: ${message}`);
    return { success: false, wrote: false, reason: message, bytes: 0 };
  }

  logger.info(
    `Auto-implement wrote ${code.length} bytes to app/index.tsx for prompt: ${params.userPrompt.slice(0, 80)}`,
  );
  return {
    success: true,
    wrote: true,
    reason: "ok",
    bytes: code.length,
  };
}
