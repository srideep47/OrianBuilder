import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import log from "electron-log";
import { ToolDefinition, AgentContext, escapeXmlContent } from "./types";
import { DyadError, DyadErrorKind } from "@/errors/dyad_error";

const logger = log.scope("get_repo_map");

// Maximum characters of repo map to return (keeps model context sane)
const MAX_MAP_CHARS = 40_000;

// File extensions we can extract symbols from
const SUPPORTED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".cs",
  ".rb",
  ".php",
  ".svelte",
  ".vue",
  ".astro",
]);

// Directories to always skip
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".svelte-kit",
  ".next",
  "dist",
  "build",
  ".turbo",
  ".cache",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  ".mypy_cache",
  "target",
  "vendor",
]);

// Files to skip
const SKIP_FILES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  ".DS_Store",
]);

// ─── Symbol extraction via regex (zero native deps) ──────────────────────────

interface Symbol {
  kind:
    | "fn"
    | "class"
    | "type"
    | "interface"
    | "const"
    | "export"
    | "component";
  name: string;
  line: number;
}

// Patterns ordered: more specific first
const SYMBOL_PATTERNS: Array<{ kind: Symbol["kind"]; re: RegExp }> = [
  // React functional component (PascalCase function/arrow)
  {
    kind: "component",
    re: /^export\s+(?:default\s+)?function\s+([A-Z][A-Za-z0-9_]*)\s*[(<]/,
  },
  {
    kind: "component",
    re: /^export\s+const\s+([A-Z][A-Za-z0-9_]*)\s*[:=].*(?:React\.FC|=>|function)/,
  },
  // Classes
  {
    kind: "class",
    re: /^(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
  },
  // Functions
  {
    kind: "fn",
    re: /^(?:export\s+)?(?:async\s+)?function\s+([a-z_$][A-Za-z0-9_$]*)/,
  },
  {
    kind: "fn",
    re: /^export\s+const\s+([a-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?\(/,
  },
  // Types & interfaces
  {
    kind: "type",
    re: /^(?:export\s+)?type\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*[=<]/,
  },
  {
    kind: "interface",
    re: /^(?:export\s+)?interface\s+([A-Za-z_$][A-Za-z0-9_$]*)/,
  },
  // Constants
  { kind: "const", re: /^export\s+const\s+([A-Z_][A-Z0-9_]{2,})\s*=/ },
];

function extractSymbols(content: string, filePath: string): Symbol[] {
  const ext = path.extname(filePath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) return [];

  const symbols: Symbol[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimStart();

    for (const { kind, re } of SYMBOL_PATTERNS) {
      const m = re.exec(line);
      if (m?.[1]) {
        // Deduplicate: skip if same name+kind already recorded at nearby line
        const name = m[1];
        const exists = symbols.some((s) => s.name === name && s.kind === kind);
        if (!exists) {
          symbols.push({ kind, name, line: i + 1 });
        }
        break;
      }
    }
  }

  return symbols;
}

// ─── File walker ─────────────────────────────────────────────────────────────

interface FileEntry {
  relativePath: string;
  symbols: Symbol[];
  lines: number;
  sizeKb: number;
}

function walkDir(
  dir: string,
  rootDir: string,
  results: FileEntry[],
  maxFiles = 600,
): void {
  if (results.length >= maxFiles) return;

  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (results.length >= maxFiles) break;
    if (SKIP_FILES.has(entry)) continue;

    const fullPath = path.join(dir, entry);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      walkDir(fullPath, rootDir, results, maxFiles);
    } else {
      const ext = path.extname(entry).toLowerCase();
      if (!SUPPORTED_EXTENSIONS.has(ext)) continue;
      if (stat.size > 200 * 1024) continue; // skip huge files

      let content: string;
      try {
        content = fs.readFileSync(fullPath, "utf8");
      } catch {
        continue;
      }

      const symbols = extractSymbols(content, fullPath);
      const lineCount = content.split("\n").length;
      const relativePath = path.relative(rootDir, fullPath).replace(/\\/g, "/");

      results.push({
        relativePath,
        symbols,
        lines: lineCount,
        sizeKb: Math.round(stat.size / 1024),
      });
    }
  }
}

// ─── Ranking ─────────────────────────────────────────────────────────────────

function scoreFile(entry: FileEntry): number {
  let score = 0;
  // More exports = more central
  score += entry.symbols.length * 3;
  // Components slightly higher weight (they're what AI works on most)
  score += entry.symbols.filter((s) => s.kind === "component").length * 2;
  // Penalise giant files slightly (less likely to be the one to edit)
  if (entry.lines > 400) score -= 5;
  // Key filenames get a boost
  const basename = path.basename(entry.relativePath).toLowerCase();
  if (/^(index|app|main|root|layout|router|routes)\./.test(basename))
    score += 10;
  if (/\.(test|spec|stories)\./.test(basename)) score -= 8;
  return score;
}

// ─── Formatter ───────────────────────────────────────────────────────────────

function formatMap(files: FileEntry[]): string {
  const lines: string[] = [
    `Repository map — ${files.length} file(s)\n`,
    "Format: path [lines] — symbols\n",
    "─".repeat(60),
  ];

  for (const f of files) {
    const symbolStr =
      f.symbols.length === 0
        ? "(no exports)"
        : f.symbols
            .map((s) => {
              const icon = {
                fn: "fn",
                class: "class",
                type: "type",
                interface: "interface",
                const: "const",
                export: "export",
                component: "component",
              }[s.kind];
              return `${icon}:${s.name}`;
            })
            .join(", ");

    lines.push(`${f.relativePath} [${f.lines}L] — ${symbolStr}`);
  }

  return lines.join("\n");
}

// ─── Tool ────────────────────────────────────────────────────────────────────

const getRepoMapSchema = z.object({
  path_filter: z
    .string()
    .optional()
    .describe(
      "Limit the map to files whose path contains this substring (e.g. 'src/components', 'server'). Omit for the full repo.",
    ),
  top_n: z
    .number()
    .min(1)
    .max(200)
    .optional()
    .default(80)
    .describe(
      "Maximum number of files to include, ranked by relevance (default: 80).",
    ),
});

type GetRepoMapArgs = z.infer<typeof getRepoMapSchema>;

export const getRepoMapTool: ToolDefinition<GetRepoMapArgs> = {
  name: "get_repo_map",
  description: `Return a compact symbol map of the repository — file paths and the functions, classes, types, and React components they export.

Use this at the start of a task to understand the codebase structure WITHOUT reading every file. The map is much cheaper than calling \`read_file\` on each file individually.

### When to use
- First turn of a complex task: "What files and functions are there?"
- Deciding WHICH files to read before making changes
- Understanding the shape of an unfamiliar codebase
- Finding where a feature is implemented (check the map, then grep, then read)

### When NOT to use
- You already know which file to edit (use \`read_file\` directly)
- You need full file contents (use \`read_file\`)
- For exact symbol lookups (use \`grep\`)

### Tips
- Use \`path_filter\` to scope the map: \`"src/api"\`, \`"components"\`, \`"server"\`
- Follow up with \`grep\` or \`read_file\` for files that look relevant`,

  inputSchema: getRepoMapSchema,
  defaultConsent: "always",

  getConsentPreview: (args) =>
    args.path_filter
      ? `Get repo map (filter: ${args.path_filter})`
      : "Get repo map",

  buildXml: (_args, isComplete) => {
    if (isComplete) return undefined;
    return `<dyad-repo-map>Building map…`;
  },

  execute: async (args, ctx: AgentContext) => {
    logger.log(
      `get_repo_map: appPath=${ctx.appPath}, filter=${args.path_filter}`,
    );

    if (!fs.existsSync(ctx.appPath)) {
      throw new DyadError(
        `App directory not found: ${ctx.appPath}`,
        DyadErrorKind.NotFound,
      );
    }

    ctx.onXmlStream(`<dyad-repo-map>Building map…`);

    const allFiles: FileEntry[] = [];
    walkDir(ctx.appPath, ctx.appPath, allFiles, 600);

    // Apply path filter
    let filtered = allFiles;
    if (args.path_filter) {
      const f = args.path_filter.toLowerCase();
      filtered = allFiles.filter((e) =>
        e.relativePath.toLowerCase().includes(f),
      );
    }

    // Rank by relevance
    filtered.sort((a, b) => scoreFile(b) - scoreFile(a));

    // Cap at top_n
    const topN = args.top_n ?? 80;
    const topFiles = filtered.slice(0, topN);

    // Sort output alphabetically for readability
    topFiles.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

    let mapText = formatMap(topFiles);
    if (mapText.length > MAX_MAP_CHARS) {
      mapText =
        mapText.slice(0, MAX_MAP_CHARS) +
        "\n\n... [map truncated — use path_filter to narrow scope]";
    }

    ctx.onXmlComplete(
      `<dyad-repo-map files="${topFiles.length}">${escapeXmlContent(mapText)}</dyad-repo-map>`,
    );

    logger.log(`get_repo_map: returned ${topFiles.length} files`);
    return mapText;
  },
};
