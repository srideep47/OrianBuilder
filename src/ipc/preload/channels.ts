/**
 * Channel Definitions for Preload Script
 *
 * This file derives the list of valid IPC channels from contract definitions.
 * It serves as the single source of truth for the preload script's channel whitelist.
 *
 * All channels are now derived from contracts - no legacy channels remain.
 */

import {
  getInvokeChannels,
  getReceiveChannels,
  getStreamChannels,
} from "../contracts/core";

// Import all contracts
import { settingsContracts } from "../types/settings";
import { appContracts } from "../types/app";
import { chatContracts, chatStreamContract } from "../types/chat";
import { agentContracts, agentEvents } from "../types/agent";
import { githubContracts, gitContracts, githubEvents } from "../types/github";
import { mcpContracts, mcpEvents } from "../types/mcp";
import { vercelContracts } from "../types/vercel";
import { netlifyContracts } from "../types/netlify";
import { supabaseContracts } from "../types/supabase";
import { neonContracts } from "../types/neon";
import { migrationContracts } from "../types/migration";
import { systemContracts, systemEvents } from "../types/system";
import { versionContracts } from "../types/version";
import { languageModelContracts } from "../types/language-model";
import { promptContracts } from "../types/prompts";
import { templateContracts } from "../types/templates";
import { proposalContracts } from "../types/proposals";
import { importContracts } from "../types/import";
import { helpContracts, helpStreamContract } from "../types/help";
import { capacitorContracts } from "../types/capacitor";
import { contextContracts } from "../types/context";
import { upgradeContracts } from "../types/upgrade";
import { visualEditingContracts } from "../types/visual-editing";
import { securityContracts } from "../types/security";
import { miscContracts, miscEvents } from "../types/misc";
import { freeAgentQuotaContracts } from "../types/free_agent_quota";
import { planEvents, planContracts } from "../types/plan";
import { audioContracts } from "../types/audio";
import { mediaContracts } from "../types/media";
import { mediaAiContracts } from "../types/media_ai";
import { imageGenerationContracts } from "../types/image_generation";
import {
  embeddedModelContracts,
  embeddedModelEvents,
} from "../types/embedded_model";
import {
  modelMarketplaceContracts,
  modelMarketplaceEvents,
} from "../types/model_marketplace";
import { missionContracts } from "../types/mission";
import { hardwareContracts } from "../types/hardware";
import { godotContracts, godotEvents, blenderContracts } from "../types/game";
import { claudeCodeContracts, claudeCodeEvents } from "../types/claude_code";
import {
  terminalContracts,
  terminalEvents,
  workspaceFilesContracts,
} from "../types/workspace";
import { orchestratorContracts } from "../types/model_orchestrator";
import { flowContracts, flowEvents } from "../types/intent";
import { llamaBinaryContracts, llamaBinaryEvents } from "../types/llama_binary";
import { identityContracts } from "../types/identity";
import { networkContracts, networkEvents } from "../types/network";
import { computeContracts } from "../types/compute";
import { watchdogContracts, watchdogEvents } from "../types/watchdog";
import {
  designStudioContracts,
  designStudioChatStream,
} from "../types/design_studio";
import {
  generatedMediaContracts,
  generatedMediaEvents,
} from "../types/generated_media";
import { sharedMediaContracts, sharedMediaEvents } from "../types/shared_media";
import { mediaQueueContracts, mediaQueueEvents } from "../types/media_queue";
import { orionSetupContracts, orionSetupEvents } from "../types/orion_setup";
import { youtubeContracts, youtubeEvents } from "../types/youtube";
import {
  androidEmulatorContracts,
  androidEmulatorEvents,
} from "../types/android_emulator";
import { scheduleContracts, scheduleEvents } from "../types/schedule";

// =============================================================================
// Invoke Channels (derived from all contracts)
// =============================================================================

const CHAT_STREAM_CHANNELS = getStreamChannels(chatStreamContract);
const HELP_STREAM_CHANNELS = getStreamChannels(helpStreamContract);
const DESIGN_CHAT_STREAM_CHANNELS = getStreamChannels(designStudioChatStream);

// Test-only channels (handler only registered in E2E test builds, but channel always allowed)
const TEST_INVOKE_CHANNELS = [
  "test:simulateQuotaTimeElapsed",
  "test:set-node-mock",
] as const;

/**
 * All valid invoke channels derived from contracts.
 * Used by preload.ts to whitelist IPC channels.
 */
