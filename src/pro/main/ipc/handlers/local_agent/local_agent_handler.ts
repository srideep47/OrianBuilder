/**
 * Local Agent v2 Handler
 * Main orchestrator for tool-based agent mode with parallel execution
 */

import { IpcMainInvokeEvent } from "electron";
import { createHash } from "node:crypto";
import {
  streamText,
  ToolSet,
  stepCountIs,
  hasToolCall,
  ModelMessage,
  type ToolExecutionOptions,
} from "ai";
import log from "electron-log";

import { db } from "@/db";
import {
  chats,
  messages,
  missionInterrupts,
  missionMemories,
  missionPermissionRequests,
  missionWorkers,
  missions,
} from "@/db/schema";
import { and, asc, desc, eq, inArray, isNull, or } from "drizzle-orm";

import { isOrianBuilderProEnabled, type UserSettings } from "@/lib/schemas";
import { readSettings } from "@/main/settings";
import { getOrianBuilderAppPath } from "@/paths/paths";
import { detectFrameworkType } from "@/ipc/utils/framework_utils";
import { getModelClient } from "@/ipc/utils/get_model_client";
import { getServerStatus } from "@/ipc/utils/embedded_inference_server";
import { safeSend } from "@/ipc/utils/safe_sender";
import {
  getMaxTokens,
  getTemperature,
  estimateTokens,
} from "@/ipc/utils/token_utils";
import {
  getProviderOptions,
  getAiHeaders,
  ORIANBUILDER_INTERNAL_REQUEST_ID_HEADER,
} from "@/ipc/utils/provider_options";

import {
  AgentToolName,
  buildAgentToolSet,
  requireAgentToolConsent,
  clearPendingConsentsForChat,
  clearPendingQuestionnairesForChat,
} from "./tool_definitions";
import {
  deployAllFunctionsIfNeeded,
  commitAllChanges,
} from "./processors/file_operations";
import { storeDbTimestampAtCurrentVersion } from "@/ipc/utils/neon_timestamp_utils";
import { mcpManager } from "@/ipc/utils/mcp_manager";
import { mcpServers } from "@/db/schema";
import {
  getMcpToolTrustOverridesByToolKey,
  requireMcpToolConsent,
} from "@/ipc/utils/mcp_consent";
import { getAiMessagesJsonIfWithinLimit } from "@/ipc/utils/ai_messages_utils";

import type { ChatStreamParams, ChatResponseEnd } from "@/ipc/types";
import {
  AgentContext,
  parsePartialJson,
  escapeXmlAttr,
  escapeXmlContent,
  UserMessageContentPart,
  FileEditTracker,
} from "./tools/types";
import { sendTelemetryEvent } from "@/ipc/utils/telemetry";
import {
  prepareStepMessages,
  buildTodoReminderMessage,
  hasIncompleteTodos,
  formatTodoSummary,
  ensureToolResultOrdering,
  type InjectedMessage,
} from "./prepare_step_utils";
import { buildMissionInterruptMessage } from "@/ipc/utils/mission_interrupts";
import { buildMissionMemoryMessage } from "@/ipc/utils/mission_memories";
import { loadTodos } from "./todo_persistence";
import { ensureOrianBuilderGitignored } from "@/ipc/handlers/gitignoreUtils";
import { TOOL_DEFINITIONS } from "./tool_definitions";
import { hasTextToolCallMarkers } from "./text_tool_call_parser";
import { runTextToolCallFallback } from "./text_tool_call_executor";
import {
  parseAiMessagesJson,
  type DbMessageForParsing,
} from "@/ipc/utils/ai_messages_utils";
import { parseMcpToolKey, sanitizeMcpName } from "@/ipc/utils/mcp_tool_utils";
import { addIntegrationTool } from "./tools/add_integration";
import { writePlanTool } from "./tools/write_plan";
import { exitPlanTool } from "./tools/exit_plan";
import {
  appendCancelledResponseNotice,
  filterCancelledMessagePairs,
} from "@/shared/chatCancellation";
import {
  isChatPendingCompaction,
  performCompaction,
  checkAndMarkForCompaction,
} from "@/ipc/handlers/compaction/compaction_handler";
import { getPostCompactionMessages } from "@/ipc/handlers/compaction/compaction_utils";
import { DEFAULT_MAX_TOOL_CALL_STEPS } from "@/constants/settings_constants";
import {
  OrianBuilderError,
  OrianBuilderErrorKind,
} from "@/errors/orianbuilder_error";
import {
  type RetryReplayEvent,
  maybeCaptureRetryReplayEvent,
  maybeCaptureRetryReplayText,
  maybeAppendRetryReplayForRetry,
} from "./retry_replay_utils";
import { setChatSummaryTool } from "./tools/set_chat_summary";
import { packageNativeArtifactTool } from "./tools/package_native_artifact";
import { deployPreviewTool } from "./tools/deploy_preview";
import { browserQaGateTool } from "./tools/browser_qa_gate";
import {
  createMissionArtifact,
  createMissionCheckpoint,
  createMissionInterrupt,
  finishMissionRun,
  logMissionEvent,
  startMissionRun,
} from "@/ipc/utils/mission_utils";
import {
  getMissionEventSummaryForXml,
  getMissionVerificationEventForXml,
} from "@/ipc/utils/mission_verification";
import { syncMissionTasksFromTodos } from "@/ipc/utils/mission_tasks";
import { getMissionStructuredEventsForXml } from "@/ipc/utils/mission_xml_events";
import { extractMissionVisualEventsForXml } from "@/ipc/utils/mission_visual_events";
import { getAutonomyPolicyDecision } from "@/ipc/utils/autonomy_policy";
import type { McpToolTrustOverrideMap } from "@/ipc/utils/mcp_tool_capabilities";
import type { MissionAutonomyProfile } from "@/ipc/types/mission";
import {
  createToolFailureBudgetState,
  getMissionRuntimeBudgetStatus,
  MISSION_REPEATED_STEP_LOOP_LIMIT,
  MISSION_RUNTIME_BUDGET_MS,
  recordToolFailureForBudget,
  recordToolSuccessForBudget,
  type ToolFailureBudgetDecision,
} from "@/ipc/utils/mission_budgets";
import {
  buildNativeTargetReminder,
  detectNativeTargetIntentWithModel,
  type NativeTargetIntent,
} from "./native_target_intent";

const logger = log.scope("local_agent_handler");
const PLANNING_QUESTIONNAIRE_TOOL_NAME = "planning_questionnaire";
const MAX_TERMINATED_STREAM_RETRIES = 3;
const STREAM_RETRY_BASE_DELAY_MS = 400;
const STREAM_CONTINUE_MESSAGE =
  "[System] Your previous response stream was interrupted by a transient network error. Continue from exactly where you left off and do not repeat text that has already been sent.";

function getMissionRunModelName(settings: UserSettings): string {
  if (settings.selectedModel.provider !== "embedded") {
    return settings.selectedModel.name;
  }
  return getServerStatus().modelName ?? settings.selectedModel.name;
}

const RETRYABLE_STREAM_ERROR_STATUS_CODES = new Set([
  408, 429, 500, 502, 503, 504,
]);
const RETRYABLE_STREAM_ERROR_PATTERNS = [
  "server_error",
  "internal server error",
  "service unavailable",
  "bad gateway",
  "gateway timeout",
  "too many requests",
  "rate_limit",
  "overloaded",
  "econnrefused",
  "enotfound",
  "econnreset",
  "epipe",
  "etimedout",
];

// ============================================================================
// Tool Streaming State Management
// ============================================================================

/**
 * Track streaming state per tool call ID
 */
interface ToolStreamingEntry {
  toolName: string;
  argsAccumulated: string;
}
const toolStreamingEntries = new Map<string, ToolStreamingEntry>();

function getOrCreateStreamingEntry(
  id: string,
  toolName?: string,
): ToolStreamingEntry | undefined {
  let entry = toolStreamingEntries.get(id);
  if (!entry && toolName) {
    entry = {
      toolName,
      argsAccumulated: "",
    };
    toolStreamingEntries.set(id, entry);
  }
  return entry;
}

function cleanupStreamingEntry(id: string): void {
  toolStreamingEntries.delete(id);
}

function findToolDefinition(toolName: string) {
  return TOOL_DEFINITIONS.find((t) => t.name === toolName);
}

type PlainTextToolCall = {
  toolName: string;
  args: Record<string, unknown>;
  signature: string;
};

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function parsePlainTextToolAttributes(value: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const attrPattern = /([a-zA-Z0-9_-]+)="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = attrPattern.exec(value)) !== null) {
    args[match[1]] = decodeXmlText(match[2]).trim();
  }
  return args;
}

function parsePlainTextToolArgs(
  attributes: string,
  body: string,
): Record<string, unknown> {
  const args = parsePlainTextToolAttributes(attributes);
  const childPattern = /<([a-zA-Z0-9_-]+)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g;
  let match: RegExpExecArray | null;
  let childCount = 0;
  while ((match = childPattern.exec(body)) !== null) {
    childCount += 1;
    args[match[1]] = decodeXmlText(match[2]).trim();
  }

  const trimmedBody = decodeXmlText(body).trim();
  if (childCount === 0 && trimmedBody.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmedBody) as Record<string, unknown>;
      return { ...args, ...parsed };
    } catch {
      return args;
    }
  }

  return args;
}

function extractPlainTextToolCall(input: {
  text: string;
  availableToolNames: Set<string>;
  alreadyExecuted: Set<string>;
}): PlainTextToolCall | null {
  const pattern = /<([a-zA-Z][a-zA-Z0-9_]*)(\s[^>]*)?>([\s\S]*?)<\/\1>/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(input.text)) !== null) {
    const toolName = match[1];
    if (
      !input.availableToolNames.has(toolName) ||
      toolName === setChatSummaryTool.name
    ) {
      continue;
    }

    const toolDef = findToolDefinition(toolName);
    if (!toolDef) continue;

    const rawArgs = parsePlainTextToolArgs(match[2] ?? "", match[3] ?? "");
    const parsedArgs = toolDef.inputSchema.safeParse(rawArgs);
    if (!parsedArgs.success) {
      continue;
    }

    const signature = `${toolName}:${JSON.stringify(parsedArgs.data)}`;
    if (input.alreadyExecuted.has(signature)) {
      continue;
    }

    return {
      toolName,
      args: parsedArgs.data as Record<string, unknown>,
      signature,
    };
  }

  return null;
}

function stringifyManualToolResult(result: unknown): string {
  if (
    result &&
    typeof result === "object" &&
    "type" in result &&
    (result as { type?: unknown }).type === "text" &&
    "value" in result
  ) {
    return String((result as { value?: unknown }).value ?? "");
  }
  return typeof result === "string" ? result : JSON.stringify(result, null, 2);
}

function buildChatMessageHistory(
  chatMessages: Array<
    DbMessageForParsing & {
      isCompactionSummary: boolean | null;
      createdAt: Date;
    }
  >,
  options?: { excludeMessageIds?: Set<number> },
): ModelMessage[] {
  const excludedIds = options?.excludeMessageIds;
  const relevantMessages = getPostCompactionMessages(chatMessages);
  const reorderedMessages = [...relevantMessages];

  // For mid-turn compaction, keep the summary immediately after the triggering
  // user message so subsequent turns reflect that compaction happened before
  // post-compaction tool-loop steps.
  for (const summary of [...reorderedMessages].filter(
    (message) => message.isCompactionSummary,
  )) {
    const summaryIndex = reorderedMessages.findIndex(
      (m) => m.id === summary.id,
    );
    if (summaryIndex < 0) {
      continue;
    }

    const triggeringUser = [...reorderedMessages]
      .filter((m) => m.role === "user" && m.id < summary.id)
      .sort((a, b) => b.id - a.id)[0];
    if (!triggeringUser) {
      continue;
    }

    const triggeringUserIndex = reorderedMessages.findIndex(
      (m) => m.id === triggeringUser.id,
    );
    if (triggeringUserIndex < 0) {
      continue;
    }

    const isMidTurnSummary =
      summary.createdAt.getTime() >= triggeringUser.createdAt.getTime();
    if (!isMidTurnSummary || summaryIndex === triggeringUserIndex + 1) {
      continue;
    }

    reorderedMessages.splice(summaryIndex, 1);
    const targetIndex = Math.min(
      triggeringUserIndex + 1,
      reorderedMessages.length,
    );
    reorderedMessages.splice(targetIndex, 0, summary);
  }

  const filtered = reorderedMessages
    .filter((msg) => !excludedIds?.has(msg.id))
    .filter((msg) => msg.content || msg.aiMessagesJson);

  // Filter out cancelled message pairs (user prompt + cancelled assistant response)
  // so the AI doesn't try to reconcile cancelled/incorrect prompts with new ones.
  return filterCancelledMessagePairs(filtered).flatMap((msg) =>
    parseAiMessagesJson(msg),
  );
}

/**
 * Append a `<system-reminder>` to the latest user message listing referenced
 * apps so the agent knows which `app_name` values it can pass to read-only
 * tools (`read_file`, `list_files`, `grep`, `code_search`). Mutates the last
 * user message in-place to avoid copying unrelated parts of the history.
 */
function injectReferencedAppsReminder(
  messageHistory: ModelMessage[],
  referencedApps: readonly { appName: string }[],
): void {
  const list = referencedApps.map(({ appName }) => `\`${appName}\``).join(", ");
  const reminder = `\n\n<system-reminder>\nThe user has mentioned the following apps in their prompt: ${list}. These apps are separate from the current app and are READ-ONLY. To inspect them, pass the app name as the \`app_name\` parameter to read-only tools (\`read_file\`, \`list_files\`, \`grep\`, \`code_search\`); matching is case-insensitive. Write tools cannot target these apps. Omit \`app_name\` to operate on the current app.\n</system-reminder>`;

  for (let i = messageHistory.length - 1; i >= 0; i--) {
    const msg = messageHistory[i];
    if (msg.role !== "user") continue;
    if (typeof msg.content === "string") {
      messageHistory[i] = { ...msg, content: msg.content + reminder };
    } else {
      messageHistory[i] = {
        ...msg,
        content: [...msg.content, { type: "text", text: reminder }],
      };
    }
    return;
  }
}

