/**
 * Type-Safe IPC Layer
 *
 * This module provides a unified, type-safe interface for all IPC operations.
 * Contracts define the single source of truth for channel names, input schemas,
 * and output schemas. Clients are auto-generated from contracts.
 *
 * @example
 * // Invoke-response pattern
 * const settings = await ipc.settings.getUserSettings();
 * const { app, chatId } = await ipc.app.createApp({ name: "my-app" });
 *
 * // Streaming pattern
 * ipc.chatStream.start(
 *   { chatId: 123, prompt: "Hello" },
 *   { onChunk, onEnd, onError }
 * );
 *
 * // Event subscription pattern
 * const unsubscribe = ipc.events.agent.onTodosUpdate((payload) => {
 *   updateTodoList(payload.todos);
 * });
 */

// =============================================================================
// Contract Exports
// =============================================================================

export { settingsContracts } from "./settings";
export { appContracts } from "./app";
export { chatContracts, chatStreamContract } from "./chat";
export { agentContracts, agentEvents } from "./agent";
export { githubContracts, gitContracts, githubEvents } from "./github";
export { mcpContracts, mcpEvents } from "./mcp";
export { vercelContracts } from "./vercel";
export { netlifyContracts } from "./netlify";
export { supabaseContracts } from "./supabase";
export { neonContracts } from "./neon";
export { migrationContracts } from "./migration";
export { systemContracts, systemEvents } from "./system";
export { versionContracts } from "./version";
export { languageModelContracts } from "./language-model";
export { promptContracts } from "./prompts";
export { templateContracts } from "./templates";
export { proposalContracts } from "./proposals";
export { importContracts } from "./import";
export { helpContracts, helpStreamContract } from "./help";
export { capacitorContracts } from "./capacitor";
export { contextContracts } from "./context";
export { upgradeContracts } from "./upgrade";
export { visualEditingContracts } from "./visual-editing";
export { securityContracts } from "./security";
export { miscContracts, miscEvents } from "./misc";
export { freeAgentQuotaContracts } from "./free_agent_quota";
export { audioContracts } from "./audio";
export { mediaContracts } from "./media";
export { mediaAiContracts } from "./media_ai";
export { imageGenerationContracts } from "./image_generation";
export { identityContracts } from "./identity";
export { networkContracts, networkEvents } from "./network";
export { computeContracts } from "./compute";
export {
  designStudioContracts,
  designStudioClient,
  designStudioChatStream,
  designStudioChatStreamClient,
} from "./design_studio";
export type {
  DesignSkill,
  DesignSystem,
  CraftRule,
  DesignChatMessage,
  DesignSession,
  DesignSessionSummary,
} from "./design_studio";
export {
  watchdogContracts,
  watchdogClient,
  watchdogEvents,
  watchdogEventClient,
} from "./watchdog";
export {
  generatedMediaContracts,
  generatedMediaClient,
  generatedMediaEvents,
  generatedMediaEventClient,
  generatedMediaUrl,
} from "./generated_media";
export type { GeneratedMediaItem, GeneratedMediaKind } from "./generated_media";
export {
  sharedMediaContracts,
  sharedMediaClient,
  sharedMediaEvents,
  sharedMediaEventClient,
} from "./shared_media";
export {
  mediaQueueContracts,
  mediaQueueClient,
  mediaQueueEvents,
  mediaQueueEventClient,
} from "./media_queue";
export {
  orionSetupContracts,
  orionSetupClient,
  orionSetupEvents,
  orionSetupEventClient,
} from "./orion_setup";
export type {
  OrionSetupState,
  OrionSetupStep,
  OrionSetupStepId,
  OrionSetupStepStatus,
  OrionSetupOverall,
  StartOrionSetupParams,
} from "./orion_setup";
export type {
  MediaJob,
  MediaJobKind,
  MediaJobStatus,
  MediaAspectRatio,
  EnqueueMediaJobParams,
} from "./media_queue";
export type {
  SharedMediaMeta,
  SharedPeerCatalog,
  SharedDownloadProgress,
} from "./shared_media";
export {
  youtubeContracts,
  youtubeClient,
  youtubeEvents,
  youtubeEventClient,
} from "./youtube";
export type { YouTubeStatus, YouTubePrivacy } from "./youtube";
export {
  androidEmulatorContracts,
  androidEmulatorClient,
  androidEmulatorEvents,
  androidEmulatorEventClient,
} from "./android_emulator";
export {
  scheduleContracts,
  scheduleClient,
  scheduleEvents,
  scheduleEventClient,
} from "./schedule";
export type { ScheduleJob, SchedulePlatform, ScheduleStatus } from "./schedule";
export type {
  AndroidEmulatorStatus,
  AndroidSetupProgress,
  AndroidOperationResult,
  AndroidFindApkResult,
  AndroidLaunchParams,
} from "./android_emulator";
export type {
  WatchdogStatus,
  WatchdogSetupParams,
  WatchdogSetupResult,
  WatchdogSetupPhase,
  WatchdogSetupProgress,
  WatchdogStartResult,
} from "./watchdog";
export {
  embeddedModelContracts,
  embeddedModelClient,
  embeddedModelEvents,
  embeddedModelEventClient,
} from "./embedded_model";
export type {
  GpuInfo,
  GpuStats,
  EmbeddedServerStatus,
  EmbeddedModelConfig,
  ModelInfo,
  InferenceStats,
  InferenceState,
  InferenceLogEntry,
  TensorRtEngineBuildStatus,
  TensorRtEngineBuildRequest,
  SwapEmbeddedModelParams,
  AllGpuEntry,
  AllGpusInfo,
} from "./embedded_model";
export {
  modelMarketplaceContracts,
  modelMarketplaceClient,
  modelMarketplaceEvents,
  modelMarketplaceEventClient,
} from "./model_marketplace";
export { missionContracts, missionClient } from "./mission";
export {
  flowContracts,
  flowClient,
  flowEvents,
  flowEventClient,
} from "./intent";
export type {
  CapabilityId,
  CommandIntent,
  FlowRunResult,
  PipelineProgress,
  FlowActivity,
} from "./intent";
export {
  martaContracts,
  martaClient,
  martaEvents,
  martaEventClient,
  martaTurnStreamContract,
  martaTurnStreamClient,
} from "./marta";
export type {
  MartaAction,
  MartaSurface,
  MartaDelegate,
  MartaGraphSummary,
  MartaStageState,
  MartaWorldState,
  MartaResidency,
  MartaTierId,
  MartaTurnEvent,
  MartaModelStatus,
  MartaTask,
  MartaEvidence,
  MartaTaskEvent,
  MartaTaskStatus,
  MartaPreferences,
  MartaNarrationDetail,
  MartaCodingWorker,
  MartaDelegationConversation,
  MartaDelegationSelection,
  MartaPendingDelegation,
} from "./marta";
export {
  hardwareContracts,
  hardwareClient,
  HardwareProfileSchema,
  HardwareGpuInfoSchema,
} from "./hardware";
export type { HardwareGpuInfo, HardwareProfile } from "./hardware";
export {
  telemetryContracts,
  telemetryClient,
  LiveTelemetrySampleSchema,
  InferenceTelemetrySchema,
} from "./telemetry";
export type {
  GpuLiveSample,
  InferenceSample,
  InferenceTelemetry,
  LiveTelemetrySample,
} from "./telemetry";
export {
  godotContracts,
  godotClient,
  godotEvents,
  godotEventClient,
  blenderContracts,
  blenderClient,
} from "./game";
export {
  claudeCodeContracts,
  claudeCodeClient,
  claudeCodeEvents,
  claudeCodeEventClient,
} from "./claude_code";
export type {
  ClaudeAvailability,
  ClaudeAccountUsage,
  ClaudeEvent,
  ClaudeEffort,
  ClaudePermissionMode,
  ClaudeTurnUsage,
} from "./claude_code";
export {
  terminalContracts,
  terminalClient,
  terminalEvents,
  terminalEventClient,
  workspaceFilesContracts,
  workspaceFilesClient,
} from "./workspace";
export type {
  TerminalInfo,
  WorkspaceFileEntry,
  WorkspaceEntryProperties,
} from "./workspace";
export type {
  GodotInstallInfo,
  GodotMode,
  GodotStatus,
  GodotProject,
  GodotAssetKind,
  GodotExportTarget,
  BlenderInstallInfo,
  BlenderOpName,
} from "./game";
export {
  llamaBinaryContracts,
  llamaBinaryClient,
  llamaBinaryEvents,
  llamaBinaryEventClient,
} from "./llama_binary";
export type {
  LlamaBinaryCheckResult,
  LlamaBinaryDownloadProgress,
  LlamaBinaryDownloadResult,
} from "./llama_binary";
export {
  orchestratorContracts,
  orchestratorClient,
  OrchestratorStateSchema,
  OrchestratorStatusSchema,
  LlmLoadParamsSchema,
  MediaGenerationRequestSchema,
  MediaGenerationResultSchema,
  MediaTierSchema,
  MediaQualitySchema,
  AvailableTiersSchema,
} from "./model_orchestrator";
export type {
  OrchestratorState,
  OrchestratorStatus,
  LlmLoadParams,
  MediaGenerationRequest,
  MediaGenerationResult,
  MediaTier,
  MediaQuality,
  AvailableTiers,
} from "./model_orchestrator";
export type {
  HFSearchModel,
  HFFileSibling,
  HFModelDetail,
  DownloadProgress,
  LocalModelEntry,
  GgufMetadata,
} from "./model_marketplace";
export type {
  Mission,
  MissionEvent,
  MissionTask,
  MissionRun,
  MissionWorker,
  MissionWorkerReport,
  MissionCheckpoint,
  MissionArtifact,
  MissionInterrupt,
  MissionMemory,
  MissionPermissionRequest,
  CreateMissionParams,
  UpdateMissionStatusParams,
  AddMissionEventParams,
  CreateMissionWorkerParams,
  UpdateMissionWorkerStatusParams,
  DispatchMissionWorkersParams,
  RetryMissionWorkerParams,
  MarkStaleMissionWorkersParams,
  SubmitMissionWorkerReportParams,
  PrepareMissionWorkerWorkspaceParams,
  SetMissionWorkerIntegrationStatusParams,
  RunReadyMissionWorkersParams,
  ApplyAcceptedMissionWorkerOutputsParams,
  CleanupAppliedMissionWorkerWorkspacesParams,
  CreateMissionInterruptParams,
  MarkMissionInterruptsInjectedParams,
  CreateMissionMemoryParams,
  ListMissionMemoriesParams,
  CreateMissionPermissionRequestParams,
  ResolveMissionPermissionRequestParams,
  ExpireMissionPermissionRequestsParams,
} from "./mission";

