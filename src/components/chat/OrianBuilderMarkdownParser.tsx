import React, { useDeferredValue, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, CheckCircle2, Copy, XCircle } from "lucide-react";

import { OrianBuilderWrite } from "./OrianBuilderWrite";
import { OrianBuilderRename } from "./OrianBuilderRename";
import { OrianBuilderCopy } from "./OrianBuilderCopy";
import { OrianBuilderDelete } from "./OrianBuilderDelete";
import { OrianBuilderAddDependency } from "./OrianBuilderAddDependency";
import { OrianBuilderExecuteSql } from "./OrianBuilderExecuteSql";
import { OrianBuilderLogs } from "./OrianBuilderLogs";
import { OrianBuilderGrep } from "./OrianBuilderGrep";
import { OrianBuilderAddIntegration } from "./OrianBuilderAddIntegration";
import { OrianBuilderEdit } from "./OrianBuilderEdit";
import { OrianBuilderSearchReplace } from "./OrianBuilderSearchReplace";
import { OrianBuilderCodebaseContext } from "./OrianBuilderCodebaseContext";
import { OrianBuilderThink } from "./OrianBuilderThink";
import { CodeHighlight } from "./CodeHighlight";
import { useAtomValue } from "jotai";
import { isStreamingByIdAtom, selectedChatIdAtom } from "@/atoms/chatAtoms";
import { CustomTagState } from "./stateTypes";
import { OrianBuilderOutput } from "./OrianBuilderOutput";
import { OrianBuilderProblemSummary } from "./OrianBuilderProblemSummary";
import { ipc } from "@/ipc/types";
import { OrianBuilderMcpToolCall } from "./OrianBuilderMcpToolCall";
import { OrianBuilderMcpToolResult } from "./OrianBuilderMcpToolResult";
import { OrianBuilderWebSearchResult } from "./OrianBuilderWebSearchResult";
import { OrianBuilderWebSearch } from "./OrianBuilderWebSearch";
import { OrianBuilderWebCrawl } from "./OrianBuilderWebCrawl";
import { OrianBuilderWebFetch } from "./OrianBuilderWebFetch";
import { OrianBuilderImageGeneration } from "./OrianBuilderImageGeneration";
import { OrianBuilderCodeSearchResult } from "./OrianBuilderCodeSearchResult";
import { OrianBuilderCodeSearch } from "./OrianBuilderCodeSearch";
import { OrianBuilderRead } from "./OrianBuilderRead";
import { OrianBuilderListFiles } from "./OrianBuilderListFiles";
import { OrianBuilderDatabaseSchema } from "./OrianBuilderDatabaseSchema";
import { OrianBuilderDbTableSchema } from "./OrianBuilderDbTableSchema";
import { OrianBuilderSupabaseProjectInfo } from "./OrianBuilderSupabaseProjectInfo";
import { OrianBuilderNeonProjectInfo } from "./OrianBuilderNeonProjectInfo";
import { OrianBuilderStatus } from "./OrianBuilderStatus";
import { OrianBuilderCompaction } from "./OrianBuilderCompaction";
import { OrianBuilderWritePlan } from "./OrianBuilderWritePlan";
import { OrianBuilderExitPlan } from "./OrianBuilderExitPlan";
import { OrianBuilderQuestionnaire } from "./OrianBuilderQuestionnaire";
import { OrianBuilderStepLimit } from "./OrianBuilderStepLimit";
import { OrianBuilderReadGuide } from "./OrianBuilderReadGuide";
import {
  OrianBuilderAgentAction,
  OrianBuilderProjectStack,
  OrianBuilderRepoMap,
} from "./OrianBuilderAgentMetadata";
import { mapActionToButton, QuickActionButton } from "./ChatInput";
import { SuggestedAction } from "@/lib/schemas";
import { FixAllErrorsButton } from "./FixAllErrorsButton";
import { unescapeXmlAttr, unescapeXmlContent } from "../../../shared/xmlEscape";
import {
  OrianBuilderBadge,
  OrianBuilderCard,
  OrianBuilderCardContent,
  OrianBuilderCardHeader,
  OrianBuilderExpandIcon,
} from "./OrianBuilderCardPrimitives";
import {
  getToolCardPresentation,
  OrianBuilderToolCard,
} from "./OrianBuilderToolCard";

