/**
 * Local Agent v2 Handler
 * Main orchestrator for tool-based agent mode with parallel execution
 */

import { IpcMainInvokeEvent } from "electron";
import {
  streamText,
  ToolSet,
  stepCountIs,
  hasToolCall,
  ModelMessage,
} from "ai";
import log from "electron-log";

import { db } from "@/db";
import { chats, messages, missionWorkers, missions } from "@/db/schema";
import { and, eq, inArray } from "drizzle-orm";

import { isOrianBuilderProEnabled, type UserSettings } from "@/lib/schemas";
import { readSettings } from "@/main/settings";
import { getOrianBuilderAppPath } from "@/paths/paths";
import { detectFrameworkType } from "@/ipc/utils/framework_utils";
import { getModelClient } from "@/ipc/utils/get_model_client";
import { getServerStatus as getEmbeddedServerStatus } from "@/ipc/utils/embedded_inference_server";
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
} from "../tool_definitions";
import {
  deployAllFunctionsIfNeeded,
  commitAllChanges,
} from "../processors/file_operations";
import { storeDbTimestampAtCurrentVersion } from "@/ipc/utils/neon_timestamp_utils";
import { getMcpToolTrustOverridesByToolKey } from "@/ipc/utils/mcp_consent";
import { getAiMessagesJsonIfWithinLimit } from "@/ipc/utils/ai_messages_utils";

import type { ChatStreamParams, ChatResponseEnd } from "@/ipc/types";
import {
  AgentContext,
  escapeXmlAttr,
  escapeXmlContent,
  UserMessageContentPart,
  FileEditTracker,
} from "../tools/types";
import { sendTelemetryEvent } from "@/ipc/utils/telemetry";
import {
  prepareStepMessages,
  buildTodoReminderMessage,
  hasIncompleteTodos,
  formatTodoSummary,
  ensureToolResultOrdering,
  markIncompleteTodosCompleted,
  type InjectedMessage,
} from "../prepare_step_utils";
import { buildMissionInterruptMessage } from "@/ipc/utils/mission_interrupts";
import { buildMissionMemoryMessage } from "@/ipc/utils/mission_memories";
import { loadTodos, saveTodos } from "../todo_persistence";
import { ensureOrianBuilderGitignored } from "@/ipc/handlers/gitignoreUtils";
import { addIntegrationTool } from "../tools/add_integration";
import { writePlanTool } from "../tools/write_plan";
import { exitPlanTool } from "../tools/exit_plan";
import { appendCancelledResponseNotice } from "@/shared/chatCancellation";
import {
  isChatPendingCompaction,
  performCompaction,
  checkAndMarkForCompaction,
} from "@/ipc/handlers/compaction/compaction_handler";
import { DEFAULT_MAX_TOOL_CALL_STEPS } from "@/constants/settings_constants";
import {
  OrianBuilderError,
  OrianBuilderErrorKind,
} from "@/errors/orianbuilder_error";
import {
  type RetryReplayEvent,
  maybeAppendRetryReplayForRetry,
} from "../retry_replay_utils";
import { setChatSummaryTool } from "../tools/set_chat_summary";
import { packageNativeArtifactTool } from "../tools/package_native_artifact";
import {
  createMissionCheckpoint,
  finishMissionRun,
  logMissionEvent,
  startMissionRun,
} from "@/ipc/utils/mission_utils";
import { syncMissionTasksFromTodos } from "@/ipc/utils/mission_tasks";
import { getAutonomyPolicyDecision } from "@/ipc/utils/autonomy_policy";
import type { McpToolTrustOverrideMap } from "@/ipc/utils/mcp_tool_capabilities";
import type { MissionAutonomyProfile } from "@/ipc/types/mission";
import {
  clampMissionRuntimeBudgetMs,
  createToolFailureBudgetState,
  getMissionRuntimeBudgetStatus,
  MISSION_REPEATED_STEP_LOOP_LIMIT,
  recordToolFailureForBudget,
  recordToolSuccessForBudget,
  type ToolFailureBudgetDecision,
} from "@/ipc/utils/mission_budgets";
import {
  buildNativeTargetReminder,
  detectNativeTargetIntentWithModel,
} from "../native_target_intent";
import { StreamStalledError } from "../streaming/stall_detector";
import { StreamStallDetector } from "../streaming/stall_detector";
import { getChatLockedPaths } from "@/pro/main/ipc/utils/chat_path_locks";
import { isQwenModel, QWEN_CODING_SAMPLING } from "../qwen_sampling";
import { StreamDiagnostics } from "../stream_diagnostics";
import {
  getMissionRunModelName,
  createMissionPermissionRequestForTool,
  loadMissionMemoriesForInjection,
  loadPendingMissionInterrupts,
  logMissionEventsForXml,
  logMissionRetryScheduled,
  markMissionInterruptsInjected,
  releaseMcpSession,
  resolveMissionPermissionRequestForTool,
} from "./AgentMissionBridge";
import { getMidTurnCompactionSummaryIds } from "./AgentCompactionBridge";
import {
  buildChatMessageHistory,
  buildNativeTargetFollowUpMessage,
  hasCompletedNativePackage,
  injectReferencedAppsReminder,
  injectUserMessageReminder,
} from "./AgentSession";
import {
  MAX_TERMINATED_STREAM_RETRIES,
  STREAM_RETRY_BASE_DELAY_MS,
  buildPlanningQuestionnaireReflectionMessage,
  buildTerminatedRetryContinuationInstruction,
  cleanupStreamingEntry,
  delay,
  extractPlainTextToolCall,
  getErrorMessage,
  getPlanningQuestionnaireErrorFromStep,
  getStepSignature,
  getStepToolNames,
  hasRepeatedToolSignature,
  isTerminatedStreamError,
  shouldRetryTransientStreamError,
  shouldRunTodoFollowUpPass,
  stepOnlyCalledTool,
  unwrapStreamError,
} from "./AgentStepProcessor";
import { sendResponseChunk, updateResponseInDb } from "./StreamIO";
import {
  executePlainTextToolFallback,
  getMcpTools,
  maybeRunInStepTextToolCallFallback,
  type TextToolCallFallbackState,
} from "./ToolExecutor";
import {
  applyNativeOutcomeFromXml,
  createNativeOutcomeState,
  runNativeAutofinishSequence,
} from "./NativeTargetManager";
import {
  processStreamPart,
  resolveStreamStallTimeoutMs,
  STREAM_STALL_TIMEOUT_MS,
} from "./StreamingLoop";