// =============================================================================
// Client Exports
// =============================================================================

export { settingsClient } from "./settings";
export { appClient } from "./app";
export { chatClient, chatStreamClient } from "./chat";
export { agentClient, agentEventClient } from "./agent";
export { githubClient, gitClient, githubEventClient } from "./github";
export { mcpClient, mcpEventClient } from "./mcp";
export { vercelClient } from "./vercel";
export { netlifyClient } from "./netlify";
export { supabaseClient } from "./supabase";
export { neonClient } from "./neon";
export { migrationClient } from "./migration";
export { systemClient, systemEventClient } from "./system";
export { versionClient } from "./version";
export { languageModelClient } from "./language-model";
export { promptClient } from "./prompts";
export { templateClient } from "./templates";
export { proposalClient } from "./proposals";
export { importClient } from "./import";
export { helpClient, helpStreamClient } from "./help";
export { capacitorClient } from "./capacitor";
export { contextClient } from "./context";
export { upgradeClient } from "./upgrade";
export { visualEditingClient } from "./visual-editing";
export { securityClient } from "./security";
export { miscClient, miscEventClient } from "./misc";
export { freeAgentQuotaClient } from "./free_agent_quota";
export { audioClient } from "./audio";
export { mediaClient } from "./media";
export { mediaAiClient } from "./media_ai";
export { imageGenerationClient } from "./image_generation";
export { identityClient } from "./identity";
export { networkClient, networkEventClient } from "./network";
export { computeClient } from "./compute";