const ORIANBUILDER_CUSTOM_TAGS = [
  "orianbuilder-write",
  "orianbuilder-rename",
  "orianbuilder-delete",
  "orianbuilder-add-dependency",
  "orianbuilder-execute-sql",
  "orianbuilder-read-logs",
  "orianbuilder-add-integration",
  "orianbuilder-output",
  "orianbuilder-problem-report",
  "orianbuilder-chat-summary",
  "orianbuilder-edit",
  "orianbuilder-grep",
  "orianbuilder-search-replace",
  "orianbuilder-codebase-context",
  "orianbuilder-web-search-result",
  "orianbuilder-web-search",
  "orianbuilder-web-crawl",
  "orianbuilder-web-fetch",
  "orianbuilder-code-search-result",
  "orianbuilder-code-search",
  "orianbuilder-read",
  "think",
  "orianbuilder-command",
  "orianbuilder-quick-action",
  "orianbuilder-mcp-tool-call",
  "orianbuilder-mcp-tool-result",
  "orianbuilder-list-files",
  "orianbuilder-database-schema",
  "orianbuilder-db-table-schema",
  "orianbuilder-supabase-table-schema",
  "orianbuilder-supabase-project-info",
  "orianbuilder-neon-project-info",
  "orianbuilder-neon-table-schema",
  "orianbuilder-read-guide",
  "orianbuilder-status",
  "orianbuilder-compaction",
  "orianbuilder-copy",
  "orianbuilder-image-generation",
  // Plan mode tags
  "orianbuilder-write-plan",
  "orianbuilder-exit-plan",
  "orianbuilder-questionnaire",
  // Step limit notification
  "orianbuilder-step-limit",
  // Local agent metadata / protocol presentation
  "orianbuilder-project-stack",
  "orianbuilder-repo-map",
  "orianbuilder-agent-action",
  "orianbuilder-project-check",
  // Runtime / verification / packaging tool tags (rendered via OrianBuilderToolCard)
  "orianbuilder-terminal-command",
  "orianbuilder-runtime-session",
  "orianbuilder-runtime-output",
  "orianbuilder-browser-qa",
  "orianbuilder-browser-action",
  "orianbuilder-screenshot",
  "orianbuilder-native-package",
  "orianbuilder-deploy-preview",
  "orianbuilder-accessibility-tree",
  "orianbuilder-console-output",
  "orianbuilder-create-project",
  "orianbuilder-ast-edit",
  "orianbuilder-mcp-runtime",
  "orianbuilder-media-generation",
  "orianbuilder-github-pr",
];

interface OrianBuilderMarkdownParserProps {
  content: string;
}

type CustomTagInfo = {
  tag: string;
  attributes: Record<string, string>;
  content: string;
  fullMatch: string;
  inProgress?: boolean;
};

type ContentPiece =
  | { type: "markdown"; content: string }
  | { type: "custom-tag"; tagInfo: CustomTagInfo };

const HIDDEN_LOCAL_AGENT_TAGS = ["set_chat_summary"];

const BARE_LOCAL_AGENT_TOOL_TAGS = [
  "browser_qa_gate",
  "code_search",
  "create_project",
  "deploy_preview",
  "detect_project_stack",
  "edit_ast",
  "generate_media_asset",
  "get_repo_map",
  "grep",
  "list_files",
  "package_native_artifact",
  "read_file",
  "run_project_check",
  "write_file",
];

const customLink = ({
  node: _node,
  ...props
}: {
  node?: any;
  [key: string]: any;
}) => (
  <a
    {...props}
    onClick={(e) => {
      const url = props.href;
      if (url) {
        e.preventDefault();
        ipc.system.openExternalUrl(url);
      }
    }}
  />
);

export const VanillaMarkdownParser = ({ content }: { content: string }) => {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        code: CodeHighlight,
        a: customLink,
      }}
    >
      {content}
    </ReactMarkdown>
  );
};

