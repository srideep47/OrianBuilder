/**
 * Every invoke contract in the app, keyed by the domain name the renderer uses.
 *
 * Why this file exists rather than deriving from `src/ipc/types/index.ts`: that
 * module's `ipc` object holds *clients* (closures over `window.electron`), not
 * contracts, so there is nothing there to introspect. This is the contract-side
 * twin of that object, and `contract_sources.test.ts` fails the build if the
 * two ever disagree — so adding a domain to `ipc` without adding it here is
 * caught, rather than silently hiding a whole feature from Marta.
 *
 * Keys match the `ipc` namespace exactly, which means an action id like
 * `app.createApp` is literally the call site `ipc.app.createApp(...)`. That
 * correspondence is worth preserving: it makes generated action ids greppable.
 *
 * Importing these modules in the main process is safe — `createClient` only
 * builds closures at module scope and does not touch `window` until called.
 */

import type { z } from "zod";
import type { IpcContract } from "@/ipc/contracts/core";

import { settingsContracts } from "@/ipc/types/settings";
import { appContracts } from "@/ipc/types/app";
import { chatContracts } from "@/ipc/types/chat";
import { agentContracts } from "@/ipc/types/agent";
import { githubContracts, gitContracts } from "@/ipc/types/github";
import { mcpContracts } from "@/ipc/types/mcp";
import { vercelContracts } from "@/ipc/types/vercel";
import { netlifyContracts } from "@/ipc/types/netlify";
import { supabaseContracts } from "@/ipc/types/supabase";
import { neonContracts } from "@/ipc/types/neon";
import { migrationContracts } from "@/ipc/types/migration";
import { systemContracts } from "@/ipc/types/system";
import { versionContracts } from "@/ipc/types/version";
import { languageModelContracts } from "@/ipc/types/language-model";
import { promptContracts } from "@/ipc/types/prompts";
import { templateContracts } from "@/ipc/types/templates";
import { proposalContracts } from "@/ipc/types/proposals";
import { importContracts } from "@/ipc/types/import";
import { helpContracts } from "@/ipc/types/help";
import { capacitorContracts } from "@/ipc/types/capacitor";
import { contextContracts } from "@/ipc/types/context";
import { upgradeContracts } from "@/ipc/types/upgrade";
import { visualEditingContracts } from "@/ipc/types/visual-editing";
import { securityContracts } from "@/ipc/types/security";
import { miscContracts } from "@/ipc/types/misc";
import { freeAgentQuotaContracts } from "@/ipc/types/free_agent_quota";
import { audioContracts } from "@/ipc/types/audio";
import { mediaContracts } from "@/ipc/types/media";
import { mediaAiContracts } from "@/ipc/types/media_ai";
import { imageGenerationContracts } from "@/ipc/types/image_generation";
import { embeddedModelContracts } from "@/ipc/types/embedded_model";
import { modelMarketplaceContracts } from "@/ipc/types/model_marketplace";
import { missionContracts } from "@/ipc/types/mission";
import { martaContracts } from "@/ipc/types/marta";
import { hardwareContracts } from "@/ipc/types/hardware";
import { telemetryContracts } from "@/ipc/types/telemetry";
import { godotContracts, blenderContracts } from "@/ipc/types/game";
import { claudeCodeContracts } from "@/ipc/types/claude_code";
import {
  terminalContracts,
  workspaceFilesContracts,
} from "@/ipc/types/workspace";
import { orchestratorContracts } from "@/ipc/types/model_orchestrator";
import { flowContracts } from "@/ipc/types/intent";
import { llamaBinaryContracts } from "@/ipc/types/llama_binary";
import { identityContracts } from "@/ipc/types/identity";
import { networkContracts } from "@/ipc/types/network";
import { computeContracts } from "@/ipc/types/compute";
import { watchdogContracts } from "@/ipc/types/watchdog";
import { generatedMediaContracts } from "@/ipc/types/generated_media";
import { sharedMediaContracts } from "@/ipc/types/shared_media";
import { mediaQueueContracts } from "@/ipc/types/media_queue";
import { orionSetupContracts } from "@/ipc/types/orion_setup";
import { youtubeContracts } from "@/ipc/types/youtube";
import { androidEmulatorContracts } from "@/ipc/types/android_emulator";
import { designStudioContracts } from "@/ipc/types/design_studio";
import { scheduleContracts } from "@/ipc/types/schedule";
import { orionAuthContracts } from "@/ipc/types/orion_auth";
import { planContracts } from "@/ipc/types/plan";

