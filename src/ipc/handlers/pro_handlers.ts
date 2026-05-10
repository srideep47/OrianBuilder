import log from "electron-log";
import { createLoggedTypedHandler } from "./base";
import { readSettings } from "../../main/settings";
import { audioContracts } from "../types/audio";
import type { TranscribeAudioParams } from "../types/audio";
import { transcribeWithOrianBuilderEngine } from "../utils/llm_engine_provider";

const logger = log.scope("pro_handlers");
const typedHandle = createLoggedTypedHandler(logger);

const orianbuilderEngineUrl = process.env.ORIANBUILDER_ENGINE_URL;

export function registerProHandlers() {
  typedHandle(
    audioContracts.transcribeAudio,
    async (_event, input: TranscribeAudioParams) => {
      const settings = readSettings();
      const apiKey = settings.providerSettings?.auto?.apiKey?.value;

      if (!apiKey) {
        throw new Error(
          "No API key configured. Voice-to-text requires an API key in provider settings.",
        );
      }

      const audioBuffer = Buffer.from(input.audioData);

      const text = await transcribeWithOrianBuilderEngine(
        audioBuffer,
        input.filename,
        input.requestId,
        {
          apiKey,
          baseURL: orianbuilderEngineUrl ?? "https://engine.orianbuilder.sh/v1",
          orianbuilderOptions: {},
          settings,
        },
      );

      return { text };
    },
  );
}