const logger = log.scope("local_agent_handler");

/**
 * Handle a chat stream in local-agent mode
 */
export async function runAgentStream(
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
  // Local llama-server / Ollama runs spend most of their wall clock inside
  // long tool calls (npm install, electron-builder, capacitor sync), so the
  // mission-runtime budget needs to be permissive. The setting can override
  // the 8h default if a user wants tighter or looser bounds.
  const runtimeBudgetMs = clampMissionRuntimeBudgetMs(
    settings.missionRuntimeBudgetMinutes,
  );
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
      runtimeBudgetMs,
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
      runtimeBudgetMs,
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
  const textFallbackState: TextToolCallFallbackState = {
    textToolCallFallbackAttempts: 0,
    totalFallbackToolCalls: 0,
    pendingUserMessages,
    warningMessages,
  };
  const recentStepSignatures: string[] = [];
  const warnedStepLoopSignatures = new Set<string>();

  try {
    // Get model client
    const { modelClient } = await getModelClient(
      settings.selectedModel,
      settings,
    );
    // Tools like browser_qa_gate always emit screenshot image parts. The
    // embedded backend only accepts them when a multimodal projector
    // (`mmproj-*.gguf`) is loaded alongside the main weights — we detect that
    // companion at model-load time and expose it as
    // `EmbeddedServerStatus.multimodal`. Cloud providers default to
    // vision-capable routes, so they get supportsImages=true unconditionally.
    const supportsImages =
      settings.selectedModel.provider !== "embedded" ||
      getEmbeddedServerStatus().multimodal;
    const stepCapabilities = { supportsImages };
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
    // Snapshot the chat's locked paths once at turn start. Tools consult this
    // list (synchronously) before mutating any file. Locks added/removed
    // mid-turn won't take effect until the next turn — which is the right
    // semantics since the agent's plan was already formed against this set.
    const lockedPathsFromDb = await getChatLockedPaths(chat.id).catch(
      (err: unknown) => {
        logger.warn("Failed to load chat locked paths:", err);
        return [] as string[];
      },
    );
    const runState = {
      lastBrowserQaStatus: null as "passed" | "failed" | null,
      lastBrowserQaPlaceholderDetected: false,
      filesWrittenSinceCreateProject: new Set<string>(),
      createdProjectThisTurn: false,
      lockedPaths: lockedPathsFromDb,
      placeholderRefusalCount: 0,
    };
    const referencedAppsMap = new Map(
      referencedApps.map((ref) => [ref.appName.toLowerCase(), ref.appPath]),
    );
    const nativeOutcome = createNativeOutcomeState();
    const ctx: AgentContext = {
      event,
      appId: chat.app.id,
      appPath,
      appName: chat.app.name,
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
      runState,
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
        applyNativeOutcomeFromXml(nativeOutcome, finalXml);
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
      emitProgress: (annotation) => {
        // Pushed to the renderer over a dedicated IPC channel so UI can render
        // a step indicator without parsing inline XML. Renderers can ignore
        // this channel safely; it's purely additive.
        safeSend(event.sender, "agent-tool:progress", {
          chatId: chat.id,
          annotation,
        });
      },
      onToolExecutionStart: (params) => {
        if (params.toolName === packageNativeArtifactTool.name) {
          nativeOutcome.attemptedNativePackageArtifact = true;
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
    // Qwen 3.x models REQUIRE specific sampling parameters or they collapse
    // into repetition / emit tool calls as text. The official model card
    // (https://huggingface.co/Qwen/Qwen3.6-27B) specifies temperature 0.6,
    // top_p 0.95, top_k 20 for coding tasks. Our generic default of
    // temperature 0 is the documented failure mode for these models.
    const isQwen = isQwenModel(settings.selectedModel);
    const temperature = isQwen
      ? QWEN_CODING_SAMPLING.temperature
      : settings.selectedModel.provider === "embedded"
        ? undefined
        : await getTemperature(settings.selectedModel);
    const topP = isQwen ? QWEN_CODING_SAMPLING.topP : undefined;
    const topK = isQwen ? QWEN_CODING_SAMPLING.topK : undefined;
    const presencePenalty = isQwen
      ? QWEN_CODING_SAMPLING.presencePenalty
      : undefined;
    if (isQwen) {
      logger.info(
        `Qwen model detected (${settings.selectedModel.name}); applying recommended sampling: ` +
          `temp=${temperature}, topP=${topP}, topK=${topK}, presencePenalty=${presencePenalty}`,
      );
    }

    // Run one or more generation passes. If the model emits a chat message while
    // there are still incomplete todos, we append a reminder and do another pass.
    const maxTodoFollowUpLoops = 1;
    let todoFollowUpLoops = 0;
    // Re-engage the agent up to 2 times after the stream ends when the
    // native target hasn't been fully delivered. Critical for weak local
    // models that scaffold but skip customization — without this, auto-finish
    // ships the generic baseline as the final APK.
    const maxNativeTargetFollowUpLoops = 2;
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

        // Per-attempt inner abort controller. Aborted by the stall detector
        // when the stream stops producing tokens; combined with the outer
        // abortController so user cancellation still works.
        const stallAbortController = new AbortController();
        let stallDetectedThisAttempt = false;
        const stallTimeoutMs = resolveStreamStallTimeoutMs(
          settings.streamStallTimeoutSeconds,
        );
        const stallDetector = new StreamStallDetector({
          stallTimeoutMs,
          onStall: (elapsed) => {
            stallDetectedThisAttempt = true;
            logger.warn(
              `Stream stalled (${elapsed}ms no chunks) for chat ${req.chatId}; aborting attempt for retry`,
            );
            stallAbortController.abort();
          },
        });

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
            topP,
            topK,
            presencePenalty,
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
                    // Critical: halt only on *successful* gate / package / deploy,
                    // not on the mere act of calling them. Otherwise a refused
                    // browser_qa_gate (e.g., placeholder still present) ends
                    // the stream and the synthetic recovery directive in
                    // pendingUserMessages is never consumed.
                    () => nativeOutcome.passedBrowserQaGate,
                    () => nativeOutcome.producedNativePackageArtifact,
                    () => nativeOutcome.producedDeploymentUrl,
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
            abortSignal: AbortSignal.any([
              abortController.signal,
              stallAbortController.signal,
            ]),
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
                stepCapabilities,
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

              await maybeRunInStepTextToolCallFallback({
                step,
                ctx,
                state: textFallbackState,
                autonomyProfile,
                abortController,
                missionId,
                missionStepCheckpointCount,
                stepMetadata,
              });

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
                runtimeBudgetMs,
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
            onError: (error: unknown) => {
              const normalizedError = unwrapStreamError(error);
              streamErrorFromCallback = normalizedError;
              logger.error(
                "Local agent stream error:",
                getErrorMessage(normalizedError),
              );
            },
          });

          let streamErrorFromIteration: unknown;
          stallDetector.start();

          // Diagnostic record for this stream attempt — emitted at end so the
          // user has a structured trace of what arrived from the model.
          const diagnostics = new StreamDiagnostics({
            attemptId: `${req.chatId}-${terminatedRetryCount}-${Date.now()}`,
            modelName: settings.selectedModel.name,
            modelProvider: settings.selectedModel.provider,
            isQwen,
            samplingParams: {
              temperature,
              topP,
              topK,
              presencePenalty,
              maxOutputTokens,
            },
          });

          const partState = {
            inThinkingBlock: false,
            passProducedChatText: false,
            attemptToolInputIds,
          };

          try {
            for await (const part of streamResult.fullStream) {
              stallDetector.pulse();
              diagnostics.observePart(part.type);
              if (abortController.signal.aborted) {
                logger.log(`Stream aborted for chat ${req.chatId}`);
                // Clean up pending consent/questionnaire requests to prevent stale UI banners
                clearPendingConsentsForChat(req.chatId);
                clearPendingQuestionnairesForChat(req.chatId);
                break;
              }

              const chunk = processStreamPart({
                part: part as { type: string } & Record<string, unknown>,
                state: partState,
                ctx,
                diagnostics,
                activeRetryReplayEvents: activeRetryReplayEvents ?? [],
                attemptRetryReplayEvents: retryReplayEvents,
              });

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
              // Stall-driven aborts surface here as AbortError. Convert them
              // into a StreamStalledError so shouldRetryTransientStreamError
              // recognizes them and the outer retry loop fires.
              if (stallDetectedThisAttempt) {
                streamErrorFromIteration = new StreamStalledError(
                  STREAM_STALL_TIMEOUT_MS,
                );
              } else {
                streamErrorFromIteration = error;
              }
            } else {
              logger.log(
                `Stream interrupted after abort for chat ${req.chatId}`,
              );
            }
          } finally {
            stallDetector.stop();
            // Emit one-line structured trace + warning hint when the model
            // appears to be emitting tool calls / thinking blocks as text
            // (the canonical Qwen-via-LM-Studio misconfiguration).
            diagnostics.emit(
              streamErrorFromIteration || streamErrorFromCallback
                ? "warn"
                : "info",
            );
          }

          if (partState.passProducedChatText) {
            passProducedChatText = true;
          }

          // Close thinking block if still open
          if (partState.inThinkingBlock) {
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

          const recoveryMessage = await executePlainTextToolFallback({
            toolName: plainTextToolCall.toolName,
            args: plainTextToolCall.args,
            allTools,
          });
          currentMessageHistory = [...currentMessageHistory, recoveryMessage];
          continue;
        }
      }

      const appIndexEdited =
        runState.filesWrittenSinceCreateProject.has("app/index.tsx");
      const needsCustomization =
        runState.createdProjectThisTurn && !appIndexEdited;

      if (
        nativeTargetIntent &&
        passEndedWithText &&
        (!hasCompletedNativePackage(fullResponse) || needsCustomization) &&
        nativeTargetFollowUpLoops < maxNativeTargetFollowUpLoops
      ) {
        nativeTargetFollowUpLoops += 1;
        currentMessageHistory = [
          ...currentMessageHistory,
          buildNativeTargetFollowUpMessage(nativeTargetIntent, {
            userPrompt: req.prompt ?? null,
            appIndexEdited,
            createdProjectThisTurn: runState.createdProjectThisTurn,
          }),
        ];
        logger.info(
          `Starting native target follow-up pass ${nativeTargetFollowUpLoops}/${maxNativeTargetFollowUpLoops} for chat ${req.chatId} (customization-needed: ${needsCustomization})`,
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

    const autofinishExecutedToolCount = await runNativeAutofinishSequence({
      nativeTargetIntent,
      outcome: nativeOutcome,
      runState,
      ctx,
      req: { prompt: req.prompt, chatId: req.chatId },
      appPath,
      missionId,
      missionRunId,
      model: modelClient.model,
      warningMessages,
    });

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
    // one). The native-autofinish path is also considered real work — if it
    // ran a tool successfully (browser QA / native package / deploy) the run
    // produced artifacts even when the model only emitted text.
    const isDeadRun =
      !readOnly &&
      totalNativeToolCalls === 0 &&
      textFallbackState.totalFallbackToolCalls === 0 &&
      textFallbackState.textToolCallFallbackAttempts === 0 &&
      autofinishExecutedToolCount === 0;

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
        totalFallbackToolCalls: textFallbackState.totalFallbackToolCalls,
        textToolCallFallbackAttempts:
          textFallbackState.textToolCallFallbackAttempts,
        autofinishExecutedToolCount,
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
        totalFallbackToolCalls: textFallbackState.totalFallbackToolCalls,
        textToolCallFallbackAttempts:
          textFallbackState.textToolCallFallbackAttempts,
      },
    }).catch((err) => logger.warn("Failed to finish mission run:", err));

    const nativeMissionReadyToComplete =
      !nativeTargetIntent ||
      (nativeOutcome.producedBrowserQaScreenshotArtifact &&
        nativeOutcome.passedBrowserQaGate &&
        nativeOutcome.producedNativePackageArtifact &&
        nativeOutcome.producedDeploymentUrl);
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

        // Auto-complete any todos that the agent left as pending/in_progress.
        // When the mission is being marked completed, lingering todos would
        // otherwise show as "still running" tasks in the UI even though all
        // verification gates and the native build have succeeded.
        if (hasIncompleteTodos(ctx.todos)) {
          const completedTodos = markIncompleteTodosCompleted(ctx.todos);
          ctx.todos = completedTodos;
          await saveTodos(appPath, chat.id, completedTodos).catch((err) =>
            logger.warn("Failed to save auto-completed todos:", err),
          );
          ctx.onUpdateTodos(completedTodos);
        }

        await logMissionEvent({
          missionId,
          eventType: "mission_status_changed",
          summary: "Mission marked completed",
          metadata: {
            status: "completed",
            source: "local_agent_stream",
            chatId: req.chatId,
            nativeTarget: nativeTargetIntent?.target ?? null,
            browserQaPassed: nativeTargetIntent
              ? nativeOutcome.passedBrowserQaGate
              : null,
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

export type AgentStreamRunnerOptions = Parameters<typeof runAgentStream>[3];

export class AgentStreamRunner {
  constructor(
    private readonly event: IpcMainInvokeEvent,
    private readonly req: ChatStreamParams,
    private readonly abortController: AbortController,
    private readonly options: AgentStreamRunnerOptions,
  ) {}

  run(): Promise<boolean> {
    return runAgentStream(
      this.event,
      this.req,
      this.abortController,
      this.options,
    );
  }
}