function OrianBuilderProjectCheck({
  attributes,
  content,
}: {
  attributes: Record<string, string>;
  content: string;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const status = attributes.status?.toLowerCase();
  const isFailed = status === "failed";
  const command = attributes.command || "Unknown command";
  const framework = attributes.framework || attributes.check || "Project";
  const exitCode =
    attributes["exit-code"] || attributes.exit_code || attributes.code || "";
  const output = content.trim();
  const title = isFailed ? "Project check failed" : "Project check passed";
  const accentColor = isFailed ? "red" : "green";

  const handleCopy = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    await navigator.clipboard.writeText(output || `${title}: ${command}`);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  return (
    <OrianBuilderCard
      showAccent
      accentColor={accentColor}
      isExpanded={isExpanded}
      onClick={() => setIsExpanded((value) => !value)}
    >
      <OrianBuilderCardHeader
        icon={isFailed ? <XCircle size={15} /> : <CheckCircle2 size={15} />}
        accentColor={accentColor}
      >
        <OrianBuilderBadge color={accentColor}>
          {isFailed ? "Error" : "Passed"}
        </OrianBuilderBadge>
        <span className="truncate text-sm font-medium text-foreground">
          {title}
        </span>
        <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
          {framework}
        </span>
        <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
          {command}
        </span>
        {exitCode && (
          <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
            exit {exitCode}
          </span>
        )}
        <button
          type="button"
          className="ml-auto inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={handleCopy}
          title="Copy project check output"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          <span className="hidden sm:inline">{copied ? "Copied" : "Copy"}</span>
        </button>
        <OrianBuilderExpandIcon isExpanded={isExpanded} />
      </OrianBuilderCardHeader>
      <OrianBuilderCardContent isExpanded={isExpanded}>
        {output ? (
          <pre
            className="max-h-72 overflow-auto rounded-lg bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground"
            onClick={(event) => event.stopPropagation()}
          >
            <code>{output}</code>
          </pre>
        ) : (
          <div className="text-sm text-muted-foreground">
            No stdout or stderr was captured.
          </div>
        )}
      </OrianBuilderCardContent>
    </OrianBuilderCard>
  );
}

/**
 * Custom component to parse markdown content with OrianBuilder-specific tags
 */
export const OrianBuilderMarkdownParser: React.FC<
  OrianBuilderMarkdownParserProps
> = ({ content }) => {
  const chatId = useAtomValue(selectedChatIdAtom);
  const isStreaming = useAtomValue(isStreamingByIdAtom).get(chatId!) ?? false;
  const deferredContent = useDeferredValue(content);
  const contentToParse = isStreaming ? deferredContent : content;

  // Extract content pieces (markdown and custom tags)
  const contentPieces = useMemo(() => {
    return parseCustomTags(contentToParse);
  }, [contentToParse]);

  // Extract error messages and track positions
  const { errorMessages, lastErrorIndex, errorCount } = useMemo(() => {
    const errors: string[] = [];
    let lastIndex = -1;
    let count = 0;

    contentPieces.forEach((piece, index) => {
      if (
        piece.type === "custom-tag" &&
        piece.tagInfo.tag === "orianbuilder-output" &&
        piece.tagInfo.attributes.type === "error"
      ) {
        const errorMessage = piece.tagInfo.attributes.message;
        if (errorMessage?.trim()) {
          errors.push(errorMessage.trim());
          count++;
          lastIndex = index;
        }
      }
    });

    return {
      errorMessages: errors,
      lastErrorIndex: lastIndex,
      errorCount: count,
    };
  }, [contentPieces]);

  return (
    <>
      {contentPieces.map((piece, index) => (
        <React.Fragment key={index}>
          {piece.type === "markdown"
            ? piece.content && (
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    code: CodeHighlight,
                    a: customLink,
                  }}
                >
                  {piece.content}
                </ReactMarkdown>
              )
            : renderCustomTag(piece.tagInfo, { isStreaming })}
          {index === lastErrorIndex &&
            errorCount > 1 &&
            !isStreaming &&
            chatId && (
              <div className="mt-3 w-full flex">
                <FixAllErrorsButton
                  errorMessages={errorMessages}
                  chatId={chatId}
                />
              </div>
            )}
        </React.Fragment>
      ))}
    </>
  );
};

