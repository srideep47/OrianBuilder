import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import log from "electron-log";
import { createLoggedTypedHandler } from "./base";
import { readSettings } from "../../main/settings";
import { audioContracts } from "../types/audio";
import type { TranscribeAudioParams } from "../types/audio";
import { transcribeWithOrianBuilderEngine } from "../utils/llm_engine_provider";
import {
  MEDIA_AI_SERVER_URL,
  isMediaAiBackendHealthy,
} from "../utils/media_ai_backend";

const logger = log.scope("pro_handlers");
const typedHandle = createLoggedTypedHandler(logger);

const orianbuilderEngineUrl = process.env.ORIANBUILDER_ENGINE_URL;

async function transcribeViaLocalBackend(
  audioBuffer: Buffer,
  filename: string,
): Promise<string | null> {
  // Backend is started at app launch; just check current health — no blocking wait.
  if (!(await isMediaAiBackendHealthy())) {
    return null;
  }

  // Backend needs a real file path — write to temp, POST path, clean up.
  const tmpPath = path.join(
    os.tmpdir(),
    `orianbuilder-voice-${Date.now()}-${filename}`,
  );
  try {
    await fs.writeFile(tmpPath, audioBuffer);
    const res = await fetch(`${MEDIA_AI_SERVER_URL}/v1/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audio_path: tmpPath }),
    });
    if (!res.ok) {
      logger.warn(`local transcribe returned ${res.status}`);
      return null;
    }
    const data = (await res.json()) as { text?: string };
    return data.text?.trim() ?? null;
  } catch (err) {
    logger.warn("local transcribe failed:", err);
    return null;
  } finally {
    await fs.unlink(tmpPath).catch(() => {});
  }
}

async function transcribeWithOpenAIWhisper(
  audioBuffer: Buffer,
  filename: string,
  apiKey: string,
): Promise<string> {
  const formData = new FormData();
  const blob = new Blob([new Uint8Array(audioBuffer)], { type: "audio/webm" });
  formData.append("file", blob, filename);
  formData.append("model", "whisper-1");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });

  if (!res.ok) {
    throw new Error(`Whisper API error: HTTP ${res.status}`);
  }

  const data = (await res.json()) as { text?: string };
  return data.text?.trim() ?? "";
}

export function registerProHandlers() {
  typedHandle(
    audioContracts.transcribeAudio,
    async (_event, input: TranscribeAudioParams) => {
      const audioBuffer = Buffer.from(input.audioData);

      // 1. Local Whisper backend (offline, no API key needed)
      const localText = await transcribeViaLocalBackend(
        audioBuffer,
        input.filename,
      );
      if (localText !== null) {
        logger.info("transcribeAudio: used local Whisper backend");
        return { text: localText };
      }

      // 2. OrianBuilder Pro engine
      const settings = readSettings();
      const autoKey = settings.providerSettings?.auto?.apiKey?.value;
      if (autoKey) {
        const text = await transcribeWithOrianBuilderEngine(
          audioBuffer,
          input.filename,
          input.requestId,
          {
            apiKey: autoKey,
            baseURL:
              orianbuilderEngineUrl ?? "https://engine.orianbuilder.sh/v1",
            orianbuilderOptions: {},
            settings,
          },
        );
        return { text };
      }

      // 3. OpenAI Whisper API
      const openAiKey = settings.providerSettings?.openai?.apiKey?.value;
      if (openAiKey) {
        logger.info("transcribeAudio: using OpenAI Whisper");
        const text = await transcribeWithOpenAIWhisper(
          audioBuffer,
          input.filename,
          openAiKey,
        );
        return { text };
      }

      throw new Error(
        "Voice transcription unavailable. Install the local AI backend from the Media AI page, or add an OpenAI API key in Settings → Providers.",
      );
    },
  );
}
