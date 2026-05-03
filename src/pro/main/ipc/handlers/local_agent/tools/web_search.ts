import { z } from "zod";
import log from "electron-log";
import {
  ToolDefinition,
  AgentContext,
  escapeXmlAttr,
  escapeXmlContent,
} from "./types";
import { DyadError, DyadErrorKind } from "@/errors/dyad_error";
import { readSettings } from "@/main/settings";

const logger = log.scope("web_search");

const webSearchSchema = z.object({
  query: z.string().describe("The search query to look up on the web"),
});

const DESCRIPTION = `
Use this tool to access real-time information beyond your training data cutoff.

When to Search:
- Current API documentation, library versions, or breaking changes
- Latest best practices, security advisories, or bug fixes
- Specific error messages or troubleshooting solutions
- Recent framework updates or deprecation notices

Query Tips:
- Be specific: Include version numbers, exact error messages, or technical terms
- Add context: "React 19 useEffect cleanup" not just "React hooks"

Examples:

<example>
OpenAI GPT-5 API model names
</example>

<example>
NextJS 14 app router middleware auth
</example>
`;

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

// ============================================================================
// Brave Search API (primary — requires user API key)
// ============================================================================

interface BraveWebResult {
  title?: string;
  url?: string;
  description?: string;
}

interface BraveSearchResponse {
  web?: {
    results?: BraveWebResult[];
  };
}

async function searchBrave(query: string, apiKey: string): Promise<string> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=10&safesearch=moderate`;

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": apiKey,
    },
  });

  if (!response.ok) {
    throw new DyadError(
      `Brave Search failed: ${response.status} ${response.statusText}`,
      DyadErrorKind.External,
    );
  }

  const data = (await response.json()) as BraveSearchResponse;
  const results: SearchResult[] = (data?.web?.results ?? []).map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: r.description ?? "",
  }));

  return formatResults(results, query);
}

// ============================================================================
// DuckDuckGo HTML scraper (fallback — zero config)
// ============================================================================

function parseDuckDuckGoHtml(html: string): SearchResult[] {
  const results: SearchResult[] = [];

  const resultBlocks =
    html.match(/<article[^>]*data-testid="result"[\s\S]*?<\/article>/gi) ?? [];

  for (const block of resultBlocks) {
    const titleMatch = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i);
    const title = titleMatch
      ? titleMatch[1].replace(/<[^>]+>/g, "").trim()
      : "";

    const urlMatch = block.match(/href="(https?:\/\/[^"]+)"/i);
    const url = urlMatch ? urlMatch[1] : "";

    const snippetMatch =
      block.match(/<span[^>]*data-result="snippet"[^>]*>([\s\S]*?)<\/span>/i) ??
      block.match(
        /<div[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
      );
    const snippet = snippetMatch
      ? snippetMatch[1]
          .replace(/<[^>]+>/g, "")
          .replace(/\s+/g, " ")
          .trim()
      : "";

    if (url && (title || snippet)) {
      results.push({ title, url, snippet });
    }
  }

  return results;
}

async function searchDuckDuckGo(query: string): Promise<string> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
    },
    body: `q=${encodeURIComponent(query)}&b=&kl=us-en`,
    redirect: "follow",
  });

  if (!response.ok) {
    throw new DyadError(
      `Web search failed: ${response.status} ${response.statusText}`,
      DyadErrorKind.External,
    );
  }

  const html = await response.text();
  const results = parseDuckDuckGoHtml(html);

  if (results.length === 0) {
    const fallback = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s{2,}/g, " ")
      .slice(0, 6000);
    return `## Web search results for: "${query}"\n\n${fallback}`;
  }

  return formatResults(results, query);
}

// ============================================================================
// Shared formatter
// ============================================================================

function formatResults(results: SearchResult[], query: string): string {
  if (results.length === 0) {
    return `No results found for: "${query}"`;
  }

  const lines = [`## Web search results for: "${query}"\n`];
  for (const r of results.slice(0, 10)) {
    lines.push(`### ${r.title || r.url}`);
    lines.push(`URL: ${r.url}`);
    if (r.snippet) lines.push(r.snippet);
    lines.push("");
  }
  return lines.join("\n");
}

// ============================================================================
// Dispatcher: Brave when key present, DuckDuckGo otherwise
// ============================================================================

async function performSearch(query: string): Promise<string> {
  const settings = readSettings();
  const braveKey = settings.braveSearchApiKey?.value;

  if (braveKey) {
    try {
      logger.log("Using Brave Search API");
      return await searchBrave(query, braveKey);
    } catch (err) {
      logger.warn(
        `Brave Search failed, falling back to DuckDuckGo: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  logger.log("Using DuckDuckGo (no Brave API key configured)");
  return searchDuckDuckGo(query);
}

export const webSearchTool: ToolDefinition<z.infer<typeof webSearchSchema>> = {
  name: "web_search",
  description: DESCRIPTION,
  inputSchema: webSearchSchema,
  defaultConsent: "ask",

  getConsentPreview: (args) => `Search the web: "${args.query}"`,

  execute: async (args, ctx: AgentContext) => {
    logger.log(`Executing web search: ${args.query}`);

    ctx.onXmlStream(`<dyad-web-search query="${escapeXmlAttr(args.query)}">`);

    const result = await performSearch(args.query);

    if (!result) {
      throw new DyadError(
        "Web search returned no results",
        DyadErrorKind.External,
      );
    }

    ctx.onXmlComplete(
      `<dyad-web-search query="${escapeXmlAttr(args.query)}">${escapeXmlContent(result)}</dyad-web-search>`,
    );

    logger.log(`Web search completed for query: ${args.query}`);
    return result;
  },
};