/**
 * Pre-process content to handle unclosed custom tags
 * Adds closing tags at the end of the content for any unclosed custom tags
 * Assumes the opening tags are complete and valid
 * Returns the processed content and a map of in-progress tags
 */
function preprocessUnclosedTags(content: string): {
  processedContent: string;
  inProgressTags: Map<string, Set<number>>;
} {
  let processedContent = content;
  // Map to track which tags are in progress and their positions
  const inProgressTags = new Map<string, Set<number>>();

  // For each tag type, check if there are unclosed tags
  for (const tagName of ORIANBUILDER_CUSTOM_TAGS) {
    // Count opening and closing tags
    const openTagPattern = new RegExp(`<${tagName}(?:\\s[^>]*)?>`, "g");
    const closeTagPattern = new RegExp(`</${tagName}>`, "g");

    // Track the positions of opening tags
    const openingMatches: RegExpExecArray[] = [];
    let match;

    // Reset regex lastIndex to start from the beginning
    openTagPattern.lastIndex = 0;

    while ((match = openTagPattern.exec(processedContent)) !== null) {
      openingMatches.push({ ...match });
    }

    const openCount = openingMatches.length;
    const closeCount = (processedContent.match(closeTagPattern) || []).length;

    // If we have more opening than closing tags
    const missingCloseTags = openCount - closeCount;
    if (missingCloseTags > 0) {
      // Add the required number of closing tags at the end
      processedContent += Array(missingCloseTags)
        .fill(`</${tagName}>`)
        .join("");

      // Mark the last N tags as in progress where N is the number of missing closing tags
      const inProgressIndexes = new Set<number>();
      const startIndex = openCount - missingCloseTags;
      for (let i = startIndex; i < openCount; i++) {
        inProgressIndexes.add(openingMatches[i].index);
      }
      inProgressTags.set(tagName, inProgressIndexes);
    }
  }

  return { processedContent, inProgressTags };
}

/**
 * Parse the content to extract custom tags and markdown sections into a unified array
 */
function parseCustomTags(content: string): ContentPiece[] {
  const { processedContent, inProgressTags } = preprocessUnclosedTags(
    normalizeLocalAgentProtocolContent(content),
  );

  // Sort tags longest-first so e.g. "orianbuilder-read-guide" is tried before "orianbuilder-read".
  // The (?=[\s>]) lookahead ensures a tag name like "orianbuilder-read" won't prefix-match
  // "orianbuilder-read-guide" (the char after must be whitespace or '>').
  const sortedTags = [...ORIANBUILDER_CUSTOM_TAGS].sort(
    (a, b) => b.length - a.length,
  );
  const tagPattern = new RegExp(
    `<(${sortedTags.join("|")})(?=[\\s>])\\s*([^>]*)>(.*?)<\\/\\1>`,
    "gs",
  );

  const contentPieces: ContentPiece[] = [];
  let lastIndex = 0;
  let match;

  // Find all custom tags
  while ((match = tagPattern.exec(processedContent)) !== null) {
    const [fullMatch, tag, attributesStr, tagContent] = match;
    const startIndex = match.index;

    // Add the markdown content before this tag
    if (startIndex > lastIndex) {
      contentPieces.push({
        type: "markdown",
        content: processedContent.substring(lastIndex, startIndex),
      });
    }

    // Parse attributes and unescape values
    const attributes: Record<string, string> = {};
    const attrPattern = /([\w-]+)="([^"]*)"/g;
    let attrMatch;
    while ((attrMatch = attrPattern.exec(attributesStr)) !== null) {
      attributes[attrMatch[1]] = unescapeXmlAttr(attrMatch[2]);
    }

    // Check if this tag was marked as in progress
    const tagInProgressSet = inProgressTags.get(tag);
    const isInProgress = tagInProgressSet?.has(startIndex);

    // Add the tag info with unescaped content
    contentPieces.push({
      type: "custom-tag",
      tagInfo: {
        tag,
        attributes,
        content: unescapeXmlContent(tagContent),
        fullMatch,
        inProgress: isInProgress || false,
      },
    });

    lastIndex = startIndex + fullMatch.length;
  }

  // Add the remaining markdown content
  if (lastIndex < processedContent.length) {
    contentPieces.push({
      type: "markdown",
      content: processedContent.substring(lastIndex),
    });
  }

  return contentPieces;
}

