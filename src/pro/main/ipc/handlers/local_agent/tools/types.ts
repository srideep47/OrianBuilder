/**
 * Shared types and utilities for Local Agent tools
 */

import { z } from "zod";
import { IpcMainInvokeEvent } from "electron";
import { jsonrepair } from "jsonrepair";
import { AgentToolConsent } from "@/lib/schemas";
import { AgentTodo } from "@/ipc/types";
import type { AppFrameworkType } from "@/lib/framework_constants";

// ============================================================================
// XML Escape Helpers
// ============================================================================

export {
  escapeXmlAttr,
  unescapeXmlAttr,
  escapeXmlContent,
  unescapeXmlContent,
} from "../../../../../../../shared/xmlEscape";

// ============================================================================
// Todo Types
// ============================================================================

// Re-export AgentTodo as Todo for backwards compatibility within this module
export type Todo = AgentTodo;

/**
 * Structured progress signal for the UI. `step`/`totalSteps` are optional but
 * encouraged for fixed-length workflows so the renderer can show a real bar
 * rather than a spinner.
 */
export interface ProgressAnnotation {
  /** Stable identifier for this progress stream (e.g., "package_native") so
   *  the UI can group updates together and replace prior labels. */
  id: string;
  /** Short human-readable label, e.g. "Installing dependencies". */
  label: string;
  /** Current step in a multi-step operation. */
  step?: number;
  /** Total number of steps (when known). */
  totalSteps?: number;
  /** Lifecycle status for the current label. */
  status: "in-progress" | "completed" | "failed";
}

/** Tracks which file-editing tools were used on each file path */
export const FILE_EDIT_TOOL_NAMES = ["write_file", "search_replace"] as const;
export type FileEditToolName = (typeof FILE_EDIT_TOOL_NAMES)[number];
export interface FileEditTracker {
  [filePath: string]: {
    write_file: number;
    search_replace: number;
  };
}

/**
 * Mutable per-turn state that tools share with each other.
 * Used to enforce sequencing: e.g. browser_qa_gate must pass before
 * package_native_artifact runs, and create_project resets the gate.
 */
export interface AgentRunState {
  lastBrowserQaStatus: "passed" | "failed" | null;
  lastBrowserQaPlaceholderDetected: boolean;
  /**
   * Files (relative to appPath, forward-slash) written or edited since the
   * most recent create_project call in this turn. Reset by create_project.
   */
  filesWrittenSinceCreateProject: Set<string>;
  /** True once create_project has been called in this turn. */
  createdProjectThisTurn: boolean;
  /**
   * Forward-slash project-relative paths the user has locked for this chat.
   * Folder entries lock everything inside. File-writing tools must refuse to
   * mutate any path matching this list. Snapshotted at turn start.
   */
  lockedPaths: string[];
}

