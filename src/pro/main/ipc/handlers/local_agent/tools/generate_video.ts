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
import { generateVideoViaLocalBackend } from "@/main/ipc/utils/local_video_generator";
import { initMediaDispatcher } from "@/main/ipc/utils/media_dispatcher";

const logger = log.scope("generate_video");

const generateVideoSchema = z.object({
  prompt: z
    .string()
    .describe(
      "A detailed prompt describing the video to generate. Be specific about subject, action, style, camera movement, and mood.",
    ),
});

const DESCRIPTION = `Generate a short text-to-video clip using the local media backend. The file is saved to the project's .orianbuilder/media directory.

### When to Use
- User requests a short animated clip, video background, or motion graphic
- Creating dynamic visual content for an app

### Backends (orchestrator picks by VRAM)
- LTX-Video (~12 GB VRAM) — highest quality
- Stable Video Diffusion (~8 GB VRAM) — good quality
- CPU text-to-video — slow fallback (shorter clips, lower resolution)

Video generation is slow even on GPUs. Expect ~30s+ for short clips.

### After Generation
The tool returns the file path in .orianbuilder/media. Use the copy_file tool to move it to the appropriate location (e.g., public/videos/) and reference it in your code.
`;

async function reserveOutputPath(appPath: string): Promise<{
  absolutePath: string;
  relativePath: string;
}> {
  const mediaDir = path.join(appPath, ORIANBUILDER_MEDIA_DIR_NAME);
  await fs.mkdir(mediaDir, { recursive: true });
  const hash = crypto.randomBytes(8).toString("hex");
  const fileName = `video-${Date.now()}-${hash}.mp4`;
  return {
    absolutePath: path.join(mediaDir, fileName),
    relativePath: path.join(ORIANBUILDER_MEDIA_DIR_NAME, fileName),
  };
}

export const generateVideoTool: ToolDefinition<
  z.infer<typeof generateVideoSchema>
> = {
  name: "generate_video",
  description: DESCRIPTION,
  inputSchema: generateVideoSchema,
  defaultConsent: "always",
  modifiesState: true,

  getConsentPreview: (args) => `Generate video: "${args.prompt}"`,

  buildXml: (args, isComplete) => {
    if (!args.prompt) return undefined;
    if (isComplete) return undefined;
    return `<orianbuilder-video-generation prompt="${escapeXmlAttr(args.prompt)}">`;
  },

  execute: async (args, ctx: AgentContext) => {
    logger.log(`Executing video generation with prompt: ${args.prompt}`);
    ctx.onXmlStream(
      `<orianbuilder-video-generation prompt="${escapeXmlAttr(args.prompt)}">`,
    );

    const { absolutePath, relativePath } = await reserveOutputPath(ctx.appPath);

    try {
      const orch = getOrchestrator();
      const llmIsLoaded = orch.getStatus().state === "llm-loaded";

      let success = false;
      let errMessage: string | undefined;

      if (llmIsLoaded) {
        initMediaDispatcher();
        const result = await orch.runMediaGeneration({
          modelType: "video",
          prompt: args.prompt,
          outputPath: absolutePath,
        });
        success = result.success;
        errMessage = result.error;
      } else {
        const local = await generateVideoViaLocalBackend(
          args.prompt,
          absolutePath,
        );
        success = local.success;
        errMessage = local.error;
      }

      if (!success) {
        throw new OrianBuilderError(
          errMessage ??
            "Video generation failed. Install the local media backend dependencies for your hardware on the Engine page.",
          OrianBuilderErrorKind.External,
        );
      }

      ctx.onXmlComplete(
        `<orianbuilder-video-generation prompt="${escapeXmlAttr(args.prompt)}" path="${escapeXmlAttr(relativePath)}">${escapeXmlContent(relativePath)}</orianbuilder-video-generation>`,
      );

      logger.log(`Video generation completed, saved to: ${relativePath}`);
      return `Video generated and saved to: ${relativePath}\nUse the copy_file tool to copy it from "${relativePath}" to the appropriate location (e.g., public/videos/), then reference it in your code.`;
    } catch (error) {
      ctx.onXmlComplete(
        `<orianbuilder-video-generation prompt="${escapeXmlAttr(args.prompt)}"></orianbuilder-video-generation>`,
      );
      throw error;
    }
  },
};