function normalizeLocalAgentProtocolContent(content: string): string {
  let normalized = content
    // Normalize legacy dyad-* XML tags to orianbuilder-* so local LLMs that
    // output the old protocol are rendered as proper action cards.
    .replace(/(<\/?)dyad-/g, "$1orianbuilder-")
    .replace(
      /\|\|call:([a-zA-Z0-9_-]+)\((\{[^\n]*?\})\)/g,
      (_match, toolName: string, rawArgs: string) => {
        let detail = "";
        try {
          const args = JSON.parse(rawArgs) as Record<string, unknown>;
          detail = detailFromToolArgs(args);
        } catch {
          detail = "";
        }

        return buildAgentActionTag(toolName, detail);
      },
    )
    .replace(/^\s*\|\|result:[^\n]*(?:\n|$)/gm, "");

  for (const tagName of HIDDEN_LOCAL_AGENT_TAGS) {
    normalized = normalized
      .replace(
        new RegExp(`<${tagName}\\b[^>]*>[\\s\\S]*?<\\/${tagName}>`, "gi"),
        "",
      )
      .replace(new RegExp(`<${tagName}\\b[^>]*\\/?>`, "gi"), "");
  }

  for (const toolName of BARE_LOCAL_AGENT_TOOL_TAGS) {
    normalized = normalized
      .replace(
        new RegExp(`<${toolName}\\b([^>]*)>[\\s\\S]*?<\\/${toolName}>`, "gi"),
        (_match, attributes: string) =>
          buildAgentActionTag(toolName, detailFromAttributeText(attributes)),
      )
      .replace(
        new RegExp(`<${toolName}\\b([^>]*)\\/?>`, "gi"),
        (_match, attributes: string) =>
          buildAgentActionTag(toolName, detailFromAttributeText(attributes)),
      );
  }

  return normalized;
}

function detailFromToolArgs(args: Record<string, unknown>): string {
  const path = typeof args.path === "string" ? args.path : "";
  const directory = typeof args.directory === "string" ? args.directory : "";
  const query = typeof args.query === "string" ? args.query : "";
  const target = typeof args.target === "string" ? args.target : "";
  const name = typeof args.name === "string" ? args.name : "";
  return path || directory || query || target || name;
}

