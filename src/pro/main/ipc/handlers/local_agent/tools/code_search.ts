import { z } from "zod";
import log from "electron-log";
import {
  ToolDefinition,
  AgentContext,
  escapeXmlAttr,
  escapeXmlContent,
} from "./types";
import { extractCodebase } from "../../../../../../utils/codebase";
import {
  filterDyadInternalFiles,
  resolveTargetAppPath,
} from "./resolve_app_context";

const logger = log.scope("code_search");

const codeSearchSchema = z.object({
  query: z.string().describe("Search query to find relevant files"),
  app_name: z
    .string()
    .optional()
    .describe(
      "Optional. Name of a referenced app (from `@app:Name` mentions in the user's prompt) to search in instead of the current app. Omit to search the current app.",
    ),
});

type CodeSearchArgs = z.infer<typeof codeSearchSchema>;

function buildCodeSearchAttributes(args: Partial<CodeSearchArgs>) {
  const queryAttr = args.query ? ` query="${escapeXmlAttr(args.query)}"` : "";
  const appNameAttr = args.app_name
    ? ` app_name="${escapeXmlAttr(args.app_name)}"`
    : "";
  return `${queryAttr}${appNameAttr}`;
}

// Tokenise a string into lowercase alphanumeric terms (3+ chars).
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

// Score a file by how well it matches the query terms.
// Returns a score >= 0; higher = more relevant.
function scoreFile(
  filePath: string,
  fileContent: string,
  queryTerms: string[],
): number {
  if (queryTerms.length === 0) return 0;

  const pathLower = filePath.toLowerCase();
  const contentLower = fileContent.toLowerCase();
  let score = 0;

  for (const term of queryTerms) {
    // Path matches are weighted heavily — a term in the filename is very relevant
    if (pathLower.includes(term)) score += 10;

    // Count occurrences in content with a diminishing cap
    let pos = 0;
    let occurrences = 0;
    while (occurrences < 20) {
      const idx = contentLower.indexOf(term, pos);
      if (idx === -1) break;
      occurrences++;
      pos = idx + 1;
    }
    score += Math.min(occurrences, 20);
  }

  // Bonus: proportion of query terms that appear at all (coverage)
  const covered = queryTerms.filter(
    (t) => pathLower.includes(t) || contentLower.includes(t),
  ).length;
  score += (covered / queryTerms.length) * 15;

  return score;
}

// Local semantic-ish search: score every file and return top N.
function localCodeSearch(
  query: string,
  files: { path: string; content: string }[],
  topN = 10,
): string[] {
  const queryTerms = tokenize(query);

  if (queryTerms.length === 0) return [];

  const scored = files
    .map((f) => ({
      path: f.path,
      score: scoreFile(f.path, f.content, queryTerms),
    }))
    .filter((f) => f.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);

  return scored.map((f) => f.path);
}

const DESCRIPTION = `Search the codebase to find files relevant to a query. Use this tool when you need to discover which files contain code related to a specific concept, feature, or functionality. Returns a list of file paths most relevant to the search query.

### When to Use This Tool

- Explore unfamiliar codebases
- Ask "how / where / what" questions to understand behavior
- Find code by meaning rather than exact text

### When NOT to Use

Skip this tool for:
1. Exact text matches (use \`grep\`)
2. Reading known files (use \`read_file\`)
3. Simple symbol lookups (use \`grep\`)
`;

export const codeSearchTool: ToolDefinition<CodeSearchArgs> = {
  name: "code_search",
  description: DESCRIPTION,
  inputSchema: codeSearchSchema,
  defaultConsent: "always",

  getConsentPreview: (args) =>
    args.app_name
      ? `Search for "${args.query}" (app: ${args.app_name})`
      : `Search for "${args.query}"`,

  buildXml: (args, isComplete) => {
    if (!args.query) return undefined;
    if (isComplete) return undefined;
    return `<dyad-code-search${buildCodeSearchAttributes(args)}>Searching...`;
  },

  execute: async (args, ctx: AgentContext) => {
    logger.log(`Executing code search: ${args.query}`);

    ctx.onXmlStream(
      `<dyad-code-search${buildCodeSearchAttributes({
        query: args.query,
        app_name: args.app_name,
      })}>`,
    );

    const targetAppPath = resolveTargetAppPath(ctx, args.app_name);

    const { files } = await extractCodebase({
      appPath: targetAppPath,
      chatContext: {
        contextPaths: [],
        smartContextAutoIncludes: [],
        excludePaths: [],
      },
    });

    const filteredFiles = filterDyadInternalFiles(files, args.app_name);

    const filesContext = filteredFiles.map((f) => ({
      path: f.path,
      content: f.content,
    }));

    logger.log(
      `Searching ${filesContext.length} files for query: "${args.query}"`,
    );

    const relevantFiles = localCodeSearch(args.query, filesContext);

    const resultText =
      relevantFiles.length === 0
        ? "No relevant files found."
        : relevantFiles.map((f) => ` - ${f}`).join("\n");

    ctx.onXmlComplete(
      `<dyad-code-search${buildCodeSearchAttributes(args)}>${escapeXmlContent(resultText)}</dyad-code-search>`,
    );

    logger.log(`Code search completed for query: ${args.query}`);

    if (relevantFiles.length === 0) {
      return "No relevant files found for the given query.";
    }

    return `Found ${relevantFiles.length} relevant file(s):\n${resultText}`;
  },
};