// =============================================================================
// Type Exports
// =============================================================================

// Settings types
export type {
  GetUserSettingsInput,
  GetUserSettingsOutput,
  SetUserSettingsInput,
  SetUserSettingsOutput,
} from "./settings";

// App types
export type {
  App,
  CreateAppParams,
  CreateAppResult,
  CopyAppParams,
  EditAppFileReturnType,
  RespondToAppInputParams,
  AppFileSearchResult,
  ChangeAppLocationParams,
  ChangeAppLocationResult,
  ListAppsResponse,
  RenameBranchParams,
  UpdateAppCommandsParams,
} from "./app";

// Chat types
export type {
  Message,
  Chat,
  ComponentSelection,
  FileAttachment,
  ChatAttachment,
  ChatStreamParams,
  ChatResponseChunk,
  ChatResponseEnd,
  UpdateChatParams,
  AppendChatMessagesParams,
  TokenCountParams,
  TokenCountResult,
} from "./chat";

// Agent types
export type {
  AgentTool,
  AgentTodo,
  AgentToolConsentRequestPayload,
  AgentToolConsentDecision,
  AgentToolConsentResponseParams,
  AgentTodosUpdatePayload,
  AgentProblemsUpdatePayload,
  SetAgentToolConsentParams,
  Problem,
  ProblemReport,
} from "./agent";