export const VALID_INVOKE_CHANNELS = [
  // Core domains
  ...getInvokeChannels(settingsContracts),
  ...getInvokeChannels(appContracts),
  ...getInvokeChannels(chatContracts),
  ...getInvokeChannels(agentContracts),

  // Stream invoke channels
  CHAT_STREAM_CHANNELS.invoke,
  HELP_STREAM_CHANNELS.invoke,
  DESIGN_CHAT_STREAM_CHANNELS.invoke,

  // Integrations
  ...getInvokeChannels(githubContracts),
  ...getInvokeChannels(gitContracts),
  ...getInvokeChannels(mcpContracts),
  ...getInvokeChannels(vercelContracts),
  ...getInvokeChannels(netlifyContracts),
  ...getInvokeChannels(supabaseContracts),
  ...getInvokeChannels(neonContracts),
  ...getInvokeChannels(migrationContracts),

  // Features
  ...getInvokeChannels(systemContracts),
  ...getInvokeChannels(versionContracts),
  ...getInvokeChannels(languageModelContracts),
  ...getInvokeChannels(promptContracts),
  ...getInvokeChannels(templateContracts),
  ...getInvokeChannels(proposalContracts),
  ...getInvokeChannels(importContracts),
  ...getInvokeChannels(helpContracts),
  ...getInvokeChannels(capacitorContracts),
  ...getInvokeChannels(contextContracts),
  ...getInvokeChannels(upgradeContracts),
  ...getInvokeChannels(visualEditingContracts),
  ...getInvokeChannels(securityContracts),
  ...getInvokeChannels(miscContracts),
  ...getInvokeChannels(freeAgentQuotaContracts),
  ...getInvokeChannels(planContracts),
  ...getInvokeChannels(audioContracts),
  ...getInvokeChannels(mediaContracts),
  ...getInvokeChannels(mediaAiContracts),
  ...getInvokeChannels(imageGenerationContracts),
  ...getInvokeChannels(embeddedModelContracts),
  ...getInvokeChannels(modelMarketplaceContracts),
  ...getInvokeChannels(missionContracts),
  ...getInvokeChannels(hardwareContracts),
  ...getInvokeChannels(orchestratorContracts),
  ...getInvokeChannels(flowContracts),
  ...getInvokeChannels(llamaBinaryContracts),
  ...getInvokeChannels(identityContracts),
  ...getInvokeChannels(networkContracts),
  ...getInvokeChannels(computeContracts),
  ...getInvokeChannels(watchdogContracts),
  ...getInvokeChannels(designStudioContracts),
  ...getInvokeChannels(generatedMediaContracts),
  ...getInvokeChannels(sharedMediaContracts),
  ...getInvokeChannels(mediaQueueContracts),
  ...getInvokeChannels(orionSetupContracts),
  ...getInvokeChannels(youtubeContracts),
  ...getInvokeChannels(androidEmulatorContracts),
  ...getInvokeChannels(scheduleContracts),
  ...getInvokeChannels(godotContracts),
  ...getInvokeChannels(blenderContracts),
  ...getInvokeChannels(terminalContracts),
  ...getInvokeChannels(workspaceFilesContracts),
  ...getInvokeChannels(claudeCodeContracts),

  // Test-only channels
  ...TEST_INVOKE_CHANNELS,
] as const;

// =============================================================================
// Receive Channels (derived from all event contracts + stream events)
// =============================================================================

/**
 * All valid receive channels derived from contracts.
 * Used by preload.ts to whitelist IPC channels.
 */
export const VALID_RECEIVE_CHANNELS = [
  // Stream receive channels
  ...CHAT_STREAM_CHANNELS.receive,
  ...HELP_STREAM_CHANNELS.receive,
  ...DESIGN_CHAT_STREAM_CHANNELS.receive,

  // Event channels
  ...getReceiveChannels(agentEvents),
  ...getReceiveChannels(githubEvents),
  ...getReceiveChannels(mcpEvents),
  ...getReceiveChannels(systemEvents),
  ...getReceiveChannels(miscEvents),
  ...getReceiveChannels(planEvents),
  ...getReceiveChannels(modelMarketplaceEvents),
  ...getReceiveChannels(embeddedModelEvents),
  ...getReceiveChannels(llamaBinaryEvents),
  ...getReceiveChannels(networkEvents),
  ...getReceiveChannels(watchdogEvents),
  ...getReceiveChannels(generatedMediaEvents),
  ...getReceiveChannels(sharedMediaEvents),
  ...getReceiveChannels(mediaQueueEvents),
  ...getReceiveChannels(orionSetupEvents),
  ...getReceiveChannels(youtubeEvents),
  ...getReceiveChannels(androidEmulatorEvents),
  ...getReceiveChannels(flowEvents),
  ...getReceiveChannels(godotEvents),
  ...getReceiveChannels(terminalEvents),
  ...getReceiveChannels(claudeCodeEvents),
  ...getReceiveChannels(scheduleEvents),
] as const;

// =============================================================================
// Type Exports
// =============================================================================

export type ValidInvokeChannel = (typeof VALID_INVOKE_CHANNELS)[number];
export type ValidReceiveChannel = (typeof VALID_RECEIVE_CHANNELS)[number];
