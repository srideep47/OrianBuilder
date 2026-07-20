import type { CapabilityId, CommandIntent, FlowStep } from "@/ipc/types/intent";

const CREATION_ACTION =
  /\b(generate|create|make|render|produce|draw|paint|compose|synthesize|animate|design|give me|i (?:want|need|would like)|can you|could you|would you|please)\b/i;
const NEGATED_CREATION =
  /\b(?:do not|don't|dont|never|stop|avoid)\s+(?:\w+\s+){0,2}(?:generate|create|make|render|produce)\b/i;
const INFORMATION_QUESTION =
  /^\s*(?:how|what|why|which|where|when|who)\b|^\s*(?:explain|tell me|help me understand|show me how)\b/i;
const BUILD_TARGET =
  /\b(app|application|website|web site|site|webpage|web page|landing page|page|frontend|front-end|backend|back-end|dashboard|api|component|code|project|repository|repo|screen|form|button)\b/i;

const MEDIA_TARGETS: Array<{
  capability: Extract<
    CapabilityId,
    | "generate_image"
    | "generate_video"
    | "generate_audio"
    | "generate_music"
    | "generate_3d_asset"
  >;
  pattern: RegExp;
}> = [
  {
    capability: "generate_3d_asset",
    pattern:
      /\b(3d|3-d|three[- ]dimensional|glb|gltf|meshes?|3d models?|3d assets?|game assets?)\b/i,
  },
  {
    capability: "generate_music",
    pattern:
      /\b(music|songs?|soundtracks?|beats?|melodies|jingles?|tunes?|instrumentals?|background scores?)\b/i,
  },
  {
    capability: "generate_audio",
    pattern:
      /\b(audio|voices?|voiceovers?|voice-overs?|narrations?|speech|spoken dialogues?|tts|sound effects?|sfx)\b/i,
  },
  {
    capability: "generate_video",
    pattern:
      /\b(videos?|animations?|animated clips?|movies?|trailers?|reels?|short films?|cinematic clips?)\b/i,
  },
  {
    capability: "generate_image",
    pattern:
      /\b(images?|pictures?|photos?|photographs?|illustrations?|posters?|banners?|wallpapers?|thumbnails?|logos?|icons?|artworks?|concept art|cover art|sprites?|textures?|graphics?)\b/i,
  },
];

function boundedNumber(
  value: string | undefined,
  minimum: number,
  maximum: number,
): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return Math.min(maximum, Math.max(minimum, parsed));
}

/** Extract only controls the user expressed in natural language. */
export function extractNaturalMediaOptions(
  text: string,
): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  const dimensions = text.match(/\b(\d{3,5})\s*[x×]\s*(\d{3,5})\b/i);
  const width = boundedNumber(dimensions?.[1], 256, 4096);
  const height = boundedNumber(dimensions?.[2], 256, 4096);
  if (width && height) {
    options.width = width;
    options.height = height;
  }

  const explicitAspect = text.match(
    /\b(?:aspect(?: ratio)?\s*)?(1:1|16:9|9:16|4:3|3:4|21:9)\b/i,
  )?.[1];
  if (explicitAspect) {
    options.aspect_ratio = explicitAspect;
  } else if (/\bsquare\b/i.test(text)) {
    options.aspect_ratio = "1:1";
  } else if (/\b(vertical|portrait)\b/i.test(text)) {
    options.aspect_ratio = "9:16";
  } else if (/\b(widescreen|landscape)\b/i.test(text)) {
    options.aspect_ratio = "16:9";
  }

  const duration = text.match(
    /\b(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|sec)\b/i,
  )?.[1];
  const durationSeconds = boundedNumber(duration, 1, 300);
  if (durationSeconds) options.duration_s = durationSeconds;

  const steps = text.match(/\b(\d{1,3})\s*(?:sampling\s+)?steps\b/i)?.[1];
  const samplingSteps = boundedNumber(steps, 1, 150);
  if (samplingSteps) options.steps = samplingSteps;

  const guidance = text.match(
    /\b(?:guidance|cfg)(?:\s+scale)?\s*(?:of|:|=)?\s*(\d+(?:\.\d+)?)\b/i,
  )?.[1];
  const guidanceScale = boundedNumber(guidance, 0, 30);
  if (guidanceScale !== undefined) options.guidance = guidanceScale;

  const seed = text.match(/\bseed\s*(?:of|:|=)?\s*(\d+)\b/i)?.[1];
  const parsedSeed = boundedNumber(seed, 0, 2_147_483_647);
  if (parsedSeed !== undefined) options.seed = parsedSeed;

  if (
    /\b(best|highest|high[- ]quality|production[- ]quality|ultra)\b/i.test(text)
  ) {
    options.quality = "high";
  } else if (/\b(draft|preview|quick|fast)\b/i.test(text)) {
    options.quality = "draft";
  }

  const without = text.match(/\bwithout\s+([^.;,!]{2,120})/i)?.[1]?.trim();
  if (without) options.negative_prompt = without;

  return options;
}

function requestedVariationCount(text: string): number {
  const match = text.match(
    /\b(\d{1,2})\s+(?:[\w-]+\s+){0,4}(?:images?|pictures?|photos?|variations?|versions?)\b/i,
  );
  return boundedNumber(match?.[1], 1, 8) ?? 1;
}

/**
 * Return an executable intent only for an unambiguous media-creation command.
 * Questions and software/UI edits deliberately fall through to the agent.
 */
export function parseDirectMediaCommand(
  text: string,
  appId?: number,
): CommandIntent | null {
  const command = text.trim();
  if (
    !command ||
    command.startsWith("/") ||
    NEGATED_CREATION.test(command) ||
    INFORMATION_QUESTION.test(command) ||
    !CREATION_ACTION.test(command) ||
    BUILD_TARGET.test(command)
  ) {
    return null;
  }

  const capabilities = MEDIA_TARGETS.filter(({ pattern }) =>
    pattern.test(command),
  ).map(({ capability }) => capability);
  if (capabilities.length === 0) return null;

  const options = extractNaturalMediaOptions(command);
  const steps: FlowStep[] = [];
  const wantsImage = capabilities.includes("generate_image");
  const imageCount = wantsImage ? requestedVariationCount(command) : 0;

  for (let index = 0; index < imageCount; index += 1) {
    steps.push({
      id: `image-${index + 1}`,
      capability: "generate_image",
      description:
        imageCount > 1
          ? `Generate image variation ${index + 1}`
          : "Generate the requested image",
      input: { prompt: command, options },
    });
  }

  for (const capability of capabilities) {
    if (capability === "generate_image") continue;
    if (capability === "generate_3d_asset") {
      const referenceId = steps.find(
        (step) => step.capability === "generate_image",
      )?.id;
      const imageStepId = referenceId ?? "image-reference";
      if (!referenceId) {
        steps.push({
          id: imageStepId,
          capability: "generate_image",
          description: "Generate a reference image for the 3D asset",
          input: { prompt: command, options },
        });
      }
      steps.push({
        id: "3d-asset-1",
        capability,
        description: "Generate the requested 3D asset",
        input: { prompt: command, options },
        dependsOn: [imageStepId],
      });
      continue;
    }

    steps.push({
      id: `${capability.replace("generate_", "")}-1`,
      capability,
      description: `Generate the requested ${capability.replace("generate_", "")}`,
      input: { prompt: command, options },
    });
  }

  return {
    goal: command,
    appId,
    constraints: { media: { options } },
    steps,
  };
}