// GitHub types
export type {
  GitBranchAppIdParams,
  GitBranchParams,
  CreateGitBranchParams,
  RenameGitBranchParams,
  ListRemoteGitBranchesParams,
  CommitChangesParams,
  UncommittedFile,
  UncommittedFileStatus,
  GithubSyncOptions,
  CloneRepoParams,
  GithubRepository,
} from "./github";

// MCP types
export type {
  McpServer,
  McpTransport,
  CreateMcpServer,
  McpServerUpdate,
  McpTool,
  McpToolConsent,
  McpConsentValue,
  McpConsentDecision,
  SetMcpToolConsentParams,
  SetMcpToolTrustOverrideParams,
  McpConsentRequestPayload,
  McpConsentResponseParams,
} from "./mcp";

// Vercel types
export type {
  VercelProject,
  VercelDeployment,
  SaveVercelAccessTokenParams,
  ConnectToExistingVercelProjectParams,
  IsVercelProjectAvailableParams,
  IsVercelProjectAvailableResponse,
  CreateVercelProjectParams,
  GetVercelDeploymentsParams,
  DisconnectVercelProjectParams,
} from "./vercel";

// Netlify types
export type {
  NetlifySite,
  NetlifyDeployment,
  SaveNetlifyAccessTokenParams,
  ConnectToExistingNetlifySiteParams,
  IsNetlifySiteAvailableParams,
  IsNetlifySiteAvailableResponse,
  CreateNetlifySiteParams,
  GetNetlifyDeploymentsParams,
  DisconnectNetlifySiteParams,
} from "./netlify";

// Supabase types
export type {
  SupabaseOrganizationInfo,
  SupabaseProject,
  SupabaseBranch,
  DeleteSupabaseOrganizationParams,
  SetSupabaseAppProjectParams,
  ConsoleEntry,
} from "./supabase";

// Neon types
export type {
  NeonProject,
  NeonProjectListItem,
  NeonBranch,
  CreateNeonProjectParams,
  GetNeonProjectParams,
  GetNeonProjectResponse,
  ListNeonProjectsResponse,
  NeonAuthEmailAndPasswordConfig,
} from "./neon";

// Migration types
export type { MigrationPushParams, MigrationPushResponse } from "./migration";

// System types
export type {
  NodeSystemInfo,
  SystemDebugInfo,
  SelectNodeFolderResult,
  DoesReleaseNoteExistParams,
  UserBudgetInfo,
  TelemetryEventPayload,
} from "./system";

// Version types
export type {
  Version,
  BranchResult,
  RevertVersionParams,
  RevertVersionResponse,
} from "./version";

// Language model types
export type {
  LanguageModelProvider,
  LanguageModel,
  LocalModel,
  CreateCustomLanguageModelProviderParams,
  CreateCustomLanguageModelParams,
} from "./language-model";

// Prompt types
export type {
  PromptDto,
  CreatePromptParamsDto,
  UpdatePromptParamsDto,
} from "./prompts";

// Template types
export type {
  Template,
  Theme,
  SetAppThemeParams,
  GetAppThemeParams,
  SelectTemplateForPromptParams,
  SelectTemplateForPromptResult,
  CustomTheme,
  CreateCustomThemeParams,
  UpdateCustomThemeParams,
  DeleteCustomThemeParams,
  ThemeGenerationMode,
  ThemeGenerationModel,
  ThemeGenerationModelOption,
  ThemeInputSource,
  CrawlStatus,
  GenerateThemePromptParams,
  GenerateThemePromptResult,
  GenerateThemeFromUrlParams,
  SaveThemeImageParams,
  SaveThemeImageResult,
  CleanupThemeImagesParams,
} from "./templates";