function injectUserMessageReminder(
  messageHistory: ModelMessage[],
  reminder: string,
): void {
  for (let i = messageHistory.length - 1; i >= 0; i--) {
    const msg = messageHistory[i];
    if (msg.role !== "user") continue;
    if (typeof msg.content === "string") {
      messageHistory[i] = { ...msg, content: `${msg.content}\n\n${reminder}` };
    } else {
      messageHistory[i] = {
        ...msg,
        content: [...msg.content, { type: "text", text: `\n\n${reminder}` }],
      };
    }
    return;
  }
}

function hasCompletedNativePackage(response: string): boolean {
  return /<orianbuilder-native-package\b[^>]*status="passed"/.test(response);
}

function buildNativeTargetFollowUpMessage(
  intent: NativeTargetIntent,
): ModelMessage {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `${buildNativeTargetReminder(intent)}\n\nYou have not completed the required native packaging artifact yet. Continue now. Do not stop after web UI work; run project checks and package_native_artifact with target="${intent.target}".`,
      },
    ],
  };
}

function getMidTurnCompactionSummaryIds(
  chatMessages: Array<{
    id: number;
    role: string;
    createdAt: Date;
    isCompactionSummary: boolean | null;
  }>,
): Set<number> {
  const hiddenIds = new Set<number>();

  for (const summary of chatMessages.filter((m) => m.isCompactionSummary)) {
    const triggeringUserMessage = [...chatMessages]
      .filter((m) => m.role === "user" && m.id < summary.id)
      .sort((a, b) => b.id - a.id)[0];

    if (!triggeringUserMessage) {
      continue;
    }

    if (
      summary.createdAt.getTime() >= triggeringUserMessage.createdAt.getTime()
    ) {
      hiddenIds.add(summary.id);
    }
  }

  return hiddenIds;
}

/**
 * Handle a chat stream in local-agent mode
 */
