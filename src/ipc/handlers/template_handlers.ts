import log from "electron-log";
import fs from "node:fs";
import { generateObject } from "ai";
import { z } from "zod";
import { db } from "../../db";
import { getAllTemplates } from "../utils/template_utils";
import { localTemplatesData } from "../../shared/templates";
import { createTypedHandler } from "./base";
import { templateContracts } from "../types/templates";
import { getOrianBuilderAppPath } from "../../paths/paths";
import { readSettings } from "../../main/settings";
import { getModelClient } from "../utils/get_model_client";
import { autoSelectTemplate } from "../../lib/template_auto_select";

const logger = log.scope("template_handlers");

const templateSelectionModelSchema = z.object({
  templateId: z.string().trim().min(1),
  appName: z.string().trim().min(1).max(80),
  reason: z.string().trim().max(240),
});

const APP_NAME_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "app",
  "application",
  "basic",
  "build",
  "create",
  "develop",
  "for",
  "from",
  "having",
  "make",
  "me",
  "simple",
  "single",
  "that",
  "the",
  "to",
  "very",
  "with",
]);

function sanitizeAppName(value: string, fallback: string): string {
  const sanitized =
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/-{2,}/g, "-")
      .slice(0, 54)
      .replace(/-+$/g, "") || fallback;

  // Avoid Windows device names because the app name becomes a directory name.
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(sanitized)) {
    return `app-${sanitized}`;
  }
  return sanitized;
}

function fallbackNameFromPrompt(prompt: string, templateId: string): string {
  const tokens =
    prompt
      .toLowerCase()
      .match(/[a-z0-9]+/g)
      ?.filter((token) => token.length > 1 && !APP_NAME_STOPWORDS.has(token))
      .slice(0, 5) ?? [];

  if (tokens.length > 0) {
    return sanitizeAppName(tokens.join("-"), templateId);
  }

  return sanitizeAppName(`${templateId}-project`, "app-project");
}

async function makeUniqueAppName(baseName: string): Promise<string> {
  const records = await db.query.apps.findMany({
    columns: { name: true, path: true },
  });
  const used = new Set(records.flatMap((app) => [app.name, app.path]));
  let candidate = baseName;
  let suffix = 2;

  while (
    used.has(candidate) ||
    fs.existsSync(getOrianBuilderAppPath(candidate))
  ) {
    candidate = `${baseName}-${suffix}`;
    suffix += 1;
  }

  return candidate;
}

async function selectTemplateWithModel(input: {
  prompt: string;
  templates: typeof localTemplatesData;
  fallbackTemplateId: string;
}): Promise<{ templateId: string; appName: string; reason: string } | null> {
  try {
    const settings = readSettings();
    const { modelClient } = await getModelClient(
      settings.selectedModel,
      settings,
    );
    const templateList = input.templates
      .map(
        (template) =>
          `- ${template.id}: ${template.title}. ${template.description}`,
      )
      .join("\n");

    const result = await generateObject({
      model: modelClient.model,
      schema: templateSelectionModelSchema,
      maxRetries: 1,
      system: `Pick the best project template for the user's first prompt.
Return one templateId exactly from this list:
${templateList}

Rules:
- Choose "expo" for Android, iOS, APK, phone, mobile-native, or React Native requests unless the user explicitly wants only a responsive website.
- Choose "electron-app" for desktop, Windows, macOS, Linux, Electron, installer, or exe requests.
- Choose "react" for normal browser web apps when no more specific framework is requested.
- If uncertain, prefer the rule-based fallback candidate: "${input.fallbackTemplateId}".
- The appName must be a short, unique-looking, filesystem-safe lower-kebab name based on the prompt. Do not use random adjective-animal names.`,
      prompt: input.prompt,
    });

    return result.object;
  } catch (error) {
    logger.warn("Model template selection failed; using rule fallback", error);
    return null;
  }
}

export function registerTemplateHandlers() {
  createTypedHandler(templateContracts.getTemplates, async () => {
    try {
      const templates = await getAllTemplates();
      return templates;
    } catch (error) {
      logger.error("Error fetching templates:", error);
      return localTemplatesData;
    }
  });

  createTypedHandler(
    templateContracts.selectTemplateForPrompt,
    async (_, params) => {
      const templates = await getAllTemplates().catch((error) => {
        logger.warn("Error fetching templates for prompt selection:", error);
        return localTemplatesData;
      });
      const knownTemplateIds = new Set(
        templates.map((template) => template.id),
      );
      const fallbackTemplateId = autoSelectTemplate(params.prompt);
      const modelSelection = await selectTemplateWithModel({
        prompt: params.prompt,
        templates,
        fallbackTemplateId,
      });

      const modelTemplateId = modelSelection?.templateId;
      const templateId =
        modelTemplateId && knownTemplateIds.has(modelTemplateId)
          ? modelTemplateId
          : fallbackTemplateId;
      const source =
        modelTemplateId && knownTemplateIds.has(modelTemplateId)
          ? ("model" as const)
          : ("rules" as const);
      const appName = await makeUniqueAppName(
        sanitizeAppName(
          modelSelection?.appName ??
            fallbackNameFromPrompt(params.prompt, templateId),
          fallbackNameFromPrompt(params.prompt, templateId),
        ),
      );

      return {
        templateId,
        appName,
        source,
        reason:
          source === "model"
            ? (modelSelection?.reason ?? "Model selected the project template.")
            : `Matched the "${templateId}" template from prompt keywords.`,
      };
    },
  );
}