export interface AgentContext {
  event: IpcMainInvokeEvent;
  appId: number;
  /** Absolute filesystem path to the current app directory. */
  appPath: string;
  /** Human-readable display name of the current app (from the DB `apps.name` column). */
  appName?: string;
  /**
   * Apps referenced via `@app:Name` in the current turn. Read-only tools
   * can target these via an `app_name` parameter; write tools cannot reach them.
   * Keyed by lowercased app name so lookups are case-insensitive (matching
   * the mention-extraction pipeline in `mention_apps.ts`). Value is the
   * absolute app path.
   */
  referencedApps: Map<string, string>;
  chatId: number;
  missionId?: number | null;
  missionRunId?: number | null;
  workerId?: number | null;
  supabaseProjectId: string | null;
  supabaseOrganizationSlug: string | null;
  neonProjectId: string | null;
  neonActiveBranchId: string | null;
  frameworkType: AppFrameworkType | null;
  messageId: number;
  isSharedModulesChanged: boolean;
  chatSummary?: string;
  /** Turn-scoped todo list for agent task tracking */
  todos: Todo[];
  /** Request ID for tracking requests to the OrianBuilder engine */
  orianbuilderRequestId: string;
  /** Tracks file edit tool usage per file for telemetry */
  fileEditTracker: FileEditTracker;
  /** Mutable per-turn coordination state shared between tools. */
  runState: AgentRunState;
  installEtargetRecoveryCount?: number;
  /**
   * If true, the user has OrianBuilder Pro enabled.
   * Engine-dependent tools require this to access the OrianBuilder Pro API.
   */
  isOrianBuilderPro: boolean;
  /**
   * Streams accumulated XML to UI without persisting to DB (for live preview).
   * Call this repeatedly with the full accumulated XML so far.
   */
  onXmlStream: (accumulatedXml: string) => void;
  /**
   * Writes final XML to UI and persists to DB.
   * Call this once when the tool's XML output is complete.
   */
  onXmlComplete: (finalXml: string) => void;
  requireConsent: (params: {
    toolName: string;
    toolDescription?: string | null;
    inputPreview?: string | null;
  }) => Promise<boolean>;
  /**
   * Append a user message to be sent after the tool result.
   * Use this when the tool needs to provide non-text content (like images)
   * that models don't support in tool result messages.
   */
  appendUserMessage: (content: UserMessageContentPart[]) => void;
  /**
   * Sends updated todos to the renderer for UI display.
   * Call this when todos are updated to show them in the chat input area.
   */
  onUpdateTodos: (todos: Todo[]) => void;
  /**
   * Queues a warning toast to be shown to the user when the turn completes.
   */
  onWarningMessage?: (message: string) => void;
  /**
   * Emit a structured progress update for the UI to render as a step indicator
   * or progress bar. Pattern borrowed from bolt.diy's ProgressAnnotation.
   * Tools should call this for multi-step operations (e.g., install →
   * typecheck → build → QA) so the user sees granular progress rather than a
   * single opaque "tool running" spinner.
   */
  emitProgress?: (params: ProgressAnnotation) => void;
  onToolExecutionStart?: (params: {
    toolName: string;
    inputPreview?: string | null;
    modifiesState: boolean;
  }) => void;
  onToolExecutionComplete?: (params: {
    toolName: string;
    status: "completed" | "failed";
    durationMs: number;
    outputPreview?: string | null;
    error?: string | null;
    modifiesState: boolean;
  }) => void;
}

// ============================================================================
// Partial JSON Parser
// ============================================================================

/**
 * Parse partial/streaming JSON into a partial object using jsonrepair.
 * Handles incomplete JSON gracefully during streaming.
 */
export function parsePartialJson<T extends Record<string, unknown>>(
  jsonText: string,
): Partial<T> {
  if (!jsonText.trim()) {
    return {} as Partial<T>;
  }

  try {
    const repaired = jsonrepair(jsonText);
    return JSON.parse(repaired) as Partial<T>;
  } catch {
    // If jsonrepair fails, return empty object
    return {} as Partial<T>;
  }
}

// ============================================================================
// Tool Result Types
// ============================================================================

/**
 * Content part types for user messages (supports images)
 * These can be appended as follow-up user messages after tool results
 */
export type UserMessageContentPart =
  | { type: "text"; text: string }
  | { type: "image-url"; url: string };

/**
 * Tool result can be a simple string or a structured result with content parts
 */
export type ToolResult = string;

// ============================================================================
// Tool Definition Interface
// ============================================================================

export interface ToolDefinition<T = any> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<T>;
  readonly defaultConsent: AgentToolConsent;
  /**
   * If true, this tool modifies state (files, database, etc.).
   * Used to filter out state-modifying tools in read-only mode (e.g., ask mode).
   */
  readonly modifiesState?: boolean;
  execute: (args: T, ctx: AgentContext) => Promise<ToolResult>;

  /**
   * If defined, returns whether the tool should be available in the current context.
   * If it returns false, the tool will be filtered out.
   */
  isEnabled?: (ctx: AgentContext) => boolean;

  /**
   * Returns a preview string describing what the tool will do with the given args.
   * Used for consent prompts. If not provided, no inputPreview will be shown.
   *
   * @param args - The parsed args for the tool call
   * @returns A human-readable description of the operation
   */
  getConsentPreview?: (args: T) => string;

  /**
   * Build XML from parsed partial args.
   * Called by the handler during streaming and on completion.
   *
   * @param args - Partial args parsed from accumulated JSON (type inferred from inputSchema)
   * @param isComplete - True if this is the final call (include closing tags)
   * @returns The XML string, or undefined if not enough args yet
   */
  buildXml?: (args: Partial<T>, isComplete: boolean) => string | undefined;
}