export async function handleLocalAgentStream(
  event: IpcMainInvokeEvent,
  req: ChatStreamParams,
  abortController: AbortController,
  {
    placeholderMessageId,
    systemPrompt,
    orianbuilderRequestId,
    readOnly = false,
    planModeOnly = false,
    messageOverride,
    settingsOverride,
    referencedApps = [],
    workspacePathOverride,
    workerId,
  }: {
    placeholderMessageId: number;
    systemPrompt: string;
    orianbuilderRequestId: string;
    /**
     * If true, the agent operates in read-only mode (e.g., ask mode).
     * State-modifying tools are disabled, and no commits/deploys are made.
     */
    readOnly?: boolean;
    /**
     * If true, only include tools allowed in plan mode.
     * This includes read-only exploration tools and planning-specific tools.
     */
    planModeOnly?: boolean;
    /**
     * If provided, use these messages instead of fetching from the database.
     * Used for summarization where messages need to be transformed.
     */
    messageOverride?: ModelMessage[];
    settingsOverride?: UserSettings;
    /**
     * Apps referenced via `@app:Name` mentions in the user's prompt.
     * Read-only tools can target these via an `app_name` parameter.
     */
    referencedApps?: {
      appName: string;
      appPath: string;
    }[];
    /**
     * Override the filesystem workspace used by local-agent tools. Mission
     * workers use this to operate inside an isolated git worktree while keeping
     * the parent app/chat identity for mission logging.
     */
    workspacePathOverride?: string;
    workerId?: number;
  },
): Promise<boolean> {
  const settings = settingsOverride ?? readSettings();
  const missionId = req.missionId;
  let missionRunId: number | null = null;
  let totalStepsExecuted = 0;
  const missionStartedAtMs = Date.now();
  const maxToolCallSteps =
    settings.maxToolCallSteps ?? DEFAULT_MAX_TOOL_CALL_STEPS;
  let toolFailureBudget = createToolFailureBudgetState();
  const missionBudgetAbort: {
    tool: Extract<ToolFailureBudgetDecision, { exceeded: true }> | null;
    runtime: ReturnType<typeof getMissionRuntimeBudgetStatus> | null;
  } = {
    tool: null,
    runtime: null,
  };
  let fullResponse = "";
  let streamingPreview = ""; // Temporary preview for current tool, not persisted
  let activeRetryReplayEvents: RetryReplayEvent[] | null = null;
  // Mid-turn compaction inserts a DB summary row for LLM history, but we render
  // the user-facing compaction indicator inline in the active assistant turn.
  const hiddenMessageIdsForStreaming = new Set<number>();
  let postMidTurnCompactionStartStep: number | null = null;

  const appendInlineCompactionToTurn = async (
    summary?: string,
    backupPath?: string,
  ) => {
    const summaryText =
      summary && summary.trim().length > 0
        ? summary
        : "Conversation compacted.";
    const inlineCompaction = `<orianbuilder-compaction title="Conversation compacted" state="finished">\n${escapeXmlContent(summaryText)}\n</orianbuilder-compaction>`;
    const backupPathNote = backupPath
      ? `\nIf you need to retrieve earlier parts of the conversation history, you can read the backup file at: ${backupPath}\nNote: This file may be large. Read only the sections you need or use grep to search for specific content rather than reading the entire file.`
      : "";
    const separator =
      fullResponse.length > 0 && !fullResponse.endsWith("\n") ? "\n" : "";
    fullResponse = `${fullResponse}${separator}${inlineCompaction}${backupPathNote}\n`;
    await updateResponseInDb(placeholderMessageId, fullResponse);
  };

  const loadChat = async () =>
    db.query.chats.findFirst({
      where: eq(chats.id, req.chatId),
      with: {
        messages: {
          orderBy: (messages, { asc }) => [asc(messages.createdAt)],
        },
        app: true,
      },
    });

  // Get the chat and app — may be re-queried after compaction
  const initialChat = await loadChat();

  if (!initialChat || !initialChat.app) {
    throw new OrianBuilderError(
      `Chat not found: ${req.chatId}`,
      OrianBuilderErrorKind.NotFound,
    );
  }

  let chat = initialChat;

  for (const id of getMidTurnCompactionSummaryIds(chat.messages)) {
    hiddenMessageIdsForStreaming.add(id);
  }

  const appPath =
    workspacePathOverride ?? getOrianBuilderAppPath(chat.app.path);
  const activeMission = missionId
    ? await db.query.missions.findFirst({
        where: eq(missions.id, missionId),
      })
    : null;
  const autonomyProfile: MissionAutonomyProfile =
    activeMission?.autonomyProfile ??
    settings.defaultMissionAutonomyProfile ??
    (settings.autonomousMode ? "full-autopilot-sandbox" : "supervised");
  const mcpToolTrustOverrides: McpToolTrustOverrideMap =
    await getMcpToolTrustOverridesByToolKey().catch((err) => {
      logger.warn("Failed to load MCP tool trust overrides:", err);
      return {};
    });
  const missionRun = await startMissionRun({
    missionId,
    chatId: req.chatId,
    messageId: placeholderMessageId,
    model: getMissionRunModelName(settings),
    requestId: orianbuilderRequestId,
    metadata: {
      appId: chat.app.id,
      provider: settings.selectedModel.provider,
      readOnly,
      planModeOnly,
      autonomyProfile,
      maxToolCallSteps,
      runtimeBudgetMs: MISSION_RUNTIME_BUDGET_MS,
      retryPolicy: {
        maxRetries: MAX_TERMINATED_STREAM_RETRIES,
        baseDelayMs: STREAM_RETRY_BASE_DELAY_MS,
      },
      workspacePathOverride: workspacePathOverride ?? null,
      workerId: workerId ?? null,
    },
  }).catch((err) => {
    logger.warn("Failed to start mission run:", err);
    return null;
  });
  missionRunId = missionRun?.id ?? null;
  const mcpSessionId = missionRunId
    ? `mission-run:${missionRunId}`
    : `chat:${req.chatId}:${orianbuilderRequestId}`;
  await logMissionEvent({
    missionId,
    eventType: "agent_stream_started",
    summary: "Agent stream started",
    metadata: {
      chatId: req.chatId,
      appId: chat.app.id,
      readOnly,
      planModeOnly,
      autonomyProfile,
      maxToolCallSteps,
      runtimeBudgetMs: MISSION_RUNTIME_BUDGET_MS,
    },
  }).catch((err) => logger.warn("Failed to log mission start event:", err));

  const maybePerformPendingCompaction = async (options?: {
    showOnTopOfCurrentResponse?: boolean;
    force?: boolean;
  }) => {
    if (
      settings.enableContextCompaction === false ||
      (!options?.force && !(await isChatPendingCompaction(req.chatId)))
    ) {
      return false;
    }

    logger.info(`Performing pending compaction for chat ${req.chatId}`);
    const existingCompactionSummaryIds = new Set(
      chat.messages
        .filter((message) => message.isCompactionSummary)
        .map((message) => message.id),
    );
    const compactionResult = await performCompaction(
      event,
      req.chatId,
      appPath,
      orianbuilderRequestId,
      (accumulatedSummary: string) => {
        // Stream compaction summary to the frontend in real-time.
        // During mid-turn compaction, keep already streamed content visible.
        const compactionPreview = `<orianbuilder-compaction title="Compacting conversation">\n${escapeXmlContent(accumulatedSummary)}\n</orianbuilder-compaction>`;
        const previewContent = options?.showOnTopOfCurrentResponse
          ? `${fullResponse}${streamingPreview ? streamingPreview : ""}\n${compactionPreview}`
          : compactionPreview;
        sendResponseChunk(
          event,
          req.chatId,
          chat,
          previewContent,
          placeholderMessageId,
          hiddenMessageIdsForStreaming,
          true, // Full messages: compaction changes message list
        );
      },
      {
        // Mid-turn compaction should not render as a separate message above the
        // current turn on subsequent streams, so keep its DB timestamp in turn order.
        createdAtStrategy: options?.showOnTopOfCurrentResponse
          ? "now"
          : "before-latest-user",
      },
    );
    if (!compactionResult.success) {
      logger.warn(
        `Compaction failed for chat ${req.chatId}: ${compactionResult.error}`,
      );
      // Continue anyway - compaction failure shouldn't block the conversation
    }

    // Re-query to pick up the newly inserted compaction summary message.
    // Only update if compaction succeeded — a failed compaction may have left
    // partial state that would corrupt subsequent message history.
    if (compactionResult.success) {
      const refreshedChat = await loadChat();
      if (refreshedChat?.app) {
        chat = refreshedChat;
      }

      if (options?.showOnTopOfCurrentResponse) {
        for (const message of chat.messages) {
          if (
            message.isCompactionSummary &&
            !existingCompactionSummaryIds.has(message.id)
          ) {
            hiddenMessageIdsForStreaming.add(message.id);
          }
        }
        await appendInlineCompactionToTurn(
          compactionResult.summary,
          compactionResult.backupPath,
        );
      }
    }

    if (options?.showOnTopOfCurrentResponse) {
      sendResponseChunk(
        event,
        req.chatId,
        chat,
        fullResponse + streamingPreview,
        placeholderMessageId,
        hiddenMessageIdsForStreaming,
        true, // Full messages: post-compaction refresh
      );
    }

    return compactionResult.success;
  };

  // Check if compaction is pending and enabled before processing the message
  await maybePerformPendingCompaction();

  // Send initial message update
  safeSend(event.sender, "chat:response:chunk", {
    chatId: req.chatId,
    messages: chat.messages.filter(
      (message) => !hiddenMessageIdsForStreaming.has(message.id),
    ),
  });

  // Track pending user messages to inject after tool results
  const pendingUserMessages: UserMessageContentPart[][] = [];
  // Store injected messages with their insertion index to re-inject at the same spot each step
  const allInjectedMessages: InjectedMessage[] = [];
  const warningMessages: string[] = [];
  let missionStepCheckpointCount = 0;
  // Counts native + fallback tool executions for this run. Used at stream
  // completion to detect "dead" runs where the model never produced a usable
  // tool call (common with local GGUFs lacking function-call support).
  let totalNativeToolCalls = 0;
  let totalFallbackToolCalls = 0;
  let textToolCallFallbackAttempts = 0;
  const MAX_TEXT_TOOL_CALL_FALLBACK_ATTEMPTS = 6;
  const recentStepSignatures: string[] = [];
  const warnedStepLoopSignatures = new Set<string>();

  try {
    // Get model client
    const { modelClient } = await getModelClient(
      settings.selectedModel,
      settings,
    );
    const nativeTargetIntent =
      !readOnly && !planModeOnly && !messageOverride
        ? await detectNativeTargetIntentWithModel({
            prompt: req.prompt,
            model: modelClient.model,
          })
        : null;

    // Load persisted todos from a previous turn (if any)
    const persistedTodos = await loadTodos(appPath, chat.id);
    // Ensure .orianbuilder/ is gitignored (idempotent; also done by compaction/plans)
    // Skip in read-only/plan-only mode to avoid modifying the workspace
    if (!readOnly && !planModeOnly) {
      await ensureOrianBuilderGitignored(appPath).catch((err: unknown) =>
        logger.warn("Failed to ensure .orianbuilder gitignored:", err),
      );
    }
    if (persistedTodos.length > 0) {
      // Emit loaded todos to the renderer so the UI shows them immediately
      safeSend(event.sender, "agent-tool:todos-update", {
        chatId: chat.id,
        todos: persistedTodos,
      });
    }

    // Build tool execute context
    const fileEditTracker: FileEditTracker = Object.create(null);
    const referencedAppsMap = new Map(
      referencedApps.map((ref) => [ref.appName.toLowerCase(), ref.appPath]),
    );
    let producedNativePackageArtifact = false;
    let attemptedNativePackageArtifact = false;
    let producedDeploymentUrl = false;
    let producedBrowserQaScreenshotArtifact = false;
    let passedBrowserQaGate = false;
    const ctx: AgentContext = {
      event,
      appId: chat.app.id,
      appPath,
      referencedApps: referencedAppsMap,
      chatId: chat.id,
      missionId,
      missionRunId,
      workerId: workerId ?? null,
      supabaseProjectId: chat.app.supabaseProjectId,
      supabaseOrganizationSlug: chat.app.supabaseOrganizationSlug,
      neonProjectId: chat.app.neonProjectId,
      neonActiveBranchId:
        chat.app.neonActiveBranchId ?? chat.app.neonDevelopmentBranchId,
      frameworkType: detectFrameworkType(appPath),
      messageId: placeholderMessageId,
      isSharedModulesChanged: false,
      todos: persistedTodos,
      orianbuilderRequestId,
      fileEditTracker,
      installEtargetRecoveryCount: 0,
      isOrianBuilderPro: isOrianBuilderProEnabled(settings),
      onXmlStream: (accumulatedXml: string) => {
        // Stream accumulated XML to UI without persisting
        streamingPreview = accumulatedXml;
        sendResponseChunk(
          event,
          req.chatId,
          chat,
          fullResponse + streamingPreview,
          placeholderMessageId,
          hiddenMessageIdsForStreaming,
        );
      },
      onXmlComplete: (finalXml: string) => {
        if (finalXml.startsWith("<orianbuilder-native-package")) {
          attemptedNativePackageArtifact = true;
        }
        if (
          finalXml.startsWith("<orianbuilder-native-package") &&
          /\bstatus="passed"/.test(finalXml)
        ) {
          producedNativePackageArtifact = true;
        }
        const deploymentUrl = finalXml.startsWith(
          "<orianbuilder-deploy-preview",
        )
          ? finalXml.match(/\burl="([^"]+)"/)?.[1]
          : null;
        if (deploymentUrl) {
          producedDeploymentUrl = true;
        }
        if (
          (finalXml.startsWith("<orianbuilder-screenshot") ||
            finalXml.startsWith("<orianbuilder-browser-action")) &&
          /\bpath="[^"]+"/.test(finalXml)
        ) {
          producedBrowserQaScreenshotArtifact = true;
        }
        if (finalXml.startsWith("<orianbuilder-browser-qa")) {
          const hasDesktopScreenshot = /\bdesktop-path="[^"]+"/.test(finalXml);
          const hasMobileScreenshot = /\bmobile-path="[^"]+"/.test(finalXml);
          const screenshotGatePassed =
            /\bscreenshot-status="passed"/.test(finalXml) &&
            hasDesktopScreenshot &&
            hasMobileScreenshot;
          producedBrowserQaScreenshotArtifact =
            producedBrowserQaScreenshotArtifact || screenshotGatePassed;
          passedBrowserQaGate =
            /\bstatus="passed"/.test(finalXml) && screenshotGatePassed;
        }
        // Write final XML to DB and UI
        const xmlChunk = `${finalXml}\n`;
        fullResponse += xmlChunk;
        streamingPreview = ""; // Clear preview
        logMissionEventsForXml({
          missionId,
          missionRunId,
          workerId,
          chatId: req.chatId,
          xml: finalXml,
        }).catch((err) =>
          logger.warn("Failed to log mission agent output event:", err),
        );
        updateResponseInDb(placeholderMessageId, fullResponse);
        sendResponseChunk(
          event,
          req.chatId,
          chat,
          fullResponse,
          placeholderMessageId,
          hiddenMessageIdsForStreaming,
        );
      },
      requireConsent: async (params: {
        toolName: string;
        toolDescription?: string | null;
        inputPreview?: string | null;
      }) => {
        const policy = getAutonomyPolicyDecision({
          profile: autonomyProfile,
          runtimeMode: settings.runtimeMode2 ?? "host",
          toolName: params.toolName,
          inputPreview: params.inputPreview,
          mcpToolTrustOverrides,
        });
        logMissionEvent({
          missionId,
          eventType: "agent_tool_policy_decision",
          summary: `${policy.decision.replace("_", " ")}: ${params.toolName}`,
          metadata: {
            chatId: chat.id,
            toolName: params.toolName,
            decision: policy.decision,
            risk: policy.risk,
            reason: policy.reason,
            autonomyProfile,
            runtimeMode: settings.runtimeMode2 ?? "host",
            mcpTrustOverrideApplied: mcpToolTrustOverrides[params.toolName]
              ? true
              : undefined,
          },
        }).catch((err) =>
          logger.warn("Failed to log autonomy policy decision:", err),
        );

        if (policy.decision === "deny") {
          throw new OrianBuilderError(
            policy.reason,
            OrianBuilderErrorKind.Precondition,
          );
        }

        if (policy.decision === "auto_approve") {
          logger.info(
            `Autonomy policy auto-approved local-agent tool ${params.toolName} for chat ${chat.id}`,
          );
          return true;
        }

        const permissionRequest = missionId
          ? await createMissionPermissionRequestForTool({
              missionId,
              runId: missionRunId,
              toolName: params.toolName,
              inputPreview: params.inputPreview,
              risk: policy.risk === "critical" ? "high" : policy.risk,
              reason: policy.reason,
            }).catch((err) => {
              logger.warn("Failed to persist permission request:", err);
              return null;
            })
          : null;
        const allowed = await requireAgentToolConsent(event, {
          chatId: chat.id,
          toolName: params.toolName as AgentToolName,
          toolDescription: params.toolDescription,
          inputPreview: params.inputPreview,
        });
        if (permissionRequest) {
          await resolveMissionPermissionRequestForTool({
            requestId: permissionRequest.id,
            status: allowed ? "approved" : "denied",
          }).catch((err) =>
            logger.warn("Failed to resolve permission request:", err),
          );
        }
        return allowed;
      },
      appendUserMessage: (content: UserMessageContentPart[]) => {
        pendingUserMessages.push(content);
      },
      onUpdateTodos: (todos) => {
        safeSend(event.sender, "agent-tool:todos-update", {
          chatId: chat.id,
          todos,
        });
        syncMissionTasksFromTodos({ missionId, todos }).catch((err) =>
          logger.warn("Failed to sync mission tasks:", err),
        );
      },
      onWarningMessage: (message) => {
        warningMessages.push(message);
      },
      onToolExecutionStart: (params) => {
        if (params.toolName === packageNativeArtifactTool.name) {
          attemptedNativePackageArtifact = true;
        }
        logMissionEvent({
          missionId,
          eventType: "agent_tool_execution_started",
          summary: `Tool started: ${params.toolName}`,
          metadata: {
            chatId: chat.id,
            runId: missionRunId,
            workerId: workerId ?? null,
            toolName: params.toolName,
            inputPreview: params.inputPreview ?? null,
            modifiesState: params.modifiesState,
          },
        }).catch((err) =>
          logger.warn("Failed to log tool execution start:", err),
        );
      },
      onToolExecutionComplete: (params) => {
        if (params.status === "failed") {
          const decision = recordToolFailureForBudget({
            state: toolFailureBudget,
            toolName: params.toolName,
          });
          toolFailureBudget = decision.state;
          if (decision.exceeded && !missionBudgetAbort.tool) {
            missionBudgetAbort.tool = decision;
            abortController.abort();
          }
        } else {
          toolFailureBudget = recordToolSuccessForBudget({
            state: toolFailureBudget,
            toolName: params.toolName,
          });
        }
        const metadata = {
          chatId: chat.id,
          runId: missionRunId,
          workerId: workerId ?? null,
          toolName: params.toolName,
          status: params.status,
          durationMs: params.durationMs,
          outputPreview: params.outputPreview ?? null,
          error: params.error ?? null,
          modifiesState: params.modifiesState,
          failureBudget: {
            totalFailures: toolFailureBudget.totalFailures,
            consecutiveFailures:
              toolFailureBudget.consecutiveFailuresByTool[params.toolName] ?? 0,
          },
        };
        logMissionEvent({
          missionId,
          eventType: "agent_tool_execution_completed",
          summary: `Tool ${params.status}: ${params.toolName}`,
          metadata,
        }).catch((err) =>
          logger.warn("Failed to log tool execution completion:", err),
        );
        createMissionCheckpoint({
          missionId,
          runId: missionRunId,
          summary: `Tool ${params.status}: ${params.toolName}`,
          metadata,
        }).catch((err) =>
          logger.warn("Failed to checkpoint tool execution:", err),
        );
      },
    };

    // Build tool set (agent tools + MCP tools)
    // In read-only mode, only include read-only tools and skip MCP tools
    // (since we can't determine if MCP tools modify state)
    // In plan mode, only include planning tools (read + questionnaire/plan tools)
    const agentTools = buildAgentToolSet(ctx, {
      readOnly,
      planModeOnly,
      autopilotMode: autonomyProfile === "full-autopilot-sandbox",
    });
    const mcpTools =
      readOnly || planModeOnly
        ? {}
        : await getMcpTools(event, ctx, mcpSessionId);
    const allTools: ToolSet = { ...agentTools, ...mcpTools };

    // Prepare message history with graceful fallback
    // Use messageOverride if provided (e.g., for summarization)
    // If a compaction summary exists, only include messages from that point onward
    // (pre-compaction messages are preserved in DB for the user but not sent to LLM)
    const messageHistory: ModelMessage[] = messageOverride
      ? messageOverride
      : buildChatMessageHistory(chat.messages);

    // Inject the referenced-apps manifest into the user's latest message as a
    // `<system-reminder>` block (instead of appending it to the system prompt)
    // so the system prompt stays static and cacheable.
    if (referencedApps.length > 0) {
      injectReferencedAppsReminder(messageHistory, referencedApps);
    }
    if (nativeTargetIntent) {
      injectUserMessageReminder(
        messageHistory,
        `<system-reminder>\n${buildNativeTargetReminder(nativeTargetIntent)}\n</system-reminder>`,
      );
    }

    // Used to swap out pre-compaction history while preserving in-flight turn steps.
    let baseMessageHistoryCount = messageHistory.length;
    let compactBeforeNextStep = false;
    let compactedMidTurn = false;
    let compactionFailedMidTurn = false;
    // Tracks the difference between the compacted base message count and the
    // SDK's initialMessages count. Used to adjust injection indices after
    // compaction so that subsequent steps (which use the SDK's shorter base)
    // inject user messages at the correct position.
    let compactionIndexDelta = 0;

    const maxOutputTokens = await getMaxTokens(settings.selectedModel);
    const temperature =
      settings.selectedModel.provider === "embedded"
        ? undefined
        : await getTemperature(settings.selectedModel);

    // Run one or more generation passes. If the model emits a chat message while
    // there are still incomplete todos, we append a reminder and do another pass.
    const maxTodoFollowUpLoops = 1;
    let todoFollowUpLoops = 0;
    const maxNativeTargetFollowUpLoops = 0;
    let nativeTargetFollowUpLoops = 0;
    const maxPlainTextToolFollowUpLoops = 6;
    let plainTextToolFollowUpLoops = 0;
    const executedPlainTextToolSignatures = new Set<string>();
    let hasInjectedPlanningQuestionnaireReflection = false;
    let hasInjectedMissionMemories = false;
    let currentMessageHistory = messageHistory;
    const accumulatedAiMessages: ModelMessage[] = [];
    // Track total steps across all passes to detect step limit

    // If there are persisted todos from a previous turn, inject a synthetic
    // user message so the LLM is aware of them. Inserted BEFORE the user's
    // current message so the user's actual request is the last thing the LLM
    // reads, giving it natural priority over stale todos.
    if (
      !messageOverride &&
      !readOnly &&
      !planModeOnly &&
      persistedTodos.length > 0 &&
      hasIncompleteTodos(persistedTodos)
    ) {
      const incompleteTodos = persistedTodos.filter(
        (t) => t.status === "pending" || t.status === "in_progress",
      );
      const todoSummary = formatTodoSummary(incompleteTodos);
      const syntheticMessage: ModelMessage = {
        role: "user",
        content: [
          {
            type: "text",
            text: `[System] You have unfinished todos from your previous turn:\n${todoSummary}\n\nThe user's next message is their current request. If their request relates to these todos, continue working on them. If their request is about something different, discard these old todos by calling update_todos with merge=false and an empty list, then focus entirely on the user's new request.`,
          },
        ],
      };
      // Insert before the last message (the user's current message) so the
      // user's intent is the final thing the LLM sees.
      const insertIndex = Math.max(0, currentMessageHistory.length - 1);
      currentMessageHistory = [
        ...currentMessageHistory.slice(0, insertIndex),
        syntheticMessage,
        ...currentMessageHistory.slice(insertIndex),
      ];
    }

    while (!abortController.signal.aborted) {
      // Reset mid-turn compaction state at the start of each pass.
      // These flags track compaction within a single pass and must not persist
      // across passes (e.g., todo follow-up passes).
      compactedMidTurn = false;
      compactionFailedMidTurn = false;
      compactBeforeNextStep = false;
      compactionIndexDelta = 0;
      postMidTurnCompactionStartStep = null;
      baseMessageHistoryCount = currentMessageHistory.length;

      let passProducedChatText = false;
      let responseMessages: ModelMessage[] = [];
      let steps: Array<{
        toolCalls: Array<unknown>;
        response?: { messages?: ModelMessage[] };
      }> = [];
      let terminatedRetryCount = 0;
      let needsContinuationInstruction = false;

      // Retry loop: if the stream terminates with a transient error, captured text/tool events are replayed into message history, a continuation instruction is appended, and the stream is re-opened.
      while (!abortController.signal.aborted) {
        let streamErrorFromCallback: unknown;
        const retryReplayEvents: RetryReplayEvent[] = [];
        activeRetryReplayEvents = retryReplayEvents;
        const attemptMessages = needsContinuationInstruction
          ? [
              ...currentMessageHistory,
              buildTerminatedRetryContinuationInstruction(),
            ]
          : currentMessageHistory;
        const attemptToolInputIds = new Set<string>();
        const cleanupAttemptToolStreamingEntries = () => {
          for (const toolCallId of attemptToolInputIds) {
            cleanupStreamingEntry(toolCallId);
          }
          attemptToolInputIds.clear();
        };

        try {
          const streamResult = streamText({
            model: modelClient.model,
            headers: {
              ...getAiHeaders({
                builtinProviderId: modelClient.builtinProviderId,
              }),
              [ORIANBUILDER_INTERNAL_REQUEST_ID_HEADER]: orianbuilderRequestId,
            },
            providerOptions: getProviderOptions({
              orianbuilderAppId: chat.app.id,
              orianbuilderRequestId,
              orianbuilderDisableFiles: true, // Local agent uses tools, not file injection
              files: [],
              mentionedAppsCodebases: [],
              builtinProviderId: modelClient.builtinProviderId,
              settings,
            }),
            maxOutputTokens,
            temperature,
            maxRetries: 2,
            system: systemPrompt,
            messages: attemptMessages,
            tools: allTools,
            stopWhen: [
              stepCountIs(maxToolCallSteps),
              // User needs to explicitly set up integration before AI can continue.
              hasToolCall(addIntegrationTool.name),
              ...(nativeTargetIntent
                ? [
                    hasRepeatedToolSignature(
                      "run_project_check",
                      MISSION_REPEATED_STEP_LOOP_LIMIT - 1,
                    ),
                    hasToolCall(browserQaGateTool.name),
                    hasToolCall(packageNativeArtifactTool.name),
                    hasToolCall(deployPreviewTool.name),
                  ]
                : []),
              // In plan mode, also stop after writing a plan or exiting plan mode.
              ...(planModeOnly
                ? [
                    hasToolCall(writePlanTool.name),
                    hasToolCall(exitPlanTool.name),
                  ]
                : []),
            ],
            abortSignal: abortController.signal,
            // Inject pending user messages (e.g., images from web_crawl) between steps
            // We must re-inject all accumulated messages each step because the AI SDK
            // doesn't persist dynamically injected messages in its internal state.
            // We track the insertion index so messages appear at the same position each step.
            prepareStep: async (options) => {
              let stepOptions = options;

              if (
                !messageOverride &&
                compactBeforeNextStep &&
                !compactedMidTurn &&
                settings.enableContextCompaction !== false
              ) {
                compactBeforeNextStep = false;
                const inFlightTailMessages = options.messages.slice(
                  baseMessageHistoryCount,
                );
                const compacted = await maybePerformPendingCompaction({
                  showOnTopOfCurrentResponse: true,
                  force: true,
                });

                if (compacted) {
                  compactedMidTurn = true;
                  // Preserve only messages generated after this compaction boundary.
                  postMidTurnCompactionStartStep = options.stepNumber;
                  // Clear stale injected messages — their insertAtIndex values are
                  // based on the pre-compaction message array which has been rebuilt
                  // with a different (typically smaller) count. Keeping them would
                  // cause injectMessagesAtPositions to splice at wrong positions.
                  allInjectedMessages.length = 0;
                  const preCompactionBaseCount = baseMessageHistoryCount;
                  const compactedMessageHistory = buildChatMessageHistory(
                    chat.messages,
                    {
                      // Keep the structured in-flight assistant/tool messages from
                      // the current stream instead of the placeholder DB content.
                      excludeMessageIds: new Set([placeholderMessageId]),
                    },
                  );
                  // The referenced-apps reminder lives only in-memory on the
                  // latest user message and is not persisted, so rebuilding
                  // history from the DB drops it. Re-inject so post-compaction
                  // tool steps keep the explicit app_name allow-list.
                  if (referencedApps.length > 0) {
                    injectReferencedAppsReminder(
                      compactedMessageHistory,
                      referencedApps,
                    );
                  }
                  if (nativeTargetIntent) {
                    injectUserMessageReminder(
                      compactedMessageHistory,
                      `<system-reminder>\n${buildNativeTargetReminder(nativeTargetIntent)}\n</system-reminder>`,
                    );
                  }
                  baseMessageHistoryCount = compactedMessageHistory.length;
                  // The compacted history includes the compaction summary, but the
                  // AI SDK's initialMessages does not. Track the delta so we can
                  // adjust injection indices after prepareStepMessages runs.
                  compactionIndexDelta =
                    baseMessageHistoryCount - preCompactionBaseCount;
                  stepOptions = {
                    ...options,
                    // Preserve in-flight turn messages so same-turn tool loops can
                    // continue, while later turns are compacted via persisted history.
                    messages: [
                      ...compactedMessageHistory,
                      ...inFlightTailMessages,
                    ],
                  };
                } else {
                  // Prevent repeated compaction attempts if the first one fails.
                  compactionFailedMidTurn = true;
                }
              }

              if (
                !messageOverride &&
                missionId &&
                activeMission &&
                !hasInjectedMissionMemories
              ) {
                const missionMemoryMessage = buildMissionMemoryMessage(
                  await loadMissionMemoriesForInjection({
                    appId: activeMission.appId,
                    missionId,
                  }),
                );
                if (missionMemoryMessage) {
                  stepOptions = {
                    ...stepOptions,
                    messages: [...stepOptions.messages, missionMemoryMessage],
                  };
                  await logMissionEvent({
                    missionId,
                    eventType: "mission_memories_injected",
                    summary: "Mission memories injected into agent loop",
                    metadata: {
                      runId: missionRunId,
                      chatId: req.chatId,
                    },
                  }).catch((err) =>
                    logger.warn("Failed to log memory injection:", err),
                  );
                }
                hasInjectedMissionMemories = true;
              }

              if (!messageOverride && missionId) {
                const pendingInterrupts =
                  await loadPendingMissionInterrupts(missionId);
                const interruptMessage =
                  buildMissionInterruptMessage(pendingInterrupts);
                if (interruptMessage) {
                  stepOptions = {
                    ...stepOptions,
                    messages: [...stepOptions.messages, interruptMessage],
                  };
                  await markMissionInterruptsInjected({
                    missionId,
                    interruptIds: pendingInterrupts.map(
                      (interrupt) => interrupt.id,
                    ),
                  });
                  await logMissionEvent({
                    missionId,
                    eventType: "mission_interrupts_injected",
                    summary: `${pendingInterrupts.length} interrupt${pendingInterrupts.length === 1 ? "" : "s"} injected into agent loop`,
                    metadata: {
                      runId: missionRunId,
                      interruptIds: pendingInterrupts.map(
                        (interrupt) => interrupt.id,
                      ),
                      sources: pendingInterrupts.map(
                        (interrupt) => interrupt.source,
                      ),
                    },
                  }).catch((err) =>
                    logger.warn("Failed to log interrupt injection:", err),
                  );
                }
              }

              const preparedStep = prepareStepMessages(
                stepOptions,
                pendingUserMessages,
                allInjectedMessages,
              );

              // After mid-turn compaction, injection indices are based on the
              // compacted message array (which includes the compaction summary).
              // The AI SDK's internal messages don't include this summary, so
              // subsequent steps have a shorter base. Adjust indices now so
              // future re-injections land at the correct position.
              if (compactionIndexDelta !== 0) {
                for (const injection of allInjectedMessages) {
                  injection.insertAtIndex = Math.max(
                    0,
                    injection.insertAtIndex - compactionIndexDelta,
                  );
                }
                // Always reset, even when no injections exist yet — a tool may
                // add pending messages in a later step and their indices should
                // not be shifted by a stale delta.
                compactionIndexDelta = 0;
              }

              // prepareStepMessages returns undefined when it has no additional
              // injections/cleanups to apply. If we already replaced the base
              // message history (e.g., after mid-turn compaction), we still need
              // to return the updated options.
              let result =
                preparedStep ??
                (stepOptions === options ? undefined : stepOptions);

              // Defensive: ensure injected user messages don't break
              // tool_use/tool_result pairing. Catches edge cases where
              // injection indices become stale after compaction.
              if (result?.messages) {
                const fixed = ensureToolResultOrdering(result.messages);
                if (fixed) {
                  logger.warn(
                    `ensureToolResultOrdering fixed misplaced user messages in chat ${req.chatId}`,
                  );
                  result = { ...result, messages: fixed };
                }
              }

              return result;
            },
            onStepFinish: async (step) => {
              if (!hasInjectedPlanningQuestionnaireReflection) {
                const questionnaireError =
                  getPlanningQuestionnaireErrorFromStep(step);
                if (questionnaireError) {
                  pendingUserMessages.push([
                    {
                      type: "text",
                      text: buildPlanningQuestionnaireReflectionMessage(
                        questionnaireError,
                        planModeOnly,
                      ),
                    },
                  ]);
                  hasInjectedPlanningQuestionnaireReflection = true;
                  logger.info(
                    `Injected synthetic planning_questionnaire reflection message for chat ${req.chatId}`,
                  );
                }
              }

              missionStepCheckpointCount += 1;
              const stepToolNames = getStepToolNames(step);
              const stepSignature = getStepSignature(step.toolCalls);
              const stepMetadata = {
                chatId: req.chatId,
                runId: missionRunId,
                stepNumber: missionStepCheckpointCount,
                totalStepsObserved:
                  totalStepsExecuted + missionStepCheckpointCount,
                toolNames: stepToolNames,
                toolCallCount: step.toolCalls.length,
                textLength: step.text?.length ?? 0,
                usage: step.usage,
              };

              totalNativeToolCalls += step.toolCalls.length;

              // Text-tool-call fallback: triggered when the model emits a tool
              // call as prose instead of through the AI SDK's structured slot
              // (common with local GGUFs like Qwen, DeepSeek, plain Llama 3.x).
              // We parse the text, execute what we safely can, and inject a
              // synthetic user message containing the results so the model can
              // continue. After MAX_TEXT_TOOL_CALL_FALLBACK_ATTEMPTS unsuccessful
              // recoveries, we abort the run so the user can switch models.
              if (
                step.toolCalls.length === 0 &&
                typeof step.text === "string" &&
                hasTextToolCallMarkers(step.text) &&
                textToolCallFallbackAttempts <
                  MAX_TEXT_TOOL_CALL_FALLBACK_ATTEMPTS
              ) {
                textToolCallFallbackAttempts += 1;
                try {
                  const outcome = await runTextToolCallFallback({
                    assistantText: step.text,
                    ctx,
                    autopilot:
                      autonomyProfile === "full-autopilot-sandbox" ||
                      autonomyProfile === "trusted-workspace",
                  });
                  if (outcome) {
                    totalFallbackToolCalls += outcome.executed.length;
                    if (outcome.reminder) {
                      pendingUserMessages.push(outcome.reminder);
                    }
                    await logMissionEvent({
                      missionId,
                      eventType: "model_emitted_tool_call_as_text",
                      summary: `Model emitted ${outcome.parsed.length} tool call(s) as text on step ${missionStepCheckpointCount}; recovered ${outcome.executed.length}, skipped ${outcome.failed.length}`,
                      metadata: {
                        ...stepMetadata,
                        attempt: textToolCallFallbackAttempts,
                        parsedToolNames: outcome.parsed.map(
                          (entry) => entry.toolName,
                        ),
                        executedToolNames: outcome.executed.map(
                          (entry) => entry.toolName,
                        ),
                        failedToolNames: outcome.failed.map(
                          (entry) => entry.toolName,
                        ),
                      },
                    }).catch((err) =>
                      logger.warn(
                        "Failed to log text-tool-call fallback event:",
                        err,
                      ),
                    );
                  }
                } catch (err) {
                  logger.warn(
                    "Text-tool-call fallback threw unexpectedly:",
                    err,
                  );
                }

                if (
                  textToolCallFallbackAttempts >=
                  MAX_TEXT_TOOL_CALL_FALLBACK_ATTEMPTS
                ) {
                  warningMessages.push(
                    "Model emitted tool calls as plain text repeatedly. Switch to a provider that supports function calling (OpenAI, Anthropic, Gemini, or a GGUF with a tool-call template) to continue.",
                  );
                  await logMissionEvent({
                    missionId,
                    eventType:
                      "model_emitted_tool_call_as_text_abort_threshold",
                    summary:
                      "Aborting stream: model repeatedly emitted tool calls as text",
                    metadata: {
                      ...stepMetadata,
                      attempts: textToolCallFallbackAttempts,
                    },
                  }).catch(() => {});
                  abortController.abort();
                }
              }

              await createMissionCheckpoint({
                missionId,
                runId: missionRunId,
                summary: `Agent step ${missionStepCheckpointCount} completed`,
                metadata: stepMetadata,
              }).catch((err) =>
                logger.warn("Failed to create mission step checkpoint:", err),
              );
              await logMissionEvent({
                missionId,
                eventType: "agent_step_checkpointed",
                summary: `Agent step ${missionStepCheckpointCount} checkpointed`,
                metadata: stepMetadata,
              }).catch((err) =>
                logger.warn("Failed to log mission step checkpoint:", err),
              );

              if (stepSignature) {
                recentStepSignatures.push(stepSignature);
                if (
                  recentStepSignatures.length > MISSION_REPEATED_STEP_LOOP_LIMIT
                ) {
                  recentStepSignatures.shift();
                }
                const isRepeatedLoop =
                  recentStepSignatures.length ===
                    MISSION_REPEATED_STEP_LOOP_LIMIT &&
                  recentStepSignatures.every(
                    (signature) => signature === stepSignature,
                  );
                if (
                  isRepeatedLoop &&
                  !warnedStepLoopSignatures.has(stepSignature)
                ) {
                  warnedStepLoopSignatures.add(stepSignature);
                  const loopMetadata = {
                    ...stepMetadata,
                    signature: stepSignature,
                    repeatedCount: recentStepSignatures.length,
                    repeatedStepLoopLimit: MISSION_REPEATED_STEP_LOOP_LIMIT,
                  };
                  await logMissionEvent({
                    missionId,
                    eventType: "mission_stuck_loop_warning",
                    summary: `Possible stuck loop: ${stepSignature}`,
                    metadata: loopMetadata,
                  }).catch((err) =>
                    logger.warn("Failed to log stuck-loop warning:", err),
                  );
                  await createMissionCheckpoint({
                    missionId,
                    runId: missionRunId,
                    summary: `Possible stuck loop: ${stepSignature}`,
                    metadata: loopMetadata,
                  }).catch((err) =>
                    logger.warn(
                      "Failed to checkpoint stuck-loop warning:",
                      err,
                    ),
                  );
                }
              }

              const runtimeBudgetStatus = getMissionRuntimeBudgetStatus({
                startedAtMs: missionStartedAtMs,
                nowMs: Date.now(),
              });
              if (runtimeBudgetStatus.exceeded) {
                missionBudgetAbort.runtime = runtimeBudgetStatus;
                abortController.abort();
              }

              if (
                settings.enableContextCompaction === false ||
                compactedMidTurn
              ) {
                return;
              }

              // Local providers (LM Studio, Ollama) don't return token counts.
              // Fall back to estimating from the step text so compaction
              // still fires before we hit the context limit.
              const stepTokens =
                typeof step.usage.totalTokens === "number"
                  ? step.usage.totalTokens
                  : estimateTokens(step.text ?? "");

              const shouldCompact = await checkAndMarkForCompaction(
                req.chatId,
                stepTokens,
              );

              // If this step triggered tool calls, compact before the next step
              // in this same user turn instead of waiting for the next message.
              // Only attempt mid-turn compaction once per turn.
              if (
                shouldCompact &&
                step.toolCalls.length > 0 &&
                !compactionFailedMidTurn
              ) {
                compactBeforeNextStep = true;
              }
            },
            onFinish: async (response) => {
              const totalTokens = response.usage?.totalTokens;
              // Fall back to text-based estimate for local providers
              const effectiveTotalTokens =
                typeof totalTokens === "number"
                  ? totalTokens
                  : estimateTokens(response.text ?? "");
              logger.log(
                "Total tokens used:",
                effectiveTotalTokens,
                totalTokens === undefined ? "(estimated)" : "",
              );
              await db
                .update(messages)
                .set({ maxTokensUsed: effectiveTotalTokens })
                .where(eq(messages.id, placeholderMessageId))
                .catch((err) =>
                  logger.error("Failed to save token count", err),
                );
            },
            onError: (error: any) => {
              const normalizedError = unwrapStreamError(error);
              streamErrorFromCallback = normalizedError;
              logger.error(
                "Local agent stream error:",
                getErrorMessage(normalizedError),
              );
            },
          });

          let inThinkingBlock = false;
          let streamErrorFromIteration: unknown;

          try {
            for await (const part of streamResult.fullStream) {
              if (abortController.signal.aborted) {
                logger.log(`Stream aborted for chat ${req.chatId}`);
                // Clean up pending consent/questionnaire requests to prevent stale UI banners
                clearPendingConsentsForChat(req.chatId);
                clearPendingQuestionnairesForChat(req.chatId);
                break;
              }

              let chunk = "";

              // Handle thinking block transitions
              if (
                inThinkingBlock &&
                ![
                  "reasoning-delta",
                  "reasoning-end",
                  "reasoning-start",
                ].includes(part.type)
              ) {
                chunk = "</think>\n";
                inThinkingBlock = false;
              }

              switch (part.type) {
                case "text-delta":
                  passProducedChatText = true;
                  chunk += part.text;
                  maybeCaptureRetryReplayText(
                    activeRetryReplayEvents,
                    part.text,
                  );
                  break;

                case "reasoning-start":
                  if (!inThinkingBlock) {
                    chunk = "<think>";
                    inThinkingBlock = true;
                  }
                  break;

                case "reasoning-delta":
                  if (!inThinkingBlock) {
                    chunk = "<think>";
                    inThinkingBlock = true;
                  }
                  chunk += part.text;
                  break;

                case "reasoning-end":
                  if (inThinkingBlock) {
                    chunk = "</think>\n";
                    inThinkingBlock = false;
                  }
                  break;

                case "tool-input-start": {
                  // Initialize streaming state for this tool call
                  getOrCreateStreamingEntry(part.id, part.toolName);
                  attemptToolInputIds.add(part.id);
                  break;
                }

                case "tool-input-delta": {
                  // Accumulate args and stream XML preview
                  const entry = getOrCreateStreamingEntry(part.id);
                  if (entry) {
                    entry.argsAccumulated += part.delta;
                    const toolDef = findToolDefinition(entry.toolName);
                    if (toolDef?.buildXml) {
                      const argsPartial = parsePartialJson(
                        entry.argsAccumulated,
                      );
                      const xml = toolDef.buildXml(argsPartial, false);
                      if (xml) {
                        ctx.onXmlStream(xml);
                      }
                    }
                  }
                  break;
                }

                case "tool-input-end": {
                  // Build final XML and persist
                  const entry = getOrCreateStreamingEntry(part.id);
                  if (entry) {
                    const toolDef = findToolDefinition(entry.toolName);
                    if (toolDef?.buildXml) {
                      const argsPartial = parsePartialJson(
                        entry.argsAccumulated,
                      );
                      const xml = toolDef.buildXml(argsPartial, true);
                      if (xml) {
                        ctx.onXmlComplete(xml);
                      }
                    }
                  }
                  cleanupStreamingEntry(part.id);
                  attemptToolInputIds.delete(part.id);
                  break;
                }

                case "tool-call":
                  maybeCaptureRetryReplayEvent(retryReplayEvents, part);
                  // Tool execution happens via execute callbacks
                  break;

                case "tool-result":
                  maybeCaptureRetryReplayEvent(retryReplayEvents, part);
                  // Tool results are already handled by the execute callback
                  break;
              }

              if (chunk) {
                fullResponse += chunk;
                await updateResponseInDb(placeholderMessageId, fullResponse);
                sendResponseChunk(
                  event,
                  req.chatId,
                  chat,
                  fullResponse,
                  placeholderMessageId,
                  hiddenMessageIdsForStreaming,
                );
              }
            }
          } catch (error) {
            if (!abortController.signal.aborted) {
              streamErrorFromIteration = error;
            } else {
              logger.log(
                `Stream interrupted after abort for chat ${req.chatId}`,
              );
            }
          }

          // Close thinking block if still open
          if (inThinkingBlock) {
            const closingThinkBlock = "</think>\n";
            fullResponse += closingThinkBlock;
            await updateResponseInDb(placeholderMessageId, fullResponse);
          }
          activeRetryReplayEvents = null;

          if (abortController.signal.aborted) {
            break;
          }

          const streamError =
            streamErrorFromIteration ?? streamErrorFromCallback;
          if (streamError) {
            if (
              shouldRetryTransientStreamError({
                error: streamError,
                retryCount: terminatedRetryCount,
                aborted: abortController.signal.aborted,
              })
            ) {
              maybeAppendRetryReplayForRetry({
                retryReplayEvents,
                currentMessageHistoryRef: currentMessageHistory,
                accumulatedAiMessagesRef: accumulatedAiMessages,
                onCurrentMessageHistoryUpdate: (next) =>
                  (currentMessageHistory = next),
              });
              terminatedRetryCount += 1;
              needsContinuationInstruction = true;
              const retryDelayMs =
                STREAM_RETRY_BASE_DELAY_MS * terminatedRetryCount;
              sendTelemetryEvent("local_agent:terminated_stream_retry", {
                chatId: req.chatId,
                orianbuilderRequestId,
                retryCount: terminatedRetryCount,
                error: String(streamError),
                phase: "stream_iteration",
              });
              await logMissionRetryScheduled({
                missionId,
                missionRunId,
                chatId: req.chatId,
                retryCount: terminatedRetryCount,
                retryDelayMs,
                phase: "stream_iteration",
                error: streamError,
              });
              logger.warn(
                `Transient stream termination for chat ${req.chatId}; retrying pass (${terminatedRetryCount}/${MAX_TERMINATED_STREAM_RETRIES}) after ${retryDelayMs}ms`,
              );
              await delay(retryDelayMs);
              continue;
            }
            sendTelemetryEvent(
              "local_agent:terminated_stream_retries_exhausted",
              {
                chatId: req.chatId,
                orianbuilderRequestId,
                retryCount: terminatedRetryCount,
                error: String(streamError),
                phase: "stream_iteration",
              },
            );
            throw streamError;
          }

          try {
            const response = await streamResult.response;
            steps = (await streamResult.steps) ?? [];
            responseMessages = response.messages;
          } catch (err) {
            if (
              shouldRetryTransientStreamError({
                error: err,
                retryCount: terminatedRetryCount,
                aborted: abortController.signal.aborted,
              })
            ) {
              maybeAppendRetryReplayForRetry({
                retryReplayEvents,
                currentMessageHistoryRef: currentMessageHistory,
                accumulatedAiMessagesRef: accumulatedAiMessages,
                onCurrentMessageHistoryUpdate: (next) =>
                  (currentMessageHistory = next),
              });
              terminatedRetryCount += 1;
              needsContinuationInstruction = true;
              const retryDelayMs =
                STREAM_RETRY_BASE_DELAY_MS * terminatedRetryCount;
              sendTelemetryEvent("local_agent:terminated_stream_retry", {
                chatId: req.chatId,
                orianbuilderRequestId,
                retryCount: terminatedRetryCount,
                error: String(err),
                phase: "response_finalization",
              });
              await logMissionRetryScheduled({
                missionId,
                missionRunId,
                chatId: req.chatId,
                retryCount: terminatedRetryCount,
                retryDelayMs,
                phase: "response_finalization",
                error: err,
              });
              logger.warn(
                `Transient stream termination while finalizing response for chat ${req.chatId}; retrying pass (${terminatedRetryCount}/${MAX_TERMINATED_STREAM_RETRIES}) after ${retryDelayMs}ms`,
              );
              await delay(retryDelayMs);
              continue;
            }
            if (isTerminatedStreamError(err)) {
              sendTelemetryEvent(
                "local_agent:terminated_stream_retries_exhausted",
                {
                  chatId: req.chatId,
                  orianbuilderRequestId,
                  retryCount: terminatedRetryCount,
                  error: String(err),
                  phase: "response_finalization",
                },
              );
            }
            logger.warn("Failed to retrieve stream response messages:", err);
            steps = [];
            responseMessages = [];
          }

          break;
        } finally {
          cleanupAttemptToolStreamingEntries();
        }
      }

      if (abortController.signal.aborted) {
        break;
      }

      // Track total steps for step limit detection
      totalStepsExecuted += steps.length;

      if (responseMessages.length > 0) {
        // For mid-turn compaction, slice off pre-compaction messages
        const messagesToAccumulate =
          compactedMidTurn && postMidTurnCompactionStartStep !== null
            ? (() => {
                // stepNumber is 0-indexed (from AI SDK: stepNumber = steps.length).
                // We want the step just before compaction to determine how many
                // response messages to skip (they belong to pre-compaction context).
                const prevStepMessages =
                  steps[postMidTurnCompactionStartStep - 1]?.response?.messages;
                if (!prevStepMessages) {
                  logger.warn(
                    `No step data found at index ${postMidTurnCompactionStartStep - 1} for mid-turn compaction slicing; persisting all messages`,
                  );
                }
                return responseMessages.slice(prevStepMessages?.length ?? 0);
              })()
            : responseMessages;
        accumulatedAiMessages.push(...messagesToAccumulate);
        currentMessageHistory = [
          ...currentMessageHistory,
          ...messagesToAccumulate,
        ];
      }

      // Check if the model ended with text only (no tool calls in the final step).
      // set_chat_summary is metadata, so a summary-only final step should not
      // suppress the todo safety follow-up when the pass already produced text.
      // This is more reliable than passProducedChatText which is set on any text-delta
      // during the stream (including preambles before tool calls).
      const lastStep = steps.length > 0 ? steps[steps.length - 1] : null;
      const passEndedWithText =
        passProducedChatText &&
        (!lastStep ||
          lastStep.toolCalls.length === 0 ||
          stepOnlyCalledTool(lastStep, setChatSummaryTool.name));

      if (
        passEndedWithText &&
        plainTextToolFollowUpLoops < maxPlainTextToolFollowUpLoops
      ) {
        const plainTextToolCall = extractPlainTextToolCall({
          text: fullResponse,
          availableToolNames: new Set(Object.keys(allTools)),
          alreadyExecuted: executedPlainTextToolSignatures,
        });

        if (plainTextToolCall) {
          executedPlainTextToolSignatures.add(plainTextToolCall.signature);
          plainTextToolFollowUpLoops += 1;

          await logMissionEvent({
            missionId,
            eventType: "agent_plain_text_tool_recovered",
            summary: `Recovered plain-text tool call: ${plainTextToolCall.toolName}`,
            metadata: {
              chatId: req.chatId,
              runId: missionRunId,
              toolName: plainTextToolCall.toolName,
              args: plainTextToolCall.args,
              loop: plainTextToolFollowUpLoops,
            },
          }).catch((err) =>
            logger.warn("Failed to log plain-text tool recovery:", err),
          );

          const tool = (allTools as Record<string, any>)[
            plainTextToolCall.toolName
          ];
          let toolResultText = "";
          try {
            const result = await tool.execute(plainTextToolCall.args);
            toolResultText = stringifyManualToolResult(result);
          } catch (error) {
            toolResultText =
              error instanceof Error ? error.message : String(error);
          }

          currentMessageHistory = [
            ...currentMessageHistory,
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: `[System] You emitted <${plainTextToolCall.toolName}> as plain XML text instead of making a real tool call. The backend executed that tool for you.\n\nTool result:\n${toolResultText.slice(0, 8000)}\n\nContinue the user's request from this result. Use real tool calls for future actions; do not print tool XML as prose.`,
                },
              ],
            },
          ];
          continue;
        }
      }

      if (
        nativeTargetIntent &&
        passEndedWithText &&
        !hasCompletedNativePackage(fullResponse) &&
        nativeTargetFollowUpLoops < maxNativeTargetFollowUpLoops
      ) {
        nativeTargetFollowUpLoops += 1;
        currentMessageHistory = [
          ...currentMessageHistory,
          buildNativeTargetFollowUpMessage(nativeTargetIntent),
        ];
        logger.info(
          `Starting native target follow-up pass ${nativeTargetFollowUpLoops}/${maxNativeTargetFollowUpLoops} for chat ${req.chatId}`,
        );
        continue;
      }

      if (
        !shouldRunTodoFollowUpPass({
          readOnly,
          planModeOnly,
          passEndedWithText,
          todos: ctx.todos,
          todoFollowUpLoops,
          maxTodoFollowUpLoops,
        })
      ) {
        break;
      }

      todoFollowUpLoops += 1;
      const reminderText = buildTodoReminderMessage(ctx.todos);
      const reminderMessage: ModelMessage = {
        role: "user",
        content: [{ type: "text", text: reminderText }],
      };
      currentMessageHistory = [...currentMessageHistory, reminderMessage];
      // Note: Do NOT push reminderMessage to accumulatedAiMessages.
      // It is a synthetic message that should not be persisted to aiMessagesJson,
      // as it would pollute future conversation history with stale todo state.
      logger.info(
        `Starting todo follow-up pass ${todoFollowUpLoops}/${maxTodoFollowUpLoops} for chat ${req.chatId}`,
      );
    }

    // Handle cancellation paths where stream processing exits cleanly after abort.
    if (abortController.signal.aborted) {
      const toolBudgetAbortReason = missionBudgetAbort.tool;
      const runtimeBudgetAbortReason = missionBudgetAbort.runtime;
      if (toolBudgetAbortReason) {
        const budgetXml = `<orianbuilder-step-limit steps="${totalStepsExecuted}" limit="${maxToolCallSteps}">Automatically paused because ${escapeXmlContent(toolBudgetAbortReason.reason)}</orianbuilder-step-limit>`;
        fullResponse += `\n\n${budgetXml}`;
        const metadata = {
          chatId: req.chatId,
          runId: missionRunId,
          workerId: workerId ?? null,
          budgetType: toolBudgetAbortReason.budgetType,
          toolName: toolBudgetAbortReason.toolName,
          count: toolBudgetAbortReason.count,
          limit: toolBudgetAbortReason.limit,
          reason: toolBudgetAbortReason.reason,
          totalStepsExecuted,
        };
        await logMissionEvent({
          missionId,
          eventType: "mission_budget_limit_reached",
          summary: `Tool failure budget reached: ${toolBudgetAbortReason.reason}`,
          metadata,
        }).catch((err) =>
          logger.warn("Failed to log mission tool-failure budget:", err),
        );
        await createMissionCheckpoint({
          missionId,
          runId: missionRunId,
          summary: `Tool failure budget reached: ${toolBudgetAbortReason.reason}`,
          metadata,
        }).catch((err) =>
          logger.warn("Failed to checkpoint mission tool-failure budget:", err),
        );
      } else if (runtimeBudgetAbortReason) {
        const budgetXml = `<orianbuilder-step-limit steps="${totalStepsExecuted}" limit="${maxToolCallSteps}">Automatically paused after exceeding the mission runtime budget.</orianbuilder-step-limit>`;
        fullResponse += `\n\n${budgetXml}`;
        const metadata = {
          chatId: req.chatId,
          runId: missionRunId,
          workerId: workerId ?? null,
          budgetType: "runtime",
          elapsedMs: runtimeBudgetAbortReason.elapsedMs,
          limitMs: runtimeBudgetAbortReason.limit,
          totalStepsExecuted,
        };
        await logMissionEvent({
          missionId,
          eventType: "mission_budget_limit_reached",
          summary: `Runtime budget reached after ${runtimeBudgetAbortReason.elapsedMs}ms`,
          metadata,
        }).catch((err) =>
          logger.warn("Failed to log mission runtime budget:", err),
        );
        await createMissionCheckpoint({
          missionId,
          runId: missionRunId,
          summary: "Runtime budget reached",
          metadata,
        }).catch((err) =>
          logger.warn("Failed to checkpoint mission runtime budget:", err),
        );
      }
      await db
        .update(messages)
        .set({
          content: appendCancelledResponseNotice(fullResponse ?? ""),
        })
        .where(eq(messages.id, placeholderMessageId));
      await logMissionEvent({
        missionId,
        eventType: "agent_stream_cancelled",
        summary: "Agent stream was cancelled",
        metadata: { chatId: req.chatId },
      }).catch((err) =>
        logger.warn("Failed to log mission cancellation event:", err),
      );
      await finishMissionRun({
        runId: missionRunId,
        status: "cancelled",
        totalStepsExecuted,
      }).catch((err) => logger.warn("Failed to finish mission run:", err));
      await createMissionCheckpoint({
        missionId,
        runId: missionRunId,
        summary: "Mission run cancelled",
        metadata: {
          chatId: req.chatId,
          totalStepsExecuted,
          responseLength: fullResponse.length,
        },
      }).catch((err) =>
        logger.warn("Failed to create mission checkpoint:", err),
      );
      releaseMcpSession(mcpSessionId);
      return false; // Cancelled - don't consume quota
    }

    if (
      fullResponse.trim().length === 0 &&
      accumulatedAiMessages.length === 0 &&
      totalStepsExecuted === 0
    ) {
      throw new OrianBuilderError(
        "The model stream ended without producing any text or tool calls. This is usually a local model/provider issue; try again or switch to a larger tool-capable model.",
        OrianBuilderErrorKind.External,
      );
    }

    const executeNativeAutofinishTool = async (
      tool:
        | typeof browserQaGateTool
        | typeof packageNativeArtifactTool
        | typeof deployPreviewTool,
      args: Record<string, unknown>,
      inputPreview: string,
    ) => {
      const allowed = await ctx.requireConsent({
        toolName: tool.name,
        toolDescription: tool.description,
        inputPreview,
      });
      if (!allowed) {
        return false;
      }

      const modifiesState = tool.modifiesState === true;
      ctx.onToolExecutionStart?.({
        toolName: tool.name,
        inputPreview,
        modifiesState,
      });
      try {
        const output = await tool.execute(args as never, ctx);
        ctx.onToolExecutionComplete?.({
          toolName: tool.name,
          status: "completed",
          durationMs: 0,
          outputPreview: String(output).slice(0, 4000),
          error: null,
          modifiesState,
        });
        return true;
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        ctx.onToolExecutionComplete?.({
          toolName: tool.name,
          status: "failed",
          durationMs: 0,
          outputPreview: null,
          error: errorMessage,
          modifiesState,
        });
        warningMessages.push(`${tool.name} failed: ${errorMessage}`);
        return false;
      }
    };

    if (
      nativeTargetIntent &&
      !producedNativePackageArtifact &&
      !attemptedNativePackageArtifact
    ) {
      await logMissionEvent({
        missionId,
        eventType: "native_autofinish_triggered",
        summary: `Auto-finishing native package: ${nativeTargetIntent.label}`,
        metadata: {
          chatId: req.chatId,
          runId: missionRunId,
          target: nativeTargetIntent.target,
          reason: "agent_stream_ended_without_native_package",
        },
      }).catch((err) =>
        logger.warn("Failed to log native autofinish package event:", err),
      );
      await executeNativeAutofinishTool(
        packageNativeArtifactTool,
        {
          target: nativeTargetIntent.target,
          variant: "debug",
          create_download_site: true,
          initialize_capacitor_if_missing: true,
        },
        `Package native artifact: ${nativeTargetIntent.target} and create download site`,
      );
    }

    if (nativeTargetIntent && !passedBrowserQaGate) {
      await logMissionEvent({
        missionId,
        eventType: "native_autofinish_triggered",
        summary: "Auto-finishing browser QA gate",
        metadata: {
          chatId: req.chatId,
          runId: missionRunId,
          target: nativeTargetIntent.target,
          reason: "native_target_without_browser_qa_pass",
        },
      }).catch((err) =>
        logger.warn("Failed to log native autofinish browser QA event:", err),
      );
      await executeNativeAutofinishTool(
        browserQaGateTool,
        {
          start_runtime: true,
          full_page: false,
          runtime_timeout_seconds: 60,
        },
        "Run browser QA gate after native package build",
      );
    }

    if (
      nativeTargetIntent &&
      producedNativePackageArtifact &&
      !producedDeploymentUrl
    ) {
      await logMissionEvent({
        missionId,
        eventType: "native_autofinish_triggered",
        summary: "Auto-finishing native download page deployment",
        metadata: {
          chatId: req.chatId,
          runId: missionRunId,
          target: nativeTargetIntent.target,
          reason: "native_package_created_without_download_page_url",
        },
      }).catch((err) =>
        logger.warn("Failed to log native autofinish deploy event:", err),
      );
      await executeNativeAutofinishTool(
        deployPreviewTool,
        {
          provider: "custom_command",
          target: "production",
          deploy_directory: "native-download-site",
        },
        "Deploy native-download-site as a managed local static download page",
      );
    }

    // Collect XML produced by post-turn side-effects (step-limit notice,
    // Supabase deploy results) so we can persist them into aiMessagesJson.
    // parseAiMessagesJson reads from aiMessagesJson when present and ignores
    // the message's `content` column, so anything appended only to fullResponse
    // would be invisible to subsequent agent turns.
    const postTurnXmlParts: string[] = [];

    // Check if we hit the step limit and append a notice to the response
    if (totalStepsExecuted >= maxToolCallSteps) {
      logger.info(
        `Chat ${req.chatId} hit step limit of ${maxToolCallSteps} steps`,
      );
      const stepLimitXml = `<orianbuilder-step-limit steps="${totalStepsExecuted}" limit="${maxToolCallSteps}">Automatically paused after ${totalStepsExecuted} tool calls.</orianbuilder-step-limit>`;
      postTurnXmlParts.push(stepLimitXml);
      fullResponse += `\n\n${stepLimitXml}`;
      const stepLimitMetadata = {
        chatId: req.chatId,
        runId: missionRunId,
        totalStepsExecuted,
        maxToolCallSteps,
        budgetType: "tool_steps",
      };
      await logMissionEvent({
        missionId,
        eventType: "mission_budget_limit_reached",
        summary: `Step budget reached: ${totalStepsExecuted}/${maxToolCallSteps}`,
        metadata: stepLimitMetadata,
      }).catch((err) =>
        logger.warn("Failed to log mission step budget event:", err),
      );
      await createMissionCheckpoint({
        missionId,
        runId: missionRunId,
        summary: `Step budget reached: ${totalStepsExecuted}/${maxToolCallSteps}`,
        metadata: stepLimitMetadata,
      }).catch((err) =>
        logger.warn("Failed to checkpoint mission step budget:", err),
      );
      await updateResponseInDb(placeholderMessageId, fullResponse);
      sendResponseChunk(
        event,
        req.chatId,
        chat,
        fullResponse,
        placeholderMessageId,
        hiddenMessageIdsForStreaming,
      );
    }

    // In read-only and plan mode, skip the deploy step (commit follows below)
    if (!readOnly && !planModeOnly) {
      // Deploy all Supabase functions if shared modules changed
      const deployResult = await deployAllFunctionsIfNeeded({
        ...ctx,
        onXmlComplete: (finalXml) => {
          postTurnXmlParts.push(finalXml);
          ctx.onXmlComplete(finalXml);
        },
      });
      if (deployResult.warning) {
        const warningXml = `<orianbuilder-output type="warning" message="${escapeXmlAttr("Supabase function deploy warning")}">${escapeXmlContent(deployResult.warning)}</orianbuilder-output>`;
        postTurnXmlParts.push(warningXml);
        ctx.onXmlComplete(warningXml);
      }
      if (!deployResult.success) {
        const errorXml = `<orianbuilder-output type="error" message="${escapeXmlAttr("Failed to deploy Supabase functions")}">${escapeXmlContent(deployResult.error ?? "Unknown deploy error")}</orianbuilder-output>`;
        postTurnXmlParts.push(errorXml);
        ctx.onXmlComplete(errorXml);
      }
    }

    // Persist post-turn side-effects as a trailing assistant message so future
    // agent turns can see them via aiMessagesJson. Done before the
    // aiMessagesJson write below so deploy/step-limit info is captured even if
    // a later step (e.g. commit) throws.
    if (postTurnXmlParts.length > 0) {
      accumulatedAiMessages.push({
        role: "assistant",
        content: [{ type: "text", text: postTurnXmlParts.join("\n") }],
      });
    }

    // Save the AI SDK messages for multi-turn tool call preservation
    try {
      const aiMessagesJson = getAiMessagesJsonIfWithinLimit(
        accumulatedAiMessages,
      );
      if (aiMessagesJson) {
        await db
          .update(messages)
          .set({ aiMessagesJson })
          .where(eq(messages.id, placeholderMessageId));
      }
    } catch (err) {
      logger.warn("Failed to save AI messages JSON:", err);
    }

    // In read-only and plan mode, skip commits
    if (!readOnly && !planModeOnly) {
      // Commit all changes
      const commitResult = await commitAllChanges(ctx, ctx.chatSummary);

      if (commitResult.commitHash) {
        await db
          .update(messages)
          .set({ commitHash: commitResult.commitHash })
          .where(eq(messages.id, placeholderMessageId));
      }

      // Store Neon DB timestamp for version tracking / time-travel
      if (ctx.neonProjectId && ctx.neonActiveBranchId) {
        try {
          await storeDbTimestampAtCurrentVersion({ appId: ctx.appId });
        } catch (error) {
          logger.error(
            "Error storing Neon timestamp at current version:",
            error,
          );
        }
      }
    }

    // Mark as approved (auto-approve for local-agent)
    await db
      .update(messages)
      .set({ approvalState: "approved" })
      .where(eq(messages.id, placeholderMessageId));

    // Send telemetry for files with multiple edit tool types
    for (const [filePath, counts] of Object.entries(fileEditTracker)) {
      const toolsUsed = Object.entries(counts).filter(([, count]) => count > 0);
      if (toolsUsed.length >= 2) {
        sendTelemetryEvent("local_agent:file_edit_retry", {
          filePath,
          ...counts,
        });
      }
    }

    // Send completion
    safeSend(event.sender, "chat:response:end", {
      chatId: req.chatId,
      updatedFiles: !readOnly,
      chatSummary: ctx.chatSummary,
      warningMessages:
        warningMessages.length > 0 ? [...new Set(warningMessages)] : undefined,
    } satisfies ChatResponseEnd);

    // Detect "dead" runs: the stream completed cleanly but the model never
    // produced a real tool call (and the fallback parser also didn't recover
    // one). Without this guard, the mission would stay in `running` forever
    // and the user would see no obvious failure signal.
    const isDeadRun =
      !readOnly &&
      totalNativeToolCalls === 0 &&
      totalFallbackToolCalls === 0 &&
      textToolCallFallbackAttempts === 0;

    await logMissionEvent({
      missionId,
      eventType: "agent_stream_completed",
      summary: isDeadRun
        ? "Agent stream completed with zero tool calls (model_did_not_tool_call)"
        : "Agent stream completed",
      metadata: {
        chatId: req.chatId,
        updatedFiles: !readOnly,
        totalStepsExecuted,
        totalNativeToolCalls,
        totalFallbackToolCalls,
        textToolCallFallbackAttempts,
        deadRun: isDeadRun,
      },
    }).catch((err) =>
      logger.warn("Failed to log mission completion event:", err),
    );
    await finishMissionRun({
      runId: missionRunId,
      status: isDeadRun ? "failed" : "completed",
      totalStepsExecuted,
      error: isDeadRun
        ? "model_did_not_tool_call: stream completed without any structured tool calls. The selected model likely does not support function calling through this provider."
        : null,
      metadata: {
        updatedFiles: !readOnly,
        chatSummary: ctx.chatSummary,
        totalNativeToolCalls,
        totalFallbackToolCalls,
        textToolCallFallbackAttempts,
      },
    }).catch((err) => logger.warn("Failed to finish mission run:", err));

    const nativeMissionReadyToComplete =
      !nativeTargetIntent ||
      (producedBrowserQaScreenshotArtifact &&
        passedBrowserQaGate &&
        producedNativePackageArtifact &&
        producedDeploymentUrl);
    if (
      missionId &&
      !workerId &&
      !isDeadRun &&
      totalStepsExecuted < maxToolCallSteps &&
      nativeMissionReadyToComplete
    ) {
      const existingWorker = await db.query.missionWorkers.findFirst({
        where: eq(missionWorkers.missionId, missionId),
        columns: { id: true },
      });
      if (!existingWorker) {
        await db
          .update(missions)
          .set({
            status: "completed",
            updatedAt: new Date(),
            completedAt: new Date(),
          })
          .where(
            and(
              eq(missions.id, missionId),
              inArray(missions.status, ["queued", "running"]),
            ),
          )
          .catch((err) =>
            logger.warn("Failed to mark standalone mission completed:", err),
          );
        await logMissionEvent({
          missionId,
          eventType: "mission_status_changed",
          summary: "Mission marked completed",
          metadata: {
            status: "completed",
            source: "local_agent_stream",
            chatId: req.chatId,
            nativeTarget: nativeTargetIntent?.target ?? null,
            browserQaPassed: nativeTargetIntent ? passedBrowserQaGate : null,
          },
        }).catch((err) =>
          logger.warn("Failed to log mission completion status:", err),
        );
      }
    }

    if (isDeadRun) {
      warningMessages.push(
        "Model did not produce any structured tool calls. The agent loop ended without making changes. Try a model with native function-calling support (Claude, GPT-4o/5, Gemini 2.x, or a GGUF with a tool-call template like Hermes/Functionary).",
      );
      if (missionId) {
        await db
          .update(missions)
          .set({
            status: "failed",
            updatedAt: new Date(),
            completedAt: new Date(),
          })
          .where(eq(missions.id, missionId))
          .catch((err) =>
            logger.warn("Failed to mark mission failed after dead run:", err),
          );
      }
    }
    await createMissionCheckpoint({
      missionId,
      runId: missionRunId,
      summary: ctx.chatSummary ?? "Agent stream completed",
      metadata: {
        chatId: req.chatId,
        totalStepsExecuted,
        todos: ctx.todos,
        fileEditTracker,
        warningMessages:
          warningMessages.length > 0 ? [...new Set(warningMessages)] : [],
      },
    }).catch((err) => logger.warn("Failed to create mission checkpoint:", err));

    releaseMcpSession(mcpSessionId);
    return true; // Success
  } catch (error) {
    // Clean up any pending consent/questionnaire requests for this chat to prevent
    // stale UI banners and orphaned promises
    clearPendingConsentsForChat(req.chatId);
    clearPendingQuestionnairesForChat(req.chatId);

    if (abortController.signal.aborted) {
      // Handle cancellation
      await db
        .update(messages)
        .set({
          content: appendCancelledResponseNotice(fullResponse ?? ""),
        })
        .where(eq(messages.id, placeholderMessageId));
      await logMissionEvent({
        missionId,
        eventType: "agent_stream_cancelled",
        summary: "Agent stream was cancelled",
        metadata: { chatId: req.chatId },
      }).catch((err) =>
        logger.warn("Failed to log mission cancellation event:", err),
      );
      await finishMissionRun({
        runId: missionRunId,
        status: "cancelled",
        totalStepsExecuted,
      }).catch((err) => logger.warn("Failed to finish mission run:", err));
      await createMissionCheckpoint({
        missionId,
        runId: missionRunId,
        summary: "Mission run cancelled",
        metadata: {
          chatId: req.chatId,
          totalStepsExecuted,
          responseLength: fullResponse.length,
        },
      }).catch((err) =>
        logger.warn("Failed to create mission checkpoint:", err),
      );
      releaseMcpSession(mcpSessionId);
      return false; // Cancelled - don't consume quota
    }

    logger.error("Local agent error:", error);
    safeSend(event.sender, "chat:response:error", {
      chatId: req.chatId,
      error: `Error: ${getErrorMessage(error)}`,
      warningMessages:
        warningMessages.length > 0 ? [...new Set(warningMessages)] : undefined,
    });
    await logMissionEvent({
      missionId,
      eventType: "agent_stream_failed",
      summary: "Agent stream failed",
      body: getErrorMessage(error),
      metadata: { chatId: req.chatId },
    }).catch((err) => logger.warn("Failed to log mission failure event:", err));
    await finishMissionRun({
      runId: missionRunId,
      status: "failed",
      totalStepsExecuted,
      error: getErrorMessage(error),
    }).catch((err) => logger.warn("Failed to finish mission run:", err));
    await createMissionCheckpoint({
      missionId,
      runId: missionRunId,
      summary: "Mission run failed",
      metadata: {
        chatId: req.chatId,
        totalStepsExecuted,
        error: getErrorMessage(error),
        responseLength: fullResponse.length,
      },
    }).catch((err) => logger.warn("Failed to create mission checkpoint:", err));
    releaseMcpSession(mcpSessionId);
    return false; // Error - don't consume quota
  }
}