function detailFromAttributeText(attributes: string): string {
  const match = attributes.match(
    /\b(?:path|directory|query|target|name)=["']?([^"'\s>]+)/i,
  );
  return match?.[1] ?? "";
}

function buildAgentActionTag(toolName: string, detail: string): string {
  const label = toolName.replace(/_/g, " ");
  return `<orianbuilder-agent-action tool="${toolName}" label="${label}" detail="${escapeXmlAttribute(detail)}"></orianbuilder-agent-action>`;
}

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function getState({
  isStreaming,
  inProgress,
  explicitState,
}: {
  isStreaming?: boolean;
  inProgress?: boolean;
  explicitState?: string;
}): CustomTagState {
  if (explicitState === "aborted" || explicitState === "finished") {
    return explicitState;
  }
  if (explicitState === "in-progress" || explicitState === "pending") {
    return "pending";
  }
  if (!inProgress) {
    return "finished";
  }
  return isStreaming ? "pending" : "aborted";
}

/**
 * Render a custom tag based on its type
 */
function renderCustomTag(
  tagInfo: CustomTagInfo,
  { isStreaming }: { isStreaming: boolean },
): React.ReactNode {
  const { tag, attributes, content, inProgress } = tagInfo;

  switch (tag) {
    case "orianbuilder-read":
      return (
        <OrianBuilderRead
          node={{
            properties: {
              path: attributes.path || "",
              startLine: attributes.start_line || "",
              endLine: attributes.end_line || "",
              appName: attributes.app_name || "",
            },
          }}
        >
          {content}
        </OrianBuilderRead>
      );
    case "orianbuilder-web-search":
      return (
        <OrianBuilderWebSearch
          node={{
            properties: {
              query: attributes.query || "",
              state: getState({ isStreaming, inProgress }),
            },
          }}
        >
          {content}
        </OrianBuilderWebSearch>
      );
    case "orianbuilder-web-crawl":
      return (
        <OrianBuilderWebCrawl
          node={{
            properties: {},
          }}
        >
          {content}
        </OrianBuilderWebCrawl>
      );
    case "orianbuilder-web-fetch":
      return (
        <OrianBuilderWebFetch
          node={{
            properties: {
              state: getState({ isStreaming, inProgress }),
            },
          }}
        >
          {content}
        </OrianBuilderWebFetch>
      );
    case "orianbuilder-code-search":
      return (
        <OrianBuilderCodeSearch
          node={{
            properties: {
              query: attributes.query || "",
              state: getState({ isStreaming, inProgress }),
              appName: attributes.app_name || "",
            },
          }}
        >
          {content}
        </OrianBuilderCodeSearch>
      );
    case "orianbuilder-code-search-result":
      return (
        <OrianBuilderCodeSearchResult
          node={{
            properties: {},
          }}
        >
          {content}
        </OrianBuilderCodeSearchResult>
      );
    case "orianbuilder-web-search-result":
      return (
        <OrianBuilderWebSearchResult
          node={{
            properties: {
              state: getState({ isStreaming, inProgress }),
            },
          }}
        >
          {content}
        </OrianBuilderWebSearchResult>
      );
    case "think":
      return (
        <OrianBuilderThink
          node={{
            properties: {
              state: getState({ isStreaming, inProgress }),
            },
          }}
        >
          {content}
        </OrianBuilderThink>
      );
    case "orianbuilder-write":
      return (
        <OrianBuilderWrite
          node={{
            properties: {
              path: attributes.path || "",
              description: attributes.description || "",
              state: getState({ isStreaming, inProgress }),
            },
          }}
        >
          {content}
        </OrianBuilderWrite>
      );

    case "orianbuilder-rename":
      return (
        <OrianBuilderRename
          node={{
            properties: {
              from: attributes.from || "",
              to: attributes.to || "",
            },
          }}
        >
          {content}
        </OrianBuilderRename>
      );

    case "orianbuilder-copy":
      return (
        <OrianBuilderCopy
          node={{
            properties: {
              from: attributes.from || "",
              to: attributes.to || "",
              description: attributes.description || "",
              state: getState({ isStreaming, inProgress }),
            },
          }}
        >
          {content}
        </OrianBuilderCopy>
      );

    case "orianbuilder-delete":
      return (
        <OrianBuilderDelete
          node={{
            properties: {
              path: attributes.path || "",
            },
          }}
        >
          {content}
        </OrianBuilderDelete>
      );

    case "orianbuilder-add-dependency":
      return (
        <OrianBuilderAddDependency
          node={{
            properties: {
              packages: attributes.packages || "",
            },
          }}
        >
          {content}
        </OrianBuilderAddDependency>
      );

    case "orianbuilder-execute-sql":
      return (
        <OrianBuilderExecuteSql
          node={{
            properties: {
              state: getState({ isStreaming, inProgress }),
              description: attributes.description || "",
            },
          }}
        >
          {content}
        </OrianBuilderExecuteSql>
      );

    case "orianbuilder-read-logs":
      return (
        <OrianBuilderLogs
          node={{
            properties: {
              state: getState({ isStreaming, inProgress }),
              time: attributes.time || "",
              type: attributes.type || "",
              level: attributes.level || "",
              count: attributes.count || "",
            },
          }}
        >
          {content}
        </OrianBuilderLogs>
      );

    case "orianbuilder-grep":
      return (
        <OrianBuilderGrep
          node={{
            properties: {
              state: getState({ isStreaming, inProgress }),
              query: attributes.query || "",
              include: attributes.include || "",
              exclude: attributes.exclude || "",
              "case-sensitive": attributes["case-sensitive"] || "",
              count: attributes.count || "",
              total: attributes.total || "",
              truncated: attributes.truncated || "",
              appName: attributes.app_name || "",
            },
          }}
        >
          {content}
        </OrianBuilderGrep>
      );

    case "orianbuilder-add-integration":
      return (
        <OrianBuilderAddIntegration
          provider={
            attributes.provider === "neon" || attributes.provider === "supabase"
              ? attributes.provider
              : undefined
          }
        >
          {content}
        </OrianBuilderAddIntegration>
      );

    case "orianbuilder-edit":
      return (
        <OrianBuilderEdit
          node={{
            properties: {
              path: attributes.path || "",
              description: attributes.description || "",
              state: getState({ isStreaming, inProgress }),
            },
          }}
        >
          {content}
        </OrianBuilderEdit>
      );

    case "orianbuilder-search-replace":
      return (
        <OrianBuilderSearchReplace
          node={{
            properties: {
              path: attributes.path || "",
              description: attributes.description || "",
              state: getState({ isStreaming, inProgress }),
            },
          }}
        >
          {content}
        </OrianBuilderSearchReplace>
      );

    case "orianbuilder-codebase-context":
      return (
        <OrianBuilderCodebaseContext
          node={{
            properties: {
              files: attributes.files || "",
              state: getState({ isStreaming, inProgress }),
            },
          }}
        >
          {content}
        </OrianBuilderCodebaseContext>
      );

    case "orianbuilder-mcp-tool-call":
      return (
        <OrianBuilderMcpToolCall
          node={{
            properties: {
              serverName: attributes.server || "",
              toolName: attributes.tool || "",
            },
          }}
        >
          {content}
        </OrianBuilderMcpToolCall>
      );

    case "orianbuilder-mcp-tool-result":
      return (
        <OrianBuilderMcpToolResult
          node={{
            properties: {
              serverName: attributes.server || "",
              toolName: attributes.tool || "",
            },
          }}
        >
          {content}
        </OrianBuilderMcpToolResult>
      );

    case "orianbuilder-output":
      return (
        <OrianBuilderOutput
          type={attributes.type as "warning" | "error"}
          message={attributes.message}
        >
          {content}
        </OrianBuilderOutput>
      );

    case "orianbuilder-project-check":
      return (
        <OrianBuilderProjectCheck attributes={attributes} content={content} />
      );

    case "orianbuilder-problem-report":
      return (
        <OrianBuilderProblemSummary summary={attributes.summary}>
          {content}
        </OrianBuilderProblemSummary>
      );

    case "orianbuilder-chat-summary":
      // Don't render anything for orianbuilder-chat-summary
      return null;

    case "orianbuilder-command":
      if (attributes.type) {
        const action = {
          id: attributes.type,
        } as SuggestedAction;
        return <>{mapActionToButton(action)}</>;
      }
      return null;

    case "orianbuilder-quick-action": {
      const label = (attributes.label ?? "").trim();
      const prompt = (attributes.prompt ?? "").trim();
      if (!label || !prompt) return null;
      return <QuickActionButton label={label.slice(0, 24)} prompt={prompt} />;
    }

    case "orianbuilder-list-files":
      return (
        <OrianBuilderListFiles
          node={{
            properties: {
              directory: attributes.directory || "",
              recursive: attributes.recursive || "",
              include_ignored:
                attributes.include_ignored || attributes.include_hidden || "",
              state: getState({ isStreaming, inProgress }),
              appName: attributes.app_name || "",
            },
          }}
        >
          {content}
        </OrianBuilderListFiles>
      );

    case "orianbuilder-database-schema":
      return (
        <OrianBuilderDatabaseSchema
          node={{
            properties: {
              state: getState({ isStreaming, inProgress }),
            },
          }}
        >
          {content}
        </OrianBuilderDatabaseSchema>
      );

    case "orianbuilder-db-table-schema":
    // Backward compat: old messages used provider-specific tags
    case "orianbuilder-supabase-table-schema":
    case "orianbuilder-neon-table-schema":
      return (
        <OrianBuilderDbTableSchema
          provider={
            tag === "orianbuilder-supabase-table-schema"
              ? "Supabase"
              : tag === "orianbuilder-neon-table-schema"
                ? "Neon"
                : (attributes.provider as string) || ""
          }
          node={{
            properties: {
              table: attributes.table || "",
              state: getState({ isStreaming, inProgress }),
            },
          }}
        >
          {content}
        </OrianBuilderDbTableSchema>
      );

    case "orianbuilder-supabase-project-info":
      return (
        <OrianBuilderSupabaseProjectInfo
          node={{
            properties: {
              state: getState({ isStreaming, inProgress }),
            },
          }}
        >
          {content}
        </OrianBuilderSupabaseProjectInfo>
      );

    case "orianbuilder-neon-project-info":
      return (
        <OrianBuilderNeonProjectInfo
          node={{
            properties: {
              state: getState({ isStreaming, inProgress }),
            },
          }}
        >
          {content}
        </OrianBuilderNeonProjectInfo>
      );

    case "orianbuilder-read-guide":
      return (
        <OrianBuilderReadGuide
          node={{
            properties: {
              name: attributes.name || "",
              state: getState({ isStreaming, inProgress }),
            },
          }}
        >
          {content}
        </OrianBuilderReadGuide>
      );

    case "orianbuilder-image-generation":
      return (
        <OrianBuilderImageGeneration
          node={{
            properties: {
              prompt: attributes.prompt || "",
              path: attributes.path || "",
              state: getState({ isStreaming, inProgress }),
            },
          }}
        >
          {content}
        </OrianBuilderImageGeneration>
      );

    case "orianbuilder-status":
      return (
        <OrianBuilderStatus
          node={{
            properties: {
              title: attributes.title || "Processing...",
              state: getState({
                isStreaming,
                inProgress,
                explicitState: attributes.state,
              }),
            },
          }}
        >
          {content}
        </OrianBuilderStatus>
      );

    case "orianbuilder-compaction":
      return (
        <OrianBuilderCompaction
          node={{
            properties: {
              title: attributes.title || "Compacting conversation",
              state: getState({ isStreaming, inProgress }),
            },
          }}
        >
          {content}
        </OrianBuilderCompaction>
      );

    case "orianbuilder-write-plan":
      return (
        <OrianBuilderWritePlan
          node={{
            properties: {
              title: attributes.title || "Implementation Plan",
              summary: attributes.summary,
              complete: attributes.complete,
              state: getState({ isStreaming, inProgress }),
            },
          }}
        >
          {content}
        </OrianBuilderWritePlan>
      );

    case "orianbuilder-exit-plan":
      return (
        <OrianBuilderExitPlan
          node={{
            properties: {
              notes: attributes.notes,
            },
          }}
        />
      );

    case "orianbuilder-questionnaire":
      return <OrianBuilderQuestionnaire>{content}</OrianBuilderQuestionnaire>;

    case "orianbuilder-step-limit":
      return (
        <OrianBuilderStepLimit
          node={{
            properties: {
              steps: attributes.steps,
              limit: attributes.limit,
              state: getState({ isStreaming, inProgress }),
            },
          }}
        >
          {content}
        </OrianBuilderStepLimit>
      );

    case "orianbuilder-project-stack":
      return (
        <OrianBuilderProjectStack attributes={attributes}>
          {content}
        </OrianBuilderProjectStack>
      );

    case "orianbuilder-repo-map":
      return (
        <OrianBuilderRepoMap attributes={attributes}>
          {content}
        </OrianBuilderRepoMap>
      );

    case "orianbuilder-agent-action":
      return <OrianBuilderAgentAction attributes={attributes} />;

    default: {
      const presentation = getToolCardPresentation(
        tag,
        attributes,
        Boolean(inProgress),
      );
      if (presentation) {
        return (
          <OrianBuilderToolCard
            presentation={presentation}
            content={content}
            inProgress={inProgress}
          />
        );
      }
      return null;
    }
  }
}
