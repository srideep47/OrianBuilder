import { z } from "zod";
import log from "electron-log";
import { ToolDefinition, escapeXmlContent, AgentContext } from "./types";
import { DyadError, DyadErrorKind } from "@/errors/dyad_error";

const logger = log.scope("web_crawl");

const webCrawlSchema = z.object({
  url: z.string().describe("URL to crawl"),
});

export const webCrawlResponseSchema = z.object({
  rootUrl: z.string(),
  html: z.string().optional(),
  markdown: z.string().optional(),
  screenshot: z.string().optional(),
});

const DESCRIPTION = `
You can crawl a website so you can clone it.

### When You MUST Trigger a Crawl
Trigger a crawl ONLY if BOTH conditions are true:

1. The user's message shows intent to CLONE / COPY / REPLICATE / RECREATE / DUPLICATE / MIMIC a website.
   - Keywords include: clone, copy, replicate, recreate, duplicate, mimic, build the same, make the same.

2. The user's message contains a URL or something that appears to be a domain name.
   - e.g. "example.com", "https://example.com"
   - Do not require 'http://' or 'https://'.
`;

const CLONE_INSTRUCTIONS_WITHOUT_SCREENSHOT = `
Replicate the website from the provided markdown snapshot.

**Use the markdown snapshot below as your reference** to understand the page structure, content, and layout of the website.

**IMPORTANT: Image Handling**
- Do NOT use or reference real external image URLs.
- Instead, create a file named "placeholder.svg" at "/public/assets/placeholder.svg".
- The file must be included in the output as its own code block.
- The SVG should be a simple neutral gray rectangle, like:
  \`\`\`svg
  <svg width="400" height="300" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="#e2e2e2"/>
  </svg>
  \`\`\`

**When generating code:**
- Replace all \`<img src="...">\` with: \`<img src="/assets/placeholder.svg" alt="placeholder" />\`
- If using Next.js Image component: \`<Image src="/assets/placeholder.svg" alt="placeholder" width={400} height={300} />\`

Always include the placeholder.svg file in your output file tree.
`;

const MAX_TEXT_SNIPPET_LENGTH = 16_000;

function truncateText(value: string): string {
  if (value.length <= MAX_TEXT_SNIPPET_LENGTH) return value;
  return `${value.slice(0, MAX_TEXT_SNIPPET_LENGTH)}\n<!-- truncated -->`;
}

export function formatSnippet(
  label: string,
  value: string,
  lang: string,
): string {
  const sanitized = truncateText(value).replace(/```/g, "` ` `");
  return `${label}:\n\`\`\`${lang}\n${sanitized}\n\`\`\``;
}

// Convert HTML to a readable markdown-like representation without external deps.
function htmlToMarkdown(html: string): string {
  return (
    html
      // Remove script/style/nav/footer noise
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<head[\s\S]*?<\/head>/gi, "")
      .replace(/<nav[\s\S]*?<\/nav>/gi, "")
      .replace(/<footer[\s\S]*?<\/footer>/gi, "")
      // Headings
      .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n")
      .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n")
      .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n")
      .replace(/<h[4-6][^>]*>([\s\S]*?)<\/h[4-6]>/gi, "\n#### $1\n")
      // Links — preserve href
      .replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
      // Images — note src for structure reference
      .replace(
        /<img[^>]*alt="([^"]*)"[^>]*src="([^"]*)"[^>]*\/?>/gi,
        "![image: $1]($2)",
      )
      .replace(/<img[^>]*src="([^"]*)"[^>]*\/?>/gi, "![image]($1)")
      // Lists
      .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1")
      // Paragraphs and divs as line breaks
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<\/div>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      // Strip remaining tags
      .replace(/<[^>]+>/g, "")
      // Decode entities
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      // Clean up whitespace
      .replace(/\n{4,}/g, "\n\n\n")
      .replace(/[ \t]+/g, " ")
      .trim()
  );
}

async function crawlUrl(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; OrianBuilder/1.0)",
      Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
    },
    redirect: "follow",
  });

  if (!response.ok) {
    throw new DyadError(
      `Web crawl failed: ${response.status} ${response.statusText}`,
      DyadErrorKind.External,
    );
  }

  const html = await response.text();
  return htmlToMarkdown(html);
}

export const webCrawlTool: ToolDefinition<z.infer<typeof webCrawlSchema>> = {
  name: "web_crawl",
  description: DESCRIPTION,
  inputSchema: webCrawlSchema,
  defaultConsent: "ask",

  getConsentPreview: (args) => `Crawl URL: "${args.url}"`,

  buildXml: (args, isComplete) => {
    if (!args.url) return undefined;
    let xml = `<dyad-web-crawl>${escapeXmlContent(args.url)}`;
    if (isComplete) xml += "</dyad-web-crawl>";
    return xml;
  },

  execute: async (args, ctx: AgentContext) => {
    logger.log(`Executing web crawl: ${args.url}`);

    const markdown = await crawlUrl(args.url);

    if (!markdown) {
      throw new DyadError(
        "No content available from web crawl",
        DyadErrorKind.External,
      );
    }

    logger.log(`Web crawl completed for URL: ${args.url}`);

    const messageContent: Parameters<typeof ctx.appendUserMessage>[0] = [
      { type: "text", text: CLONE_INSTRUCTIONS_WITHOUT_SCREENSHOT },
      {
        type: "text",
        text: formatSnippet("Markdown snapshot:", markdown, "markdown"),
      },
    ];

    ctx.appendUserMessage(messageContent);

    ctx.onXmlComplete(
      `<dyad-web-crawl>${escapeXmlContent(args.url)}</dyad-web-crawl>`,
    );

    return "Web crawl completed.";
  },
};
