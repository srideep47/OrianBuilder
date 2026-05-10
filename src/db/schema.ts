import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";
import type { ModelMessage } from "ai";
import type { StoredChatMode } from "@/lib/schemas";

export const AI_MESSAGES_SDK_VERSION = "ai@v6" as const;

export type AiMessagesJsonV6 = {
  messages: ModelMessage[];
  sdkVersion: typeof AI_MESSAGES_SDK_VERSION;
};

export const prompts = sqliteTable(
  "prompts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    title: text("title").notNull(),
    description: text("description"),
    content: text("content").notNull(),
    slug: text("slug"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [unique("prompts_slug_unique").on(table.slug)],
);

export const apps = sqliteTable("apps", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  path: text("path").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  githubOrg: text("github_org"),
  githubRepo: text("github_repo"),
  githubBranch: text("github_branch"),
  supabaseProjectId: text("supabase_project_id"),
  // If supabaseProjectId is a branch, then the parent project id set.
  // This is because there's no way to retrieve ALL the branches for ALL projects
  // in a single API call
  // This is only used for display purposes but is NOT used for any actual
  // supabase management logic.
  supabaseParentProjectId: text("supabase_parent_project_id"),
  // Supabase organization slug for credential lookup
  supabaseOrganizationSlug: text("supabase_organization_slug"),
  neonProjectId: text("neon_project_id"),
  neonDevelopmentBranchId: text("neon_development_branch_id"),
  neonPreviewBranchId: text("neon_preview_branch_id"),
  neonActiveBranchId: text("neon_active_branch_id"),
  vercelProjectId: text("vercel_project_id"),
  vercelProjectName: text("vercel_project_name"),
  vercelTeamId: text("vercel_team_id"),
  vercelDeploymentUrl: text("vercel_deployment_url"),
  installCommand: text("install_command"),
  startCommand: text("start_command"),
  chatContext: text("chat_context", { mode: "json" }),
  isFavorite: integer("is_favorite", { mode: "boolean" })
    .notNull()
    .default(sql`0`),
  // Theme ID for design system theming (null means "no theme")
  themeId: text("theme_id"),
});

export const chats = sqliteTable("chats", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  appId: integer("app_id")
    .notNull()
    .references(() => apps.id, { onDelete: "cascade" }),
  title: text("title"),
  initialCommitHash: text("initial_commit_hash"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  // Context compaction fields
  compactedAt: integer("compacted_at", { mode: "timestamp" }),
  compactionBackupPath: text("compaction_backup_path"),
  pendingCompaction: integer("pending_compaction", { mode: "boolean" }),
  chatMode: text("chat_mode").$type<StoredChatMode | null>(),
});

export const messages = sqliteTable("messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  chatId: integer("chat_id")
    .notNull()
    .references(() => chats.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["user", "assistant"] }).notNull(),
  content: text("content").notNull(),
  approvalState: text("approval_state", {
    enum: ["approved", "rejected"],
  }),
  // The commit hash of the codebase at the time the message was created
  sourceCommitHash: text("source_commit_hash"),
  // The commit hash of the codebase at the time the message was sent
  commitHash: text("commit_hash"),
  requestId: text("request_id"),
  // Max tokens used for this message (only for assistant messages)
  maxTokensUsed: integer("max_tokens_used"),
  // Model name used for this message (only for assistant messages)
  model: text("model"),
  // AI SDK messages (v5 envelope) for preserving tool calls/results in agent mode
  aiMessagesJson: text("ai_messages_json", {
    mode: "json",
  }).$type<AiMessagesJsonV6 | null>(),
  // Track if this message used the free agent quota (for non-Pro users)
  usingFreeAgentModeQuota: integer("using_free_agent_mode_quota", {
    mode: "boolean",
  }),
  // Indicates this message is a compaction summary
  isCompactionSummary: integer("is_compaction_summary", { mode: "boolean" }),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const missions = sqliteTable("missions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  appId: integer("app_id")
    .notNull()
    .references(() => apps.id, { onDelete: "cascade" }),
  chatId: integer("chat_id").references(() => chats.id, {
    onDelete: "set null",
  }),
  title: text("title").notNull(),
  goal: text("goal").notNull(),
  status: text("status", {
    enum: ["queued", "running", "paused", "completed", "failed", "cancelled"],
  })
    .notNull()
    .default("queued"),
  autonomyProfile: text("autonomy_profile", {
    enum: ["supervised", "trusted-workspace", "full-autopilot-sandbox"],
  })
    .notNull()
    .default("supervised"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  startedAt: integer("started_at", { mode: "timestamp" }),
  completedAt: integer("completed_at", { mode: "timestamp" }),
});