// Proposal types
export type { ProposalResult, ApproveProposalResult } from "./proposals";

// Import types
export type { ImportAppParams, ImportAppResult } from "./import";

// Help types
export type { HelpChatStartParams } from "./help";

// Context types
export type { ContextPathResults, AppChatContext } from "./context";

// Upgrade types
export type { AppUpgrade } from "./upgrade";

// Visual editing types
export type {
  VisualEditingChange,
  ApplyVisualEditingChangesParams,
  AnalyseComponentParams,
} from "./visual-editing";

// Security types
export type { SecurityReviewResult } from "./security";

// Misc types
export type {
  SessionDebugBundle,
  DeepLinkData,
  AppOutput,
  EnvVar,
} from "./misc";

// Free agent quota types
export type { FreeAgentQuotaStatus } from "./free_agent_quota";

// Pro types
export type { TranscribeAudioParams, TranscribeAudioResult } from "./audio";

// Media types
export type {
  MediaFile,
  RenameMediaFileParams,
  DeleteMediaFileParams,
  MoveMediaFileParams,
} from "./media";

// Media AI backend types
export type {
  MediaAiModelId,
  MediaAiModelStatus,
  MediaAiStatus,
  MediaAiOperationResult,
  DownloadMediaAiModelsParams,
} from "./media_ai";

// Image generation types
export type {
  ImageThemeMode,
  GenerateImageParams,
  GenerateImageResponse,
} from "./image_generation";

// Identity types
export type {
  DeviceIdentity,
  DeviceHardware,
  UpdateDeviceInput,
} from "./identity";

// =============================================================================
// Schema Exports (for validation in handlers/components)
// =============================================================================

export {
  AppSchema,
  CreateAppParamsSchema,
  CreateAppResultSchema,
  AppFileSearchResultSchema,
} from "./app";

export {
  MessageSchema,
  ChatSchema,
  ChatAttachmentSchema,
  ChatStreamParamsSchema,
  ChatResponseEndSchema,
} from "./chat";

export {
  AgentTodoSchema,
  AgentTodosUpdateSchema,
  AgentToolSchema,
  AgentToolConsentRequestSchema,
} from "./agent";

export { UserBudgetInfoSchema } from "./system";

// =============================================================================
// Aggregated IPC Client
// =============================================================================

import { settingsClient } from "./settings";
import { appClient } from "./app";
import { chatClient, chatStreamClient } from "./chat";
import { agentClient, agentEventClient } from "./agent";
import { githubClient, gitClient, githubEventClient } from "./github";
import { mcpClient, mcpEventClient } from "./mcp";
import { vercelClient } from "./vercel";
import { netlifyClient } from "./netlify";
import { supabaseClient } from "./supabase";
import { neonClient } from "./neon";
import { migrationClient } from "./migration";
import { systemClient, systemEventClient } from "./system";
import { versionClient } from "./version";
import { languageModelClient } from "./language-model";
import { promptClient } from "./prompts";
import { templateClient } from "./templates";
import { proposalClient } from "./proposals";
import { importClient } from "./import";
import { helpClient, helpStreamClient } from "./help";
import { capacitorClient } from "./capacitor";
import { contextClient } from "./context";
import { upgradeClient } from "./upgrade";
import { visualEditingClient } from "./visual-editing";
import { securityClient } from "./security";
import { miscClient, miscEventClient } from "./misc";
import { freeAgentQuotaClient } from "./free_agent_quota";
import { audioClient } from "./audio";
import { mediaClient } from "./media";
import { mediaAiClient } from "./media_ai";
import { imageGenerationClient } from "./image_generation";
import {
  embeddedModelClient,
  embeddedModelEventClient,
} from "./embedded_model";
import {
  modelMarketplaceClient,
  modelMarketplaceEventClient,
} from "./model_marketplace";
import { missionClient } from "./mission";
import { hardwareClient } from "./hardware";
import { telemetryClient } from "./telemetry";
import { godotClient, blenderClient, godotEventClient } from "./game";
import { claudeCodeClient, claudeCodeEventClient } from "./claude_code";
import {
  terminalClient,
  terminalEventClient,
  workspaceFilesClient,
} from "./workspace";
import { orchestratorClient } from "./model_orchestrator";
import { flowClient, flowEventClient } from "./intent";
import { llamaBinaryClient, llamaBinaryEventClient } from "./llama_binary";
import { identityClient } from "./identity";
import { networkClient, networkEventClient } from "./network";
import { computeClient } from "./compute";
import { watchdogClient, watchdogEventClient } from "./watchdog";
import {
  generatedMediaClient,
  generatedMediaEventClient,
} from "./generated_media";
import { sharedMediaClient, sharedMediaEventClient } from "./shared_media";
import { mediaQueueClient, mediaQueueEventClient } from "./media_queue";
import { orionSetupClient, orionSetupEventClient } from "./orion_setup";
import { youtubeClient, youtubeEventClient } from "./youtube";
import {
  androidEmulatorClient,
  androidEmulatorEventClient,
} from "./android_emulator";
import {
  designStudioClient,
  designStudioChatStreamClient,
} from "./design_studio";
import { scheduleClient, scheduleEventClient } from "./schedule";
import { martaClient, martaEventClient } from "./marta";