async function logMissionEventsForXml(input: {
  missionId: number | undefined;
  missionRunId?: number | null;
  workerId?: number | null;
  chatId: number;
  xml: string;
}) {
  const { missionId, missionRunId, workerId, chatId, xml } = input;
  if (!missionId) {
    return;
  }

  await logMissionEvent({
    missionId,
    eventType: "agent_output",
    summary: getMissionEventSummaryForXml(xml),
    body: xml,
    metadata: {
      chatId,
      runId: missionRunId ?? null,
      workerId: workerId ?? null,
    },
  });

  for (const event of getMissionStructuredEventsForXml(xml)) {
    await logMissionEvent({
      missionId,
      eventType: event.eventType,
      summary: event.summary,
      body: xml,
      metadata: {
        chatId,
        workerId: workerId ?? null,
        ...event.metadata,
      },
    });
  }

  const visual = extractMissionVisualEventsForXml(xml);
  for (const event of visual.events) {
    await logMissionEvent({
      missionId,
      eventType: event.eventType,
      summary: event.summary,
      body: xml,
      metadata: {
        chatId,
        workerId: workerId ?? null,
        gate: event.gate,
        status: event.status,
        ...event.metadata,
      },
    });
    if (event.status === "failed") {
      await createMissionInterrupt({
        missionId,
        source: "runtime",
        title: `${getMissionVisualGateLabel(event.gate)} failed`,
        body: event.summary,
        metadata: {
          producer: event.eventType,
          runId: missionRunId ?? null,
          workerId: workerId ?? null,
          chatId,
          gate: event.gate,
          status: event.status,
          ...event.metadata,
        },
      });
    }
  }
  for (const artifact of visual.artifacts) {
    await createMissionArtifact({
      missionId,
      runId: missionRunId ?? null,
      artifactType: artifact.artifactType,
      title: artifact.title,
      uri: artifact.uri ?? null,
      body: artifact.body ?? null,
      mimeType: artifact.mimeType ?? null,
      metadata: {
        chatId,
        workerId: workerId ?? null,
        ...artifact.metadata,
      },
    });
  }

  const verification = getMissionVerificationEventForXml(xml);
  if (!verification) {
    return;
  }

  await logMissionEvent({
    missionId,
    eventType: verification.eventType,
    summary: verification.summary,
    body: xml,
    metadata: {
      chatId,
      workerId: workerId ?? null,
      status: verification.status,
      check: verification.check,
      command: verification.command,
      problemCount: verification.problemCount,
      exitCode: verification.exitCode,
    },
  });
  if (verification.status === "failed") {
    await createMissionInterrupt({
      missionId,
      source: verification.check === "test" ? "test" : "runtime",
      title: `${getMissionVerificationCheckLabel(verification.check)} failed`,
      body: verification.summary,
      metadata: {
        producer: verification.eventType,
        runId: missionRunId ?? null,
        workerId: workerId ?? null,
        chatId,
        status: verification.status,
        check: verification.check,
        command: verification.command,
        problemCount: verification.problemCount,
        exitCode: verification.exitCode,
      },
    });
  }
}

