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

const logger = log.scope("auto_implement");

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

  let raw: string;
  try {
    const result = await generateText({
      model: params.model,
      system: SYSTEM_PROMPT,
      prompt: `User request: ${params.userPrompt.trim().slice(0, 800)}\n\nGenerate the full contents of app/index.tsx now.`,
      maxRetries: 2,
      temperature: 0.2,
    });
    raw = result.text ?? "";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`Auto-implement generation failed: ${message}`);
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
