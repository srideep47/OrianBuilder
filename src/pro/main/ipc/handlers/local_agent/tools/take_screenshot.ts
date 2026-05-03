import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import log from "electron-log";
import { ToolDefinition, AgentContext, escapeXmlAttr } from "./types";
import { DyadError, DyadErrorKind } from "@/errors/dyad_error";
import { runningApps } from "@/ipc/utils/process_manager";
import { getAppPort } from "../../../../../../../shared/ports";
import { DYAD_MEDIA_DIR_NAME } from "@/ipc/utils/media_path_utils";
import { db } from "@/db";
import { chats } from "@/db/schema";
import { eq } from "drizzle-orm";

const logger = log.scope("take_screenshot");

const takeScreenshotSchema = z.object({
  full_page: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "Capture the full scrollable page height (default: false = viewport only).",
    ),
  element_selector: z
    .string()
    .optional()
    .describe(
      "Optional CSS selector. When provided, scrolls to and captures only that element instead of the whole viewport.",
    ),
  viewport_width: z
    .number()
    .min(320)
    .max(2560)
    .optional()
    .default(1280)
    .describe("Viewport width in pixels (default: 1280)."),
  viewport_height: z
    .number()
    .min(240)
    .max(1440)
    .optional()
    .default(800)
    .describe("Viewport height in pixels (default: 800)."),
});

type TakeScreenshotArgs = z.infer<typeof takeScreenshotSchema>;

function getPreviewUrl(appId: number): string {
  const info = runningApps.get(appId);
  // Prefer the proxy URL if the proxy is running (avoids auth issues)
  if (info?.proxyUrl) return info.proxyUrl;
  if (info?.originalUrl) return info.originalUrl;
  return `http://localhost:${getAppPort(appId)}`;
}

async function captureScreenshot(
  url: string,
  args: TakeScreenshotArgs,
): Promise<Buffer> {
  // Playwright is already in package.json; import dynamically to avoid
  // bundling it unconditionally into the main process bundle.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { chromium } = await import("playwright");

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: {
        width: args.viewport_width ?? 1280,
        height: args.viewport_height ?? 800,
      },
    });

    // Navigate and wait until network is idle (app has finished loading)
    await page.goto(url, { waitUntil: "networkidle", timeout: 15_000 });

    let screenshotBuffer: Buffer;

    if (args.element_selector) {
      const element = page.locator(args.element_selector).first();
      await element.scrollIntoViewIfNeeded();
      screenshotBuffer = (await element.screenshot({ type: "png" })) as Buffer;
    } else {
      screenshotBuffer = (await page.screenshot({
        type: "png",
        fullPage: args.full_page ?? false,
      })) as Buffer;
    }

    return screenshotBuffer;
  } finally {
    await browser.close();
  }
}

export const takeScreenshotTool: ToolDefinition<TakeScreenshotArgs> = {
  name: "take_screenshot",
  description: `Take a screenshot of the running app preview and return it as an image.

### When to use
- After writing UI code — visually verify the layout matches what the user described
- Debugging layout/styling issues: invisible elements, overflow, misaligned components
- Verifying responsive behaviour at different viewport sizes
- Confirming a UI bug is fixed before reporting back to the user

### What you receive
A PNG screenshot rendered at the specified viewport size (default 1280×800).
You can see colours, layout, text, and component positions to reason about visual correctness.

### Tips
- Use \`element_selector\` to zoom in on a specific component (e.g. ".card", "#hero", "nav")
- Use \`full_page: true\` to capture content below the fold
- Call this AFTER the dev server has reloaded with your changes (allow ~2s after edits)`,

  inputSchema: takeScreenshotSchema,
  defaultConsent: "always",

  getConsentPreview: (_args) => "Take screenshot of app preview",

  buildXml: (_args, isComplete) => {
    if (isComplete) return undefined;
    return `<dyad-screenshot>Capturing…`;
  },

  execute: async (args, ctx: AgentContext) => {
    logger.log(`take_screenshot: appId=${ctx.appId}`);

    const chat = await db.query.chats.findFirst({
      where: eq(chats.id, ctx.chatId),
      with: { app: true },
    });

    if (!chat?.app) {
      throw new DyadError(
        "App not found for this chat.",
        DyadErrorKind.NotFound,
      );
    }

    const appId = chat.app.id;
    const previewUrl = getPreviewUrl(appId);

    ctx.onXmlStream(
      `<dyad-screenshot url="${escapeXmlAttr(previewUrl)}">Capturing…`,
    );

    let screenshotBuffer: Buffer;
    try {
      screenshotBuffer = await captureScreenshot(previewUrl, args);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.onXmlComplete(
        `<dyad-screenshot url="${escapeXmlAttr(previewUrl)}" error="${escapeXmlAttr(msg)}"></dyad-screenshot>`,
      );
      throw new DyadError(
        `Screenshot failed: ${msg}. Make sure the app is running and the preview is accessible at ${previewUrl}.`,
        DyadErrorKind.External,
      );
    }

    // Save to .dyad/media so the renderer can display it
    const mediaDir = path.join(ctx.appPath, DYAD_MEDIA_DIR_NAME);
    await fs.mkdir(mediaDir, { recursive: true });
    const hash = crypto.randomBytes(6).toString("hex");
    const fileName = `screenshot-${Date.now()}-${hash}.png`;
    const filePath = path.join(mediaDir, fileName);
    const relativePath = path.join(DYAD_MEDIA_DIR_NAME, fileName);
    await fs.writeFile(filePath, screenshotBuffer);

    const base64 = screenshotBuffer.toString("base64");

    // Append the image as a follow-up user message so vision-capable models can see it
    ctx.appendUserMessage([
      {
        type: "text",
        text: `Screenshot of the app preview at ${previewUrl}${args.element_selector ? ` (element: ${args.element_selector})` : ""}:`,
      },
      { type: "image-url", url: `data:image/png;base64,${base64}` },
    ]);

    ctx.onXmlComplete(
      `<dyad-screenshot url="${escapeXmlAttr(previewUrl)}" path="${escapeXmlAttr(relativePath)}"></dyad-screenshot>`,
    );

    logger.log(`take_screenshot: saved to ${relativePath}`);
    return `Screenshot captured and saved to ${relativePath}. I can now see the rendered output — analyzing it to identify any visual issues.`;
  },
};