function getMissionVisualGateLabel(gate: string) {
  switch (gate) {
    case "screenshot":
      return "Screenshot gate";
    case "accessibility":
      return "Accessibility gate";
    case "console":
      return "Console gate";
    case "runtime":
      return "Runtime gate";
    default:
      return "Visual gate";
  }
}

function getMissionVerificationCheckLabel(check: string) {
  switch (check) {
    case "install":
      return "Install";
    case "typecheck":
      return "Type check";
    case "build":
      return "Build";
    case "test":
      return "Tests";
    case "start_app":
      return "App start";
    default:
      return "Verification";
  }
}

async function logMissionRetryScheduled(input: {
  missionId: number | undefined;
  missionRunId: number | null;
  chatId: number;
  retryCount: number;
  retryDelayMs: number;
  phase: string;
  error: unknown;
}) {
  const metadata = {
    chatId: input.chatId,
    runId: input.missionRunId,
    retryCount: input.retryCount,
    retryDelayMs: input.retryDelayMs,
    phase: input.phase,
    error: getErrorMessage(input.error),
    retryPolicy: {
      maxRetries: MAX_TERMINATED_STREAM_RETRIES,
      baseDelayMs: STREAM_RETRY_BASE_DELAY_MS,
    },
  };

  await logMissionEvent({
    missionId: input.missionId,
    eventType: "agent_stream_retry_scheduled",
    summary: `Retry ${input.retryCount} scheduled after ${input.retryDelayMs}ms`,
    metadata,
  }).catch((err) => logger.warn("Failed to log mission retry:", err));

  await createMissionCheckpoint({
    missionId: input.missionId,
    runId: input.missionRunId,
    summary: `Retry ${input.retryCount} scheduled`,
    metadata,
  }).catch((err) => logger.warn("Failed to checkpoint mission retry:", err));
}

