import { z } from "zod";
import log from "electron-log";
import {
  ToolDefinition,
  AgentContext,
  escapeXmlAttr,
  escapeXmlContent,
} from "./types";
import { DyadError, DyadErrorKind } from "@/errors/dyad_error";
import { runningApps } from "@/ipc/utils/process_manager";
import { getAppPort } from "../../../../../../../shared/ports";
import { db } from "@/db";
import { chats } from "@/db/schema";
import { eq } from "drizzle-orm";

const logger = log.scope("get_accessibility_tree");

const MAX_TREE_CHARS = 30_000;

const getAccessibilityTreeSchema = z.object({
  root_selector: z
    .string()
    .optional()
    .describe(
      "Optional CSS selector to limit the tree to a subtree (e.g. 'main', '#sidebar'). Omit to get the full page tree.",
    ),
  interesting_only: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "When true (default), only returns nodes Playwright considers 'interesting' (visible, interactive). Set false for the full tree including generic containers.",
    ),
});

type GetAccessibilityTreeArgs = z.infer<typeof getAccessibilityTreeSchema>;

function getPreviewUrl(appId: number): string {
  const info = runningApps.get(appId);
  if (info?.proxyUrl) return info.proxyUrl;
  if (info?.originalUrl) return info.originalUrl;
  return `http://localhost:${getAppPort(appId)}`;
}

export const getAccessibilityTreeTool: ToolDefinition<GetAccessibilityTreeArgs> =
  {
    name: "get_accessibility_tree",
    description: `Get the accessibility tree of the running app preview — a structured text representation of the UI.

The accessibility tree describes every visible, interactive element: buttons, links, inputs, headings, images, and their labels. It is far more compact and token-efficient than a screenshot while still giving you a precise understanding of the page structure.

### When to use
- Understand the structure of a rendered page (headings, navigation, form fields)
- Verify that elements exist and have correct labels/roles
- Debug missing or broken UI elements without needing pixels
- Check interactive state: which buttons are disabled, which checkboxes are checked, which accordion is expanded
- Confirm aria labels and accessibility before reporting the task complete

### When to prefer take_screenshot instead
- You need to verify colours, spacing, layout, or visual styling
- The user explicitly wants visual verification

### Tips
- Use \`root_selector\` to narrow scope: \`"nav"\`, \`"form"\`, \`"#sidebar"\`, \`".modal"\`
- Set \`interesting_only: false\` only when debugging missing elements that might be filtered out`,

    inputSchema: getAccessibilityTreeSchema,
    defaultConsent: "always",

    getConsentPreview: (_args) => "Get accessibility tree of app preview",

    buildXml: (_args, isComplete) => {
      if (isComplete) return undefined;
      return `<dyad-accessibility-tree>Reading…`;
    },

    execute: async (args, ctx: AgentContext) => {
      logger.log(`get_accessibility_tree: appId=${ctx.appId}`);

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
        `<dyad-accessibility-tree url="${escapeXmlAttr(previewUrl)}">Reading…`,
      );

      let treeText: string;
      try {
        const { chromium } = await import("playwright");
        const browser = await chromium.launch({ headless: true });
        try {
          const page = await browser.newPage({
            viewport: { width: 1280, height: 800 },
          });
          await page.goto(previewUrl, {
            waitUntil: "networkidle",
            timeout: 15_000,
          });

          let snapshot: string;

          const selector = args.root_selector ?? "body";
          const el = page.locator(selector).first();
          snapshot = await el.ariaSnapshot({ ref: false } as any);

          treeText = snapshot ?? "(empty accessibility tree)";
        } finally {
          await browser.close();
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.onXmlComplete(
          `<dyad-accessibility-tree url="${escapeXmlAttr(previewUrl)}" error="${escapeXmlAttr(msg)}"></dyad-accessibility-tree>`,
        );
        throw new DyadError(
          `Accessibility tree failed: ${msg}. Ensure the app is running at ${previewUrl}.`,
          DyadErrorKind.External,
        );
      }

      // Truncate if very large
      if (treeText.length > MAX_TREE_CHARS) {
        treeText =
          treeText.slice(0, MAX_TREE_CHARS) +
          "\n\n... [tree truncated — use root_selector to narrow scope]";
      }

      const header = `Accessibility tree of ${previewUrl}${args.root_selector ? ` (root: ${args.root_selector})` : ""}:\n\n`;
      const output = header + treeText;

      ctx.onXmlComplete(
        `<dyad-accessibility-tree url="${escapeXmlAttr(previewUrl)}">${escapeXmlContent(output)}</dyad-accessibility-tree>`,
      );

      logger.log(`get_accessibility_tree: done (${treeText.length} chars)`);
      return output;
    },
  };