/** Any object mapping method names to invoke contracts. */
export type ContractsObject = Record<
  string,
  IpcContract<string, z.ZodType, z.ZodType>
>;

export const CONTRACT_SOURCES = {
  settings: settingsContracts,
  app: appContracts,
  chat: chatContracts,
  agent: agentContracts,
  github: githubContracts,
  git: gitContracts,
  mcp: mcpContracts,
  vercel: vercelContracts,
  netlify: netlifyContracts,
  supabase: supabaseContracts,
  neon: neonContracts,
  migration: migrationContracts,
  system: systemContracts,
  version: versionContracts,
  languageModel: languageModelContracts,
  prompt: promptContracts,
  template: templateContracts,
  proposal: proposalContracts,
  import: importContracts,
  help: helpContracts,
  capacitor: capacitorContracts,
  context: contextContracts,
  upgrade: upgradeContracts,
  visualEditing: visualEditingContracts,
  security: securityContracts,
  misc: miscContracts,
  freeAgentQuota: freeAgentQuotaContracts,
  audio: audioContracts,
  media: mediaContracts,
  mediaAi: mediaAiContracts,
  imageGeneration: imageGenerationContracts,
  embeddedModel: embeddedModelContracts,
  marketplace: modelMarketplaceContracts,
  mission: missionContracts,
  marta: martaContracts,
  hardware: hardwareContracts,
  telemetry: telemetryContracts,
  godot: godotContracts,
  blender: blenderContracts,
  claudeCode: claudeCodeContracts,
  terminal: terminalContracts,
  workspaceFiles: workspaceFilesContracts,
  orchestrator: orchestratorContracts,
  flow: flowContracts,
  llamaBinary: llamaBinaryContracts,
  identity: identityContracts,
  network: networkContracts,
  compute: computeContracts,
  watchdog: watchdogContracts,
  generatedMedia: generatedMediaContracts,
  sharedMedia: sharedMediaContracts,
  mediaQueue: mediaQueueContracts,
  orionSetup: orionSetupContracts,
  youtube: youtubeContracts,
  androidEmulator: androidEmulatorContracts,
  designStudio: designStudioContracts,
  schedule: scheduleContracts,

  // Reachable over IPC but absent from the `ipc` namespace object, so the
  // drift test cannot see them. Listed here so Marta can still be granted
  // them if a registry entry is ever added.
  orionAuth: orionAuthContracts,
  plan: planContracts,
} as const satisfies Record<string, ContractsObject>;

export type MartaDomain = keyof typeof CONTRACT_SOURCES;

/** Every `${domain}.${method}` id the app defines, registered or not. */
export function allContractIds(): string[] {
  const ids: string[] = [];
  for (const [domain, contracts] of Object.entries(CONTRACT_SOURCES)) {
    for (const method of Object.keys(contracts)) {
      ids.push(`${domain}.${method}`);
    }
  }
  return ids.sort();
}

/** Resolve one contract by action id, or null when the id is unknown. */
export function lookupContract(actionId: string): {
  domain: string;
  method: string;
  contract: IpcContract<string, z.ZodType, z.ZodType>;
} | null {
  const split = actionId.indexOf(".");
  if (split <= 0) return null;
  const domain = actionId.slice(0, split);
  const method = actionId.slice(split + 1);
  const contracts = (CONTRACT_SOURCES as Record<string, ContractsObject>)[
    domain
  ];
  const contract = contracts?.[method];
  if (!contract) return null;
  return { domain, method, contract };
}