function getStepToolNames(step: { toolCalls: Array<unknown> }) {
  return step.toolCalls
    .map((toolCall) => {
      if (!toolCall || typeof toolCall !== "object") {
        return null;
      }
      const maybeToolCall = toolCall as Record<string, unknown>;
      return typeof maybeToolCall.toolName === "string"
        ? maybeToolCall.toolName
        : null;
    })
    .filter((toolName): toolName is string => !!toolName);
}

function hasRepeatedToolSignature(toolName: string, repeatedCount: number) {
  return ({ steps }: { steps: Array<{ toolCalls: Array<unknown> }> }) => {
    const signatures = steps
      .map((step) => getStepSignature(step.toolCalls))
      .filter((signature): signature is string => !!signature);
    const latestSignature = signatures.at(-1);
    if (!latestSignature?.startsWith(`${toolName}:`)) {
      return false;
    }
    if (signatures.length < repeatedCount) {
      return false;
    }
    return signatures
      .slice(-repeatedCount)
      .every((signature) => signature === latestSignature);
  };
}

function getStepSignature(toolCalls: Array<unknown>) {
  if (toolCalls.length === 0) {
    return null;
  }
  return toolCalls
    .map((toolCall) => {
      if (!toolCall || typeof toolCall !== "object") {
        return "unknown:null";
      }
      const maybeToolCall = toolCall as Record<string, unknown>;
      const toolName =
        typeof maybeToolCall.toolName === "string"
          ? maybeToolCall.toolName
          : "unknown";
      const input =
        maybeToolCall.input ??
        maybeToolCall.args ??
        maybeToolCall.arguments ??
        null;
      const inputSignature = createHash("sha1")
        .update(stableSignatureJson(input))
        .digest("hex")
        .slice(0, 10);
      return `${toolName}:${inputSignature}`;
    })
    .join(",");
}

