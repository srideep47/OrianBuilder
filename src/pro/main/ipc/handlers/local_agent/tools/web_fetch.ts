import { z } from "zod";
import log from "electron-log";
import { ToolDefinition, escapeXmlContent, AgentContext } from "./types";
import { DyadError, DyadErrorKind } from "@/errors/dyad_error";

const logger = log.scope("web_fetch");

function validateHttpUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new DyadError(`Invalid URL: ${url}`, DyadErrorKind.Validation);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Unsupported URL scheme "${parsed.protocol}" — only http and https are allowed`,
    );
  }
}

const MAX_CONTENT_LENGTH = 80_000;

function truncateContent(value: string): string {
  if (value.length <= MAX_CONTENT_LENGTH) return value;
  return `${value.slice(0, MAX_CONTENT_LENGTH)}\n\n<!-- truncated -->`;
}

// Convert raw HTML to readable plain text without any external deps.
// Strips scripts, styles, and tags; collapses whitespace.
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function fetchPageAsText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; OrianBuilder/1.0; +https://github.com/LegionStudios)",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    redirect: "follow",
  });

  if (!response.ok) {
    throw new DyadError(
      `Web fetch failed: ${response.status} ${response.statusText}`,
      DyadErrorKind.External,
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();

  if (contentType.includes("text/html") || contentType.includes("xhtml")) {
    return htmlToText(text);
  }

  // Plain text, JSON, markdown — return as-is
  return text;
}

const webFetchSchema = z.object({
  url: z.string().describe("URL to fetch content from"),
});

const DESCRIPTION = `Fetch and read the content of a web page as text given its URL.

### When to Use This Tool
Use this tool when the user's message contains a URL (or domain name) and they want to:
- **Read** the page's content (e.g. documentation, blog post, article)
- **Reference** information from the page (e.g. API docs, tutorials, guides)
- **Extract** data or context from a live web page to inform their code
- **Follow a link** someone shared to understand its contents

Examples:
- "Use the docs at docs.example.com/api to set up the client"
- "What does this page say? https://example.com/blog/post"
- "Follow the guide at example.com/tutorial"

### When NOT to Use This Tool
- The user wants to **visually clone or replicate** a website → use \`web_crawl\` instead
- The user needs to **search the web** for information without a specific URL → use \`web_search\` instead
`;

export const webFetchTool: ToolDefinition<z.infer<typeof webFetchSchema>> = {
  name: "web_fetch",
  description: DESCRIPTION,
  inputSchema: webFetchSchema,
  defaultConsent: "always",

  getConsentPreview: (args) => `Fetch URL: "${args.url}"`,

  buildXml: (args, isComplete) => {
    if (!args.url) return undefined;
    if (isComplete) return undefined;
    return `<dyad-web-fetch>${escapeXmlContent(args.url)}`;
  },

  execute: async (args, ctx: AgentContext) => {
    logger.log(`Executing web fetch: ${args.url}`);

    validateHttpUrl(args.url);

    ctx.onXmlStream(`<dyad-web-fetch>${escapeXmlContent(args.url)}`);

    try {
      const content = await fetchPageAsText(args.url);

      if (!content) {
        throw new DyadError(
          "Web fetch returned no content",
          DyadErrorKind.NotFound,
        );
      }

      logger.log(`Web fetch completed for URL: ${args.url}`);

      ctx.onXmlComplete(
        `<dyad-web-fetch>${escapeXmlContent(args.url)}</dyad-web-fetch>`,
      );

      return truncateContent(content);
    } catch (error) {
      ctx.onXmlComplete(
        `<dyad-web-fetch>${escapeXmlContent(args.url)}</dyad-web-fetch>`,
      );
      throw error;
    }
  },
};
