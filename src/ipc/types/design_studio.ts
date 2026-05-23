import { z } from "zod";
import { defineContract, createClient } from "../contracts/core";

// =============================================================================
// Schemas
// =============================================================================

export const DesignSkillSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  category: z.string(),
  scenario: z.string(),
  content: z.string(),
});
export type DesignSkill = z.infer<typeof DesignSkillSchema>;

export const DesignSystemSchema = z.object({
  id: z.string(),
  name: z.string(),
  content: z.string(),
});
export type DesignSystem = z.infer<typeof DesignSystemSchema>;

export const CraftRuleSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  content: z.string(),
});
export type CraftRule = z.infer<typeof CraftRuleSchema>;

export const DesignChatMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  artifactHtml: z.string().optional(),
});
export type DesignChatMessage = z.infer<typeof DesignChatMessageSchema>;

export const DesignSessionSummarySchema = z.object({
  id: z.number(),
  title: z.string(),
  skillId: z.string().nullable(),
  designSystemId: z.string().nullable(),
  currentArtifact: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type DesignSessionSummary = z.infer<typeof DesignSessionSummarySchema>;

export const DesignSessionSchema = DesignSessionSummarySchema.extend({
  messages: z.array(DesignChatMessageSchema),
});
export type DesignSession = z.infer<typeof DesignSessionSchema>;

const UpdateSessionParamsSchema = z.object({
  id: z.number(),
  title: z.string().optional(),
  skillId: z.string().nullable().optional(),
  designSystemId: z.string().nullable().optional(),
  messages: z.array(DesignChatMessageSchema).optional(),
  currentArtifact: z.string().nullable().optional(),
});

export const ExportResultSchema = z.object({
  success: z.boolean(),
  filePath: z.string().optional(),
  error: z.string().optional(),
});

// =============================================================================
// Contracts
// =============================================================================

export const designStudioContracts = {
  // ── Skills & Design Systems ────────────────────────────────────────────────
  listSkills: defineContract({
    channel: "design-studio:list-skills",
    input: z.void(),
    output: z.array(DesignSkillSchema),
  }),

  listDesignSystems: defineContract({
    channel: "design-studio:list-design-systems",
    input: z.void(),
    output: z.array(DesignSystemSchema),
  }),

  getDesignSystemTokens: defineContract({
    channel: "design-studio:get-design-system-tokens",
    input: z.string(),
    output: z.string().nullable(),
  }),

  // ── Craft Rules ────────────────────────────────────────────────────────────
  listCraftRules: defineContract({
    channel: "design-studio:list-craft-rules",
    input: z.void(),
    output: z.array(CraftRuleSchema),
  }),

  // ── Sessions ───────────────────────────────────────────────────────────────
  listSessions: defineContract({
    channel: "design-studio:list-sessions",
    input: z.void(),
    output: z.array(DesignSessionSummarySchema),
  }),

  getSession: defineContract({
    channel: "design-studio:get-session",
    input: z.number(),
    output: DesignSessionSchema,
  }),

  createSession: defineContract({
    channel: "design-studio:create-session",
    input: z.object({
      title: z.string(),
      skillId: z.string().nullable().optional(),
      designSystemId: z.string().nullable().optional(),
    }),
    output: DesignSessionSchema,
  }),

  updateSession: defineContract({
    channel: "design-studio:update-session",
    input: UpdateSessionParamsSchema,
    output: z.void(),
  }),

  deleteSession: defineContract({
    channel: "design-studio:delete-session",
    input: z.number(),
    output: z.void(),
  }),

  // ── Export ─────────────────────────────────────────────────────────────────
  exportHtml: defineContract({
    channel: "design-studio:export-html",
    input: z.object({ html: z.string(), filename: z.string().optional() }),
    output: ExportResultSchema,
  }),

  exportPdf: defineContract({
    channel: "design-studio:export-pdf",
    input: z.object({ html: z.string(), filename: z.string().optional() }),
    output: ExportResultSchema,
  }),

  exportZip: defineContract({
    channel: "design-studio:export-zip",
    input: z.object({ html: z.string(), filename: z.string().optional() }),
    output: ExportResultSchema,
  }),
} as const;

export const designStudioClient = createClient(designStudioContracts);
