import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import log from "electron-log";

import { runningApps } from "@/ipc/utils/process_manager";
import { getAppPort } from "../../../../../../../shared/ports";
import { ORIANBUILDER_MEDIA_DIR_NAME } from "@/ipc/utils/media_path_utils";
import {
  AgentContext,
  escapeXmlAttr,
  escapeXmlContent,
  ToolDefinition,
} from "./types";

const logger = log.scope("browser_control");

const browserControlSchema = z.object({
  action: z.enum([
    "open",
    "snapshot",
    "click",
    "type",
    "press",
    "scroll",
    "eval",
    "screenshot",
  ]),
  url: z
    .string()
    .optional()
    .describe("Optional URL. Defaults to the managed preview URL."),
  selector: z
    .string()
    .optional()
    .describe("CSS selector for click, type, scroll, or element screenshot."),
  text: z.string().optional().describe("Text to type for the type action."),
  key: z.string().optional().describe("Keyboard key for the press action."),
  script: z
    .string()
    .optional()
    .describe("JavaScript expression/function body for the eval action."),
  full_page: z.boolean().optional().default(false),
  viewport_width: z.number().min(320).max(2560).optional().default(1280),
  viewport_height: z.number().min(240).max(1440).optional().default(800),
});

type BrowserControlArgs = z.infer<typeof browserControlSchema>;

export const browserControlTool: ToolDefinition<BrowserControlArgs> = {
  name: "browser_control",
  description: `Control and inspect the running app preview through one browser protocol.

Actions:
- open: load the managed preview URL and report page title/url
- snapshot: return a compact accessibility snapshot
- click/type/press/scroll: perform the interaction, then return a snapshot
- eval: run JavaScript in the page for focused diagnostics
- screenshot: capture a PNG, persist it under .orianbuilder/media, and attach it for visual reasoning

Use this for end-to-end UI verification when a screenshot alone is not enough. Prefer start_dev_server first so the managed preview URL is ready.`,
  inputSchema: browserControlSchema,
  defaultConsent: "ask",
  modifiesState: true,

  getConsentPreview: (args) =>
    `${args.action} browser preview${args.selector ? ` at ${args.selector}` : ""}`,

  buildXml: (args, isComplete) => {
    if (isComplete) return undefined;
    return `<orianbuilder-browser-action action="${escapeXmlAttr(args.action ?? "")}">Running browser action...`;
  },

  execute: async (args, ctx: AgentContext) => {
    logger.log(`browser_control: action=${args.action}, appId=${ctx.appId}`);
    const targetUrl = args.url ?? getPreviewUrl(ctx.appId);
    ctx.onXmlStream(
      `<orianbuilder-browser-action action="${escapeXmlAttr(args.action)}" url="${escapeXmlAttr(targetUrl)}">Running browser action...`,
    );

    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({
        viewport: {
          width: args.viewport_width ?? 1280,
          height: args.viewport_height ?? 800,
        },
      });
      await page.goto(targetUrl, { waitUntil: "networkidle", timeout: 15_000 });

      if (args.action === "click") {
        requireSelector(args);
        await page.locator(args.selector!).first().click();
      } else if (args.action === "type") {
        requireSelector(args);
        if (!args.text) throw new Error("text is required for type.");
        await page.locator(args.selector!).first().fill(args.text);
      } else if (args.action === "press") {
        if (!args.key) throw new Error("key is required for press.");
        await page.keyboard.press(args.key);
      } else if (args.action === "scroll") {
        if (args.selector) {
          await page.locator(args.selector).first().scrollIntoViewIfNeeded();
        } else {
          await page.mouse.wheel(0, args.viewport_height ?? 800);
        }
      } else if (args.action === "eval") {
        if (!args.script) throw new Error("script is required for eval.");
        const value = await page.evaluate((script) => {
          return Function(`"use strict"; return (${script});`)();
        }, args.script);
        return completeBrowserAction(ctx, args, targetUrl, {
          result: stringifyResult(value),
        });
      }

      if (args.action === "screenshot") {
        const screenshotBuffer = args.selector
          ? ((await page
              .locator(args.selector)
              .first()
              .screenshot({ type: "png" })) as Buffer)
          : ((await page.screenshot({
              type: "png",
              fullPage: args.full_page ?? false,
            })) as Buffer);
        const relativePath = await saveScreenshot(
          ctx.appPath,
          screenshotBuffer,
        );
        ctx.appendUserMessage([
          {
            type: "text",
            text: `Browser screenshot of ${targetUrl}:`,
          },
          {
            type: "image-url",
            url: `data:image/png;base64,${screenshotBuffer.toString("base64")}`,
          },
        ]);
        return completeBrowserAction(ctx, args, targetUrl, {
          path: relativePath,
          result: `Screenshot saved to ${relativePath}.`,
        });
      }

      const snapshot =
        args.action === "open"
          ? `Title: ${await page.title()}\nURL: ${page.url()}`
          : await page.locator("body").ariaSnapshot({ ref: false } as any);
      return completeBrowserAction(ctx, args, targetUrl, {
        result: snapshot || "(empty browser snapshot)",
      });
    } finally {
      await browser.close();
    }
  },
};

function getPreviewUrl(appId: number): string {
  const info = runningApps.get(appId);
  if (info?.proxyUrl) return info.proxyUrl;
  if (info?.originalUrl) return info.originalUrl;
  return `http://localhost:${getAppPort(appId)}`;
}

function requireSelector(args: BrowserControlArgs) {
  if (!args.selector) {
    throw new Error(`selector is required for ${args.action}.`);
  }
}

async function saveScreenshot(appPath: string, screenshotBuffer: Buffer) {
  const mediaDir = path.join(appPath, ORIANBUILDER_MEDIA_DIR_NAME);
  await fs.mkdir(mediaDir, { recursive: true });
  const hash = crypto.randomBytes(6).toString("hex");
  const fileName = `browser-${Date.now()}-${hash}.png`;
  const filePath = path.join(mediaDir, fileName);
  const relativePath = path.join(ORIANBUILDER_MEDIA_DIR_NAME, fileName);
  await fs.writeFile(filePath, screenshotBuffer);
  return relativePath;
}

function completeBrowserAction(
  ctx: AgentContext,
  args: BrowserControlArgs,
  targetUrl: string,
  output: { result: string; path?: string },
) {
  ctx.onXmlComplete(
    `<orianbuilder-browser-action action="${escapeXmlAttr(args.action)}" url="${escapeXmlAttr(targetUrl)}" path="${escapeXmlAttr(output.path ?? "")}">${escapeXmlContent(output.result)}</orianbuilder-browser-action>`,
  );
  return output.result;
}

function stringifyResult(value: unknown) {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value, null, 2);
}
