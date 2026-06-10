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
import { generateImageViaCloud } from "@/main/ipc/utils/cloud_image_generator";
import { generateImageViaLocalBackend } from "@/main/ipc/utils/local_image_generator";
import { initMediaDispatcher } from "@/main/ipc/utils/media_dispatcher";
import { readSettings } from "@/main/settings";
import { resolveSelection } from "@/shared/orion_media_catalog";

const logger = log.scope("generate_image");

/** The user's selected image model (Orion Media Models), or undefined to let
 *  the backend pick by VRAM. */
function selectedImageTier(): string | undefined {
  try {
    return resolveSelection(readSettings().orionMediaModels).image;
  } catch {
    return undefined;
  }
}

const generateImageSchema = z.object({
  prompt: z
    .string()
    .describe(
      "A detailed, descriptive prompt for the image to generate. Be specific about colors, composition, style, mood, and subject matter. Avoid generic or vague descriptions.",
    ),
});

const DESCRIPTION = `Generate an image using AI based on a text prompt. The generated image is saved to the project's .orianbuilder/media directory.

### When to Use
- User requests a custom image, illustration, icon, or graphic for their app
- User wants a hero image, background, banner, or visual asset
- Creating images that are more visually relevant than placeholder rectangles

### Prompt Guidelines
Write detailed, descriptive prompts. Be specific about:
- **Subject**: What is in the image (objects, people, scenes)
- **Style**: Photography, illustration, flat design, 3D render, watercolor, etc.
- **Composition**: Layout, perspective, framing
- **Colors**: Specific color palette or mood
- **Mood**: Cheerful, professional, dramatic, minimal, etc.

### Examples
- "A modern flat illustration of a team collaborating around a laptop, using a blue and purple color palette, clean minimal style with subtle gradients, white background"
- "Professional product photography of a sleek smartphone on a marble surface, soft studio lighting, shallow depth of field, warm neutral tones"

### After Generation
The tool returns the file path in .orianbuilder/media. Use the copy_file tool to copy it to the appropriate location in the project (e.g., public/assets/) and reference that path in your code.
`;

async function reserveOutputPath(appPath: string): Promise<{
  absolutePath: string;
  relativePath: string;
}> {
  const mediaDir = path.join(appPath, ORIANBUILDER_MEDIA_DIR_NAME);
  await fs.mkdir(mediaDir, { recursive: true });
  const hash = crypto.randomBytes(8).toString("hex");
  const fileName = `generated-${Date.now()}-${hash}.png`;
  return {
    absolutePath: path.join(mediaDir, fileName),
    relativePath: path.join(ORIANBUILDER_MEDIA_DIR_NAME, fileName),
  };
}

export const generateImageTool: ToolDefinition<
  z.infer<typeof generateImageSchema>
> = {
  name: "generate_image",
  description: DESCRIPTION,
  inputSchema: generateImageSchema,
  defaultConsent: "always",
  modifiesState: true,

  getConsentPreview: (args) => `Generate image: "${args.prompt}"`,

  buildXml: (args, isComplete) => {
    if (!args.prompt) return undefined;
    if (isComplete) return undefined;
    return `<orianbuilder-image-generation prompt="${escapeXmlAttr(args.prompt)}">`;
  },

  execute: async (args, ctx: AgentContext) => {
    logger.log(`Executing image generation with prompt: ${args.prompt}`);

    ctx.onXmlStream(
      `<orianbuilder-image-generation prompt="${escapeXmlAttr(args.prompt)}">`,
    );

    const { absolutePath, relativePath } = await reserveOutputPath(ctx.appPath);

    try {
      const orch = getOrchestrator();
      const llmIsLoaded = ensureLlmSwapForMedia();

      let success = false;
      let errMessage: string | undefined;

      const tier = selectedImageTier();

      if (llmIsLoaded) {
        // Drive through the orchestrator so the embedded LLM is unloaded
        // before generation and reloaded after. The orchestrator's media
        // provider (initialized via initMediaDispatcher) handles the actual
        // image synthesis. The selected model wins over VRAM-based tiering.
        initMediaDispatcher();
        const result = await orch.runMediaGeneration({
          modelType: "image",
          prompt: args.prompt,
          outputPath: absolutePath,
          modelId: tier,
        });
        success = result.success;
        errMessage = result.error;
      } else {
        // No embedded LLM is loaded — no swap needed. Try local Python
        // backend first (with the selected model), then cloud.
        const local = await generateImageViaLocalBackend(
          args.prompt,
          absolutePath,
          { tier },
        );
        if (local.success) {
          success = true;
        } else {
          const cloud = await generateImageViaCloud(args.prompt, absolutePath);
          success = cloud.success;
          errMessage = cloud.error ?? local.error;
        }
      }

      if (!success) {
        throw new OrianBuilderError(
          errMessage ??
            "Image generation failed. Configure an OpenAI API key in Settings → Providers, or wait for local image generation to come online.",
          OrianBuilderErrorKind.External,
        );
      }

      ctx.onXmlComplete(
        `<orianbuilder-image-generation prompt="${escapeXmlAttr(args.prompt)}" path="${escapeXmlAttr(relativePath)}">${escapeXmlContent(relativePath)}</orianbuilder-image-generation>`,
      );

      logger.log(`Image generation completed, saved to: ${relativePath}`);

      return `Image generated and saved to: ${relativePath}\nUse the copy_file tool to copy it from "${relativePath}" to the appropriate location in the project (e.g., public/assets/), then reference the copied path in your code.`;
    } catch (error) {
      ctx.onXmlComplete(
        `<orianbuilder-image-generation prompt="${escapeXmlAttr(args.prompt)}"></orianbuilder-image-generation>`,
      );
      throw error;
    }
  },
};