function stableSignatureJson(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, nestedValue) => {
      if (
        nestedValue &&
        typeof nestedValue === "object" &&
        !Array.isArray(nestedValue)
      ) {
        return Object.fromEntries(
          Object.entries(nestedValue as Record<string, unknown>).sort(
            ([a], [b]) => a.localeCompare(b),
          ),
        );
      }
      return nestedValue;
    });
  } catch {
    return String(value);
  }
}

function buildTerminatedRetryContinuationInstruction(): ModelMessage {
  return {
    role: "user",
    content: [{ type: "text", text: STREAM_CONTINUE_MESSAGE }],
  };
}

function unwrapStreamError(error: unknown): unknown {
  if (isRecord(error) && "error" in error) {
    return error.error;
  }
  return error;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  if (typeof error === "string") {
    return error;
  }
  if (isRecord(error)) {
    if (typeof error.message === "string" && error.message.length > 0) {
      return error.message;
    }
    if ("error" in error) {
      return getErrorMessage(error.error);
    }
    if ("cause" in error) {
      return getErrorMessage(error.cause);
    }
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function isTerminatedStreamError(error: unknown): boolean {
  const normalized = unwrapStreamError(error);
  const message = getErrorMessage(normalized).toLowerCase();
  if (message.includes("typeerror: terminated") || message === "terminated") {
    return true;
  }
  const cause =
    isRecord(normalized) && "cause" in normalized
      ? normalized.cause
      : undefined;
  if (cause) {
    return isTerminatedStreamError(cause);
  }
  return false;
}

function isRetryableProviderStreamError(error: unknown): boolean {
  const normalized = unwrapStreamError(error);
  if (!isRecord(normalized)) {
    return false;
  }

  const statusCode =
    (typeof normalized.statusCode === "number" && normalized.statusCode) ||
    (typeof normalized.status === "number" && normalized.status) ||
    (isRecord(normalized.response) &&
    typeof normalized.response.status === "number"
      ? normalized.response.status
      : undefined);

  if (
    typeof statusCode === "number" &&
    (statusCode >= 500 || RETRYABLE_STREAM_ERROR_STATUS_CODES.has(statusCode))
  ) {
    return true;
  }

  const errorString =
    [
      typeof normalized.message === "string" ? normalized.message : undefined,
      typeof normalized.code === "string" ? normalized.code : undefined,
      typeof normalized.type === "string" ? normalized.type : undefined,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase() || getErrorMessage(normalized).toLowerCase();

  return RETRYABLE_STREAM_ERROR_PATTERNS.some((pattern) =>
    errorString.includes(pattern),
  );
}

function shouldRetryTransientStreamError(params: {
  error: unknown;
  retryCount: number;
  aborted: boolean;
}): boolean {
  const { error, retryCount, aborted } = params;
  return (
    !aborted &&
    retryCount < MAX_TERMINATED_STREAM_RETRIES &&
    (isTerminatedStreamError(error) || isRetryableProviderStreamError(error))
  );
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function updateResponseInDb(messageId: number, content: string) {
  await db
    .update(messages)
    .set({ content })
    .where(eq(messages.id, messageId))
    .catch((err) => logger.error("Failed to update message", err));
}

function sendResponseChunk(
  event: IpcMainInvokeEvent,
  chatId: number,
  chat: any,
  fullResponse: string,
  placeholderMessageId: number,
  hiddenMessageIds?: Set<number>,
  /** When true, sends the full messages array instead of an incremental update */
  sendFullMessages?: boolean,
) {
  if (sendFullMessages) {
    const currentMessages = [...chat.messages].filter(
      (message) => !hiddenMessageIds?.has(message.id),
    );
    const placeholderMsg = currentMessages.find(
      (m) => m.id === placeholderMessageId,
    );
    if (placeholderMsg) {
      placeholderMsg.content = fullResponse;
    }
    safeSend(event.sender, "chat:response:chunk", {
      chatId,
      messages: currentMessages,
    });
  } else {
    // Send incremental update with only the streaming message content
    // to reduce IPC overhead during high-frequency streaming
    safeSend(event.sender, "chat:response:chunk", {
      chatId,
      streamingMessageId: placeholderMessageId,
      streamingContent: fullResponse,
    });
  }
}

function getPlanningQuestionnaireErrorFromStep(step: {
  content?: unknown;
}): string | null {
  if (!Array.isArray(step.content)) {
    return null;
  }

  for (const part of step.content) {
    if (!isRecord(part) || part.toolName !== PLANNING_QUESTIONNAIRE_TOOL_NAME) {
      continue;
    }

    if (part.type === "tool-error") {
      return typeof part.error === "string" ? part.error : "Unknown tool error";
    }

    if (
      part.type === "tool-result" &&
      typeof part.output === "string" &&
      part.output.startsWith("Error:")
    ) {
      return part.output;
    }
  }

  return null;
}

function buildPlanningQuestionnaireReflectionMessage(
  errorDetail?: string,
  planModeOnly?: boolean,
): string {
  const base = "Your planning_questionnaire tool call had a format error.";
  const detail = errorDetail ? ` The error was: ${errorDetail}` : "";
  if (planModeOnly) {
    return `[System]${base}${detail} Review the tool's input schema, fix the issue, and re-call planning_questionnaire with correct arguments.`;
  }
  return `[System]${base}${detail} Skip the questionnaire step and proceed directly to the planning phase.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stepOnlyCalledTool(
  step: { toolCalls: Array<unknown> },
  toolName: string,
): boolean {
  return (
    step.toolCalls.length > 0 &&
    step.toolCalls.every(
      (toolCall) => isRecord(toolCall) && toolCall.toolName === toolName,
    )
  );
}

function shouldRunTodoFollowUpPass(params: {
  readOnly: boolean;
  planModeOnly: boolean;
  passEndedWithText: boolean;
  todos: AgentContext["todos"];
  todoFollowUpLoops: number;
  maxTodoFollowUpLoops: number;
}): boolean {
  const {
    readOnly,
    planModeOnly,
    passEndedWithText,
    todos,
    todoFollowUpLoops,
    maxTodoFollowUpLoops,
  } = params;
  return (
    !readOnly &&
    !planModeOnly &&
    passEndedWithText &&
    hasIncompleteTodos(todos) &&
    todoFollowUpLoops < maxTodoFollowUpLoops
  );
}

async function loadPendingMissionInterrupts(missionId: number) {
  return db
    .select()
    .from(missionInterrupts)
    .where(
      and(
        eq(missionInterrupts.missionId, missionId),
        eq(missionInterrupts.status, "pending"),
      ),
    )
    .orderBy(asc(missionInterrupts.createdAt))
    .limit(8);
}

function releaseMcpSession(sessionId: string) {
  try {
    mcpManager.releaseSession(sessionId);
  } catch (err) {
    logger.warn("Failed to release MCP session:", err);
  }
}

async function markMissionInterruptsInjected(input: {
  missionId: number;
  interruptIds: number[];
}) {
  if (input.interruptIds.length === 0) {
    return [];
  }

  return db
    .update(missionInterrupts)
    .set({
      status: "injected",
      injectedAt: new Date(),
    })
    .where(
      and(
        eq(missionInterrupts.missionId, input.missionId),
        inArray(missionInterrupts.id, input.interruptIds),
      ),
    )
    .returning();
}

async function loadMissionMemoriesForInjection(input: {
  appId: number;
  missionId: number;
}) {
  return db
    .select()
    .from(missionMemories)
    .where(
      and(
        eq(missionMemories.appId, input.appId),
        or(
          eq(missionMemories.missionId, input.missionId),
          isNull(missionMemories.missionId),
        ),
      ),
    )
    .orderBy(desc(missionMemories.updatedAt))
    .limit(8);
}

async function createMissionPermissionRequestForTool(input: {
  missionId: number;
  runId: number | null;
  toolName: string;
  inputPreview?: string | null;
  risk: "low" | "medium" | "high";
  reason: string;
}) {
  const [request] = await db
    .insert(missionPermissionRequests)
    .values({
      missionId: input.missionId,
      runId: input.runId,
      action: input.toolName,
      risk: input.risk,
      reason: input.reason,
      metadata: {
        inputPreview: input.inputPreview ?? null,
      },
      createdAt: new Date(),
    })
    .returning();

  await logMissionEvent({
    missionId: input.missionId,
    eventType: "mission_permission_requested",
    summary: `Permission requested: ${input.toolName}`,
    body: input.reason,
    metadata: {
      requestId: request.id,
      runId: input.runId,
      risk: input.risk,
      status: request.status,
      inputPreview: input.inputPreview ?? null,
    },
  }).catch((err) => logger.warn("Failed to log permission request:", err));

  return request;
}

async function resolveMissionPermissionRequestForTool(input: {
  requestId: number;
  status: "approved" | "denied";
}) {
  const [request] = await db
    .update(missionPermissionRequests)
    .set({
      status: input.status,
      resolvedAt: new Date(),
    })
    .where(eq(missionPermissionRequests.id, input.requestId))
    .returning();

  if (!request) {
    return null;
  }

  await logMissionEvent({
    missionId: request.missionId,
    eventType: "mission_permission_resolved",
    summary: `Permission ${input.status}: ${request.action}`,
    body: request.reason,
    metadata: {
      requestId: request.id,
      runId: request.runId,
      risk: request.risk,
      status: request.status,
    },
  }).catch((err) => logger.warn("Failed to log permission resolution:", err));

  return request;
}

async function getMcpTools(
  event: IpcMainInvokeEvent,
  ctx: AgentContext,
  mcpSessionId: string,
): Promise<ToolSet> {
  const mcpToolSet: ToolSet = {};

  try {
    const servers = await db
      .select()
      .from(mcpServers)
      .where(eq(mcpServers.enabled, true as any));

    for (const s of servers) {
      const client = await mcpManager.acquireClient(s.id, mcpSessionId);
      const toolSet = await client.tools();

      for (const [name, mcpTool] of Object.entries(toolSet)) {
        const key = `${sanitizeMcpName(s.name || "")}__${sanitizeMcpName(name)}`;

        mcpToolSet[key] = {
          description: mcpTool.description,
          inputSchema: mcpTool.inputSchema,
          execute: async (args: unknown, execCtx: ToolExecutionOptions) => {
            try {
              const inputPreview =
                typeof args === "string"
                  ? args
                  : Array.isArray(args)
                    ? args.join(" ")
                    : JSON.stringify(args).slice(0, 500);

              const ok = await requireMcpToolConsent(event, {
                serverId: s.id,
                serverName: s.name,
                toolName: name,
                toolDescription: mcpTool.description,
                inputPreview,
              });

              if (!ok) throw new Error(`User declined running tool ${key}`);

              // Emit XML for UI (MCP tools don't stream, so use onXmlComplete directly)
              const { serverName, toolName } = parseMcpToolKey(key);
              const content = JSON.stringify(args, null, 2);
              ctx.onXmlComplete(
                `<orianbuilder-mcp-tool-call server="${serverName}" tool="${toolName}">\n${content}\n</orianbuilder-mcp-tool-call>`,
              );

              const res = await mcpTool.execute(args, execCtx);
              const resultStr =
                typeof res === "string" ? res : JSON.stringify(res);

              ctx.onXmlComplete(
                `<orianbuilder-mcp-tool-result server="${serverName}" tool="${toolName}">\n${resultStr}\n</orianbuilder-mcp-tool-result>`,
              );

              return resultStr;
            } catch (error) {
              const errorMessage =
                error instanceof Error ? error.message : String(error);
              const errorStack =
                error instanceof Error && error.stack ? error.stack : "";
              ctx.onXmlComplete(
                `<orianbuilder-output type="error" message="MCP tool '${key}' failed: ${escapeXmlAttr(errorMessage)}">${escapeXmlContent(errorStack || errorMessage)}</orianbuilder-output>`,
              );
              throw error;
            }
          },
        };
      }
    }
  } catch (e) {
    logger.warn("Failed building MCP toolset for local-agent", e);
  }

  return mcpToolSet;
}
