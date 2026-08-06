import { z } from "zod";
import {
  createClient,
  createEventClient,
  defineContract,
  defineEvent,
} from "../contracts/core";

/**
 * The Claude Code CLI as an Orion runtime.
 *
 * Events rather than a stream contract: a turn emits several *kinds* of thing
 * (text deltas, thinking, tool calls, tool results, permission requests, usage),
 * and a stream contract's single `chunk` payload would force all of them through
 * one shape and back out again. Every consumer — the Build workspace, the Orion
 * command surface, Design Studio — subscribes to the same typed events.
 */

export const PermissionModeSchema = z.enum([
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
]);
export type ClaudePermissionMode = z.infer<typeof PermissionModeSchema>;

export const ClaudeEffortSchema = z.enum([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export type ClaudeEffort = z.infer<typeof ClaudeEffortSchema>;

export const TurnUsageSchema = z.object({
  costUsd: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheCreationTokens: z.number(),
  numTurns: z.number(),
  durationMs: z.number(),
  /** Context use reported by the CLI for the last completed/resumed turn. */
  contextUsedTokens: z.number(),
  contextWindowTokens: z.number(),
});
export type ClaudeTurnUsage = z.infer<typeof TurnUsageSchema>;

const ClaudeQuotaWindowSchema = z.object({
  usedPercentage: z.number().nullable(),
  resetsAtEpochSeconds: z.number().nullable(),
});

const ClaudeModelQuotaSchema = ClaudeQuotaWindowSchema.extend({
  displayName: z.string(),
});

/** Account quota data from Claude Code's signed-in subscription. No credential crosses IPC. */
export const ClaudeAccountUsageSchema = z.object({
  fiveHour: ClaudeQuotaWindowSchema,
  sevenDay: ClaudeQuotaWindowSchema,
  modelScoped: z.array(ClaudeModelQuotaSchema),
  fetchedAt: z.number(),
});
export type ClaudeAccountUsage = z.infer<typeof ClaudeAccountUsageSchema>;

export const ClaudeAvailabilitySchema = z.object({
  available: z.boolean(),
  version: z.string().optional(),
  executable: z.string().optional(),
  loggedIn: z.boolean().optional(),
  email: z.string().optional(),
  subscriptionType: z.string().optional(),
  error: z.string().optional(),
});
export type ClaudeAvailability = z.infer<typeof ClaudeAvailabilitySchema>;

/** One normalised turn event. Discriminated on `kind`. */
export const ClaudeEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("session"),
    sessionId: z.string(),
    model: z.string().optional(),
  }),
  z.object({ kind: z.literal("text"), delta: z.string() }),
  z.object({ kind: z.literal("thinking"), delta: z.string() }),
  z.object({
    kind: z.literal("tool-start"),
    id: z.string(),
    name: z.string(),
    input: z.record(z.string(), z.unknown()),
  }),
  z.object({
    kind: z.literal("tool-end"),
    id: z.string(),
    ok: z.boolean(),
    output: z.string(),
  }),
  z.object({
    kind: z.literal("permission"),
    id: z.string(),
    name: z.string(),
    input: z.record(z.string(), z.unknown()),
  }),
  z.object({ kind: z.literal("usage"), usage: TurnUsageSchema }),
  z.object({
    kind: z.literal("done"),
    ok: z.boolean(),
    error: z.string().optional(),
  }),
]);
export type ClaudeEvent = z.infer<typeof ClaudeEventSchema>;

export const claudeCodeContracts = {
  detect: defineContract({
    channel: "claude-code:detect",
    input: z.object({ force: z.boolean().optional() }).optional(),
    output: ClaudeAvailabilitySchema,
  }),
  /** Opens the native Claude Code subscription sign-in flow in a terminal. */
  beginLogin: defineContract({
    channel: "claude-code:begin-login",
    input: z.undefined(),
    output: z.object({ ok: z.boolean(), error: z.string().optional() }),
  }),
  /** Refreshes subscription quota windows using Claude Code's local OAuth credential. */
  getAccountUsage: defineContract({
    channel: "claude-code:account-usage",
    input: z.undefined(),
    output: ClaudeAccountUsageSchema,
  }),
  /**
   * Starts a turn. Returns as soon as the turn is accepted; events arrive on
   * `claude-code:event` keyed by `turnId`.
   */
  startTurn: defineContract({
    channel: "claude-code:start-turn",
    input: z.object({
      turnId: z.string(),
      /** App whose directory the CLI runs in. Its own tools act on these files. */
      appId: z.number().optional(),
      /** Explicit directory, when not tied to an app (e.g. a scratch chat). */
      projectDir: z.string().optional(),
      prompt: z.string(),
      model: z.string().optional(),
      effort: ClaudeEffortSchema.optional(),
      permissionMode: PermissionModeSchema.optional(),
      fresh: z.boolean().optional(),
      appendSystemPrompt: z.string().optional(),
    }),
    output: z.object({ ok: z.boolean(), error: z.string().optional() }),
  }),
  cancelTurn: defineContract({
    channel: "claude-code:cancel-turn",
    input: z.object({ turnId: z.string() }),
    output: z.object({ ok: z.boolean() }),
  }),
  /** Forgets the stored session so the next turn starts a new conversation. */
  resetSession: defineContract({
    channel: "claude-code:reset-session",
    input: z.object({
      appId: z.number().optional(),
      projectDir: z.string().optional(),
    }),
    output: z.object({ ok: z.boolean() }),
  }),
  /** Cumulative cost/usage and whether a session will be resumed. */
  sessionInfo: defineContract({
    channel: "claude-code:session-info",
    input: z.object({
      appId: z.number().optional(),
      projectDir: z.string().optional(),
    }),
    output: z.object({
      sessionId: z.string().nullable(),
      usage: TurnUsageSchema.nullable(),
    }),
  }),
  /** Answer a pending permission request. */
  respondToPermission: defineContract({
    channel: "claude-code:respond-to-permission",
    input: z.object({
      turnId: z.string(),
      requestId: z.string(),
      decision: z.enum(["allow-once", "allow-session", "deny"]),
    }),
    output: z.object({ ok: z.boolean() }),
  }),
} as const;

export const claudeCodeClient = createClient(claudeCodeContracts);

export const claudeCodeEvents = {
  event: defineEvent({
    channel: "claude-code:event",
    payload: z.object({ turnId: z.string(), event: ClaudeEventSchema }),
  }),
} as const;

export const claudeCodeEventClient = createEventClient(claudeCodeEvents);