/**
 * Unified IPC client with all domains organized by namespace.
 *
 * @example
 * // Settings
 * const settings = await ipc.settings.getUserSettings();
 *
 * // App management
 * const app = await ipc.app.getApp(appId);
 *
 * // Chat operations
 * const chat = await ipc.chat.getChat(chatId);
 *
 * // Streaming
 * ipc.chatStream.start(params, callbacks);
 *
 * // Event subscriptions
 * ipc.events.agent.onTodosUpdate(handler);
 */
export const ipc = {
  // Core domains
  settings: settingsClient,
  app: appClient,
  chat: chatClient,
  agent: agentClient,

  // Streaming clients
  chatStream: chatStreamClient,
  helpStream: helpStreamClient,

  // Integrations
  github: githubClient,
  git: gitClient,
  mcp: mcpClient,
  vercel: vercelClient,
  netlify: netlifyClient,
  supabase: supabaseClient,
  neon: neonClient,
  migration: migrationClient,

  // Features
  system: systemClient,
  version: versionClient,
  languageModel: languageModelClient,
  prompt: promptClient,
  template: templateClient,
  proposal: proposalClient,
  import: importClient,
  help: helpClient,
  capacitor: capacitorClient,
  context: contextClient,
  upgrade: upgradeClient,
  visualEditing: visualEditingClient,
  security: securityClient,
  misc: miscClient,
  freeAgentQuota: freeAgentQuotaClient,
  audio: audioClient,
  media: mediaClient,
  mediaAi: mediaAiClient,
  imageGeneration: imageGenerationClient,
  embeddedModel: embeddedModelClient,
  marketplace: modelMarketplaceClient,
  mission: missionClient,
  hardware: hardwareClient,
  telemetry: telemetryClient,
  godot: godotClient,
  blender: blenderClient,
  claudeCode: claudeCodeClient,
  terminal: terminalClient,
  workspaceFiles: workspaceFilesClient,
  orchestrator: orchestratorClient,
  flow: flowClient,
  llamaBinary: llamaBinaryClient,
  identity: identityClient,
  network: networkClient,
  compute: computeClient,
  watchdog: watchdogClient,
  generatedMedia: generatedMediaClient,
  sharedMedia: sharedMediaClient,
  mediaQueue: mediaQueueClient,
  orionSetup: orionSetupClient,
  youtube: youtubeClient,
  androidEmulator: androidEmulatorClient,
  designStudio: designStudioClient,
  designStudioStream: designStudioChatStreamClient,
  schedule: scheduleClient,
  marta: martaClient,

  // Event clients for main->renderer pub/sub
  events: {
    agent: agentEventClient,
    github: githubEventClient,
    mcp: mcpEventClient,
    system: systemEventClient,
    misc: miscEventClient,
    marketplace: modelMarketplaceEventClient,
    embeddedModel: embeddedModelEventClient,
    llamaBinary: llamaBinaryEventClient,
    network: networkEventClient,
    watchdog: watchdogEventClient,
    generatedMedia: generatedMediaEventClient,
    sharedMedia: sharedMediaEventClient,
    mediaQueue: mediaQueueEventClient,
    orionSetup: orionSetupEventClient,
    youtube: youtubeEventClient,
    androidEmulator: androidEmulatorEventClient,
    schedule: scheduleEventClient,
    godot: godotEventClient,
    terminal: terminalEventClient,
    claudeCode: claudeCodeEventClient,
    marta: martaEventClient,
    flow: flowEventClient,
  },
} as const;
