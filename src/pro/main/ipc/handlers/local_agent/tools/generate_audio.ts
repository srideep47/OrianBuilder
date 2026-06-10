import { z } from "zod";
import log from "electron-log";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import {
  ToolDefinition,
  AgentContext,
  escapeXmlAttr,
  escapeXmlContent,
} from "./types";
import { ORIANBUILDER_MEDIA_DIR_NAME } from "@/ipc/utils/media_path_utils";
import {
  OrianBuilderError,
  OrianBuilderErrorKind,
} from "@/errors/orianbuilder_error";
import { getOrchestrator } from "@/main/ipc/utils/model_orchestrator";
import { ensureLlmSwapForMedia } from "@/main/ipc/utils/media_llm_guard";
import { generateAudioViaLocalBackend } from "@/main/ipc/utils/local_audio_generator";
import { initMediaDispatcher } from "@/main/ipc/utils/media_dispatcher";
import { readSettings } from "@/main/settings";
import { resolveSelection } from "@/shared/orion_media_catalog";

const logger = log.scope("generate_audio");

/** The user's selected speech (TTS) model (Orion Media Models), or undefined. */
function selectedSpeechTier(): string | undefined {
  try {
    return resolveSelection(readSettings().orionMediaModels).speech;
  } catch {
    return undefined;
  }
}

const generateAudioSchema = z.object({
  text: z
    .string()
    .describe(
      "The text to synthesize as speech. Punctuation is honored (e.g. periods => pauses, ? => rising intonation).",
    ),
  voice: z
    .string()
    .optional()
    .describe(
      "Optional voice identifier or speaker reference (e.g. a Piper voice model path, or 'en-US-female'). Backend-specific; omit to use the default.",
    ),
});

const DESCRIPTION = `Generate speech audio (WAV) from a text prompt using the local media backend. The file is saved to the project's .orianbuilder/media directory.

### When to Use
- User requests narration, voice-over, button-press audio, or any synthesized speech
- Creating audio assets for an app's content

### Backends
- XTTS-v2 (when GPU VRAM >= 3 GB) — best quality
- Piper TTS — CPU-fast fallback
The orchestrator picks automatically based on available VRAM.

### After Generation
The tool returns the file path in .orianbuilder/media. Use the copy_file tool to copy it to the appropriate location (e.g., public/audio/) and reference it in your code.
`;

async function reserveOutputPath(appPath: string): Promise<{
  absolutePath: string;
  relativePath: string;
}> {
  const mediaDir = path.join(appPath, ORIANBUILDER_MEDIA_DIR_NAME);
  await fs.mkdir(mediaDir, { recursive: true });
  const hash = crypto.randomBytes(8).toString("hex");
  const fileName = `tts-${Date.now()}-${hash}.wav`;
  return {
    absolutePath: path.join(mediaDir, fileName),
    relativePath: path.join(ORIANBUILDER_MEDIA_DIR_NAME, fileName),
  };
}

export const generateAudioTool: ToolDefinition<
  z.infer<typeof generateAudioSchema>
> = {
  name: "generate_audio",
  description: DESCRIPTION,
  inputSchema: generateAudioSchema,
  defaultConsent: "always",
  modifiesState: true,

  getConsentPreview: (args) =>
    `Generate audio: "${args.text.slice(0, 80)}${args.text.length > 80 ? "…" : ""}"`,

  buildXml: (args, isComplete) => {
    if (!args.text) return undefined;
    if (isComplete) return undefined;
    return `<orianbuilder-audio-generation text="${escapeXmlAttr(args.text)}">`;
  },

  execute: async (args, ctx: AgentContext) => {
    logger.log(`Executing audio generation (len=${args.text.length})`);
    ctx.onXmlStream(
      `<orianbuilder-audio-generation text="${escapeXmlAttr(args.text)}">`,
    );

    const { absolutePath, relativePath } = await reserveOutputPath(ctx.appPath);

    try {
      const orch = getOrchestrator();
      const llmIsLoaded = ensureLlmSwapForMedia();

      let success = false;
      let errMessage: string | undefined;

      const tier = selectedSpeechTier();

      if (llmIsLoaded) {
        initMediaDispatcher();
        const result = await orch.runMediaGeneration({
          modelType: "audio",
          prompt: args.text,
          outputPath: absolutePath,
          modelId: tier,
          options: args.voice ? { voice: args.voice } : undefined,
        });
        success = result.success;
        errMessage = result.error;
      } else {
        const local = await generateAudioViaLocalBackend(
          args.text,
          absolutePath,
          { voice: args.voice, tier },
        );
        success = local.success;
        errMessage = local.error;
      }

      if (!success) {
        throw new OrianBuilderError(
          errMessage ??
            "Audio generation failed. Install the local media backend dependencies for your hardware on the Engine page.",
          OrianBuilderErrorKind.External,
        );
      }

      ctx.onXmlComplete(
        `<orianbuilder-audio-generation text="${escapeXmlAttr(args.text)}" path="${escapeXmlAttr(relativePath)}">${escapeXmlContent(relativePath)}</orianbuilder-audio-generation>`,
      );

      logger.log(`Audio generation completed, saved to: ${relativePath}`);
      return `Audio generated and saved to: ${relativePath}\nUse the copy_file tool to copy it from "${relativePath}" to the appropriate location (e.g., public/audio/), then reference it in your code.`;
    } catch (error) {
      ctx.onXmlComplete(
        `<orianbuilder-audio-generation text="${escapeXmlAttr(args.text)}"></orianbuilder-audio-generation>`,
      );
      throw error;
    }
  },
};