export const missionEvents = sqliteTable("mission_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  missionId: integer("mission_id")
    .notNull()
    .references(() => missions.id, { onDelete: "cascade" }),
  eventType: text("event_type").notNull(),
  summary: text("summary").notNull(),
  body: text("body"),
  metadata: text("metadata", { mode: "json" }).$type<Record<
    string,
    unknown
  > | null>(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const missionTasks = sqliteTable(
  "mission_tasks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    missionId: integer("mission_id")
      .notNull()
      .references(() => missions.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    title: text("title").notNull(),
    status: text("status", {
      enum: ["pending", "in_progress", "completed"],
    })
      .notNull()
      .default("pending"),
    orderIndex: integer("order_index").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    completedAt: integer("completed_at", { mode: "timestamp" }),
  },
  (table) => [
    unique("mission_tasks_mission_external_unique").on(
      table.missionId,
      table.externalId,
    ),
  ],
);

export const missionRuns = sqliteTable("mission_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  missionId: integer("mission_id")
    .notNull()
    .references(() => missions.id, { onDelete: "cascade" }),
  chatId: integer("chat_id").references(() => chats.id, {
    onDelete: "set null",
  }),
  messageId: integer("message_id").references(() => messages.id, {
    onDelete: "set null",
  }),
  status: text("status", {
    enum: ["running", "completed", "failed", "cancelled"],
  })
    .notNull()
    .default("running"),
  model: text("model"),
  requestId: text("request_id"),
  totalStepsExecuted: integer("total_steps_executed").notNull().default(0),
  error: text("error"),
  metadata: text("metadata", { mode: "json" }).$type<Record<
    string,
    unknown
  > | null>(),
  startedAt: integer("started_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  completedAt: integer("completed_at", { mode: "timestamp" }),
});

export const missionWorkers = sqliteTable("mission_workers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  missionId: integer("mission_id")
    .notNull()
    .references(() => missions.id, { onDelete: "cascade" }),
  runId: integer("run_id").references(() => missionRuns.id, {
    onDelete: "set null",
  }),
  workerKey: text("worker_key").notNull(),
  role: text("role", {
    enum: ["planner", "architect", "builder", "qa", "reviewer", "integrator"],
  }).notNull(),
  status: text("status", {
    enum: [
      "queued",
      "ready",
      "running",
      "blocked",
      "completed",
      "failed",
      "cancelled",
    ],
  })
    .notNull()
    .default("queued"),
  title: text("title").notNull(),
  goal: text("goal").notNull(),
  workspaceProvider: text("workspace_provider", {
    enum: ["local", "worktree", "docker", "cloud"],
  })
    .notNull()
    .default("local"),
  workspaceRef: text("workspace_ref"),
  branchName: text("branch_name"),
  fileScopes: text("file_scopes", { mode: "json" }).$type<string[] | null>(),
  dependsOn: text("depends_on", { mode: "json" }).$type<string[] | null>(),
  metadata: text("metadata", { mode: "json" }).$type<Record<
    string,
    unknown
  > | null>(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  startedAt: integer("started_at", { mode: "timestamp" }),
  completedAt: integer("completed_at", { mode: "timestamp" }),
});

export const missionCheckpoints = sqliteTable("mission_checkpoints", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  missionId: integer("mission_id")
    .notNull()
    .references(() => missions.id, { onDelete: "cascade" }),
  runId: integer("run_id").references(() => missionRuns.id, {
    onDelete: "set null",
  }),
  summary: text("summary").notNull(),
  metadata: text("metadata", { mode: "json" }).$type<Record<
    string,
    unknown
  > | null>(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const missionArtifacts = sqliteTable("mission_artifacts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  missionId: integer("mission_id")
    .notNull()
    .references(() => missions.id, { onDelete: "cascade" }),
  runId: integer("run_id").references(() => missionRuns.id, {
    onDelete: "set null",
  }),
  artifactType: text("artifact_type", {
    enum: [
      "screenshot",
      "image",
      "audio",
      "video",
      "deployment",
      "accessibility_tree",
      "console_output",
      "runtime",
    ],
  }).notNull(),
  title: text("title").notNull(),
  uri: text("uri"),
  body: text("body"),
  mimeType: text("mime_type"),
  metadata: text("metadata", { mode: "json" }).$type<Record<
    string,
    unknown
  > | null>(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const missionInterrupts = sqliteTable("mission_interrupts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  missionId: integer("mission_id")
    .notNull()
    .references(() => missions.id, { onDelete: "cascade" }),
  source: text("source", {
    enum: ["user", "worker", "system", "runtime", "test"],
  })
    .notNull()
    .default("system"),
  title: text("title").notNull(),
  body: text("body").notNull(),
  status: text("status", {
    enum: ["pending", "injected", "cancelled"],
  })
    .notNull()
    .default("pending"),
  metadata: text("metadata", { mode: "json" }).$type<Record<
    string,
    unknown
  > | null>(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  injectedAt: integer("injected_at", { mode: "timestamp" }),
});

export const missionMemories = sqliteTable("mission_memories", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  appId: integer("app_id")
    .notNull()
    .references(() => apps.id, { onDelete: "cascade" }),
  missionId: integer("mission_id").references(() => missions.id, {
    onDelete: "cascade",
  }),
  category: text("category", {
    enum: [
      "decision",
      "command",
      "gotcha",
      "preference",
      "accepted_approach",
      "rejected_approach",
      "recurring_error",
    ],
  }).notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  metadata: text("metadata", { mode: "json" }).$type<Record<
    string,
    unknown
  > | null>(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const missionPermissionRequests = sqliteTable(
  "mission_permission_requests",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    missionId: integer("mission_id")
      .notNull()
      .references(() => missions.id, { onDelete: "cascade" }),
    runId: integer("run_id").references(() => missionRuns.id, {
      onDelete: "set null",
    }),
    action: text("action").notNull(),
    risk: text("risk", { enum: ["low", "medium", "high"] }).notNull(),
    reason: text("reason").notNull(),
    status: text("status", {
      enum: ["pending", "approved", "denied", "expired", "cancelled"],
    })
      .notNull()
      .default("pending"),
    metadata: text("metadata", { mode: "json" }).$type<Record<
      string,
      unknown
    > | null>(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    resolvedAt: integer("resolved_at", { mode: "timestamp" }),
  },
);

export const versions = sqliteTable(
  "versions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    appId: integer("app_id")
      .notNull()
      .references(() => apps.id, { onDelete: "cascade" }),
    commitHash: text("commit_hash").notNull(),
    neonDbTimestamp: text("neon_db_timestamp"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    // Unique constraint to prevent duplicate versions
    unique("versions_app_commit_unique").on(table.appId, table.commitHash),
  ],
);

// Define relations
export const appsRelations = relations(apps, ({ many }) => ({
  chats: many(chats),
  missions: many(missions),
  missionMemories: many(missionMemories),
  versions: many(versions),
}));

export const chatsRelations = relations(chats, ({ many, one }) => ({
  messages: many(messages),
  missions: many(missions),
  app: one(apps, {
    fields: [chats.appId],
    references: [apps.id],
  }),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  chat: one(chats, {
    fields: [messages.chatId],
    references: [chats.id],
  }),
}));

export const missionsRelations = relations(missions, ({ one, many }) => ({
  app: one(apps, {
    fields: [missions.appId],
    references: [apps.id],
  }),
  chat: one(chats, {
    fields: [missions.chatId],
    references: [chats.id],
  }),
  events: many(missionEvents),
  tasks: many(missionTasks),
  runs: many(missionRuns),
  workers: many(missionWorkers),
  checkpoints: many(missionCheckpoints),
  artifacts: many(missionArtifacts),
  interrupts: many(missionInterrupts),
  memories: many(missionMemories),
  permissionRequests: many(missionPermissionRequests),
}));

export const missionEventsRelations = relations(missionEvents, ({ one }) => ({
  mission: one(missions, {
    fields: [missionEvents.missionId],
    references: [missions.id],
  }),
}));

export const missionTasksRelations = relations(missionTasks, ({ one }) => ({
  mission: one(missions, {
    fields: [missionTasks.missionId],
    references: [missions.id],
  }),
}));

export const missionRunsRelations = relations(missionRuns, ({ one, many }) => ({
  mission: one(missions, {
    fields: [missionRuns.missionId],
    references: [missions.id],
  }),
  chat: one(chats, {
    fields: [missionRuns.chatId],
    references: [chats.id],
  }),
  message: one(messages, {
    fields: [missionRuns.messageId],
    references: [messages.id],
  }),
  checkpoints: many(missionCheckpoints),
  workers: many(missionWorkers),
  permissionRequests: many(missionPermissionRequests),
}));

export const missionWorkersRelations = relations(missionWorkers, ({ one }) => ({
  mission: one(missions, {
    fields: [missionWorkers.missionId],
    references: [missions.id],
  }),
  run: one(missionRuns, {
    fields: [missionWorkers.runId],
    references: [missionRuns.id],
  }),
}));

export const missionCheckpointsRelations = relations(
  missionCheckpoints,
  ({ one }) => ({
    mission: one(missions, {
      fields: [missionCheckpoints.missionId],
      references: [missions.id],
    }),
    run: one(missionRuns, {
      fields: [missionCheckpoints.runId],
      references: [missionRuns.id],
    }),
  }),
);

export const missionArtifactsRelations = relations(
  missionArtifacts,
  ({ one }) => ({
    mission: one(missions, {
      fields: [missionArtifacts.missionId],
      references: [missions.id],
    }),
    run: one(missionRuns, {
      fields: [missionArtifacts.runId],
      references: [missionRuns.id],
    }),
  }),
);

export const missionInterruptsRelations = relations(
  missionInterrupts,
  ({ one }) => ({
    mission: one(missions, {
      fields: [missionInterrupts.missionId],
      references: [missions.id],
    }),
  }),
);

export const missionMemoriesRelations = relations(
  missionMemories,
  ({ one }) => ({
    app: one(apps, {
      fields: [missionMemories.appId],
      references: [apps.id],
    }),
    mission: one(missions, {
      fields: [missionMemories.missionId],
      references: [missions.id],
    }),
  }),
);

export const missionPermissionRequestsRelations = relations(
  missionPermissionRequests,
  ({ one }) => ({
    mission: one(missions, {
      fields: [missionPermissionRequests.missionId],
      references: [missions.id],
    }),
    run: one(missionRuns, {
      fields: [missionPermissionRequests.runId],
      references: [missionRuns.id],
    }),
  }),
);

export const language_model_providers = sqliteTable(
  "language_model_providers",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    api_base_url: text("api_base_url").notNull(),
    env_var_name: text("env_var_name"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
);

export const language_models = sqliteTable("language_models", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  displayName: text("display_name").notNull(),
  apiName: text("api_name").notNull(),
  builtinProviderId: text("builtin_provider_id"),
  customProviderId: text("custom_provider_id").references(
    () => language_model_providers.id,
    {
      onDelete: "cascade",
    },
  ),
  description: text("description"),
  max_output_tokens: integer("max_output_tokens"),
  context_window: integer("context_window"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

// Define relations for new tables
export const languageModelProvidersRelations = relations(
  language_model_providers,
  ({ many }) => ({
    languageModels: many(language_models),
  }),
);

export const languageModelsRelations = relations(
  language_models,
  ({ one }) => ({
    provider: one(language_model_providers, {
      fields: [language_models.customProviderId],
      references: [language_model_providers.id],
    }),
  }),
);

export const versionsRelations = relations(versions, ({ one }) => ({
  app: one(apps, {
    fields: [versions.appId],
    references: [apps.id],
  }),
}));

// --- MCP (Model Context Protocol) tables ---
export const mcpServers = sqliteTable("mcp_servers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  transport: text("transport").notNull(),
  command: text("command"),
  // Store typed JSON for args and environment variables
  args: text("args", { mode: "json" }).$type<string[] | null>(),
  envJson: text("env_json", { mode: "json" }).$type<Record<
    string,
    string
  > | null>(),
  headersJson: text("headers_json", { mode: "json" }).$type<Record<
    string,
    string
  > | null>(),
  url: text("url"),
  enabled: integer("enabled", { mode: "boolean" })
    .notNull()
    .default(sql`0`),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const mcpToolConsents = sqliteTable(
  "mcp_tool_consents",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    serverId: integer("server_id")
      .notNull()
      .references(() => mcpServers.id, { onDelete: "cascade" }),
    toolName: text("tool_name").notNull(),
    consent: text("consent").notNull().default("ask"), // ask | always | denied
    riskOverride: text("risk_override"), // low | medium | high | critical
    stateScopeOverride: text("state_scope_override"), // read_only | workspace | runtime | external | host
    requiresExplicitConsentOverride: integer(
      "requires_explicit_consent_override",
      { mode: "boolean" },
    ),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [unique("uniq_mcp_consent").on(table.serverId, table.toolName)],
);

// --- Custom Themes table ---
export const customThemes = sqliteTable("custom_themes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  description: text("description"),
  prompt: text("prompt").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});
