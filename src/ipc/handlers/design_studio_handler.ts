import fs from "node:fs";
import path from "node:path";
import { execSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import log from "electron-log";
import { dialog, app, BrowserWindow } from "electron";
import { eq, desc } from "drizzle-orm";
import { createTypedHandler } from "./base";
import { safeSend } from "../utils/safe_sender";
import {
  designStudioContracts,
  type DesignSkill,
  type DesignSystem,
  type CraftRule,
  type DesignSession,
  type DesignSessionSummary,
} from "../types/design_studio";
import { db } from "@/db";
import { designSessions } from "@/db/schema";

const logger = log.scope("design-studio-handler");

// ── Resource path resolution (dev vs packaged) ───────────────────────────────
function getDesignStudioResourcePath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "design-studio");
  }
  return path.join(__dirname, "..", "..", "resources", "design-studio");
}

const SKILLS_PATH = path.join(getDesignStudioResourcePath(), "skills");
const DESIGN_SYSTEMS_PATH = path.join(
  getDesignStudioResourcePath(),
  "design-systems",
);
const CRAFT_PATH = path.join(getDesignStudioResourcePath(), "craft");

// ── Curated skill list ───────────────────────────────────────────────────────
const CURATED_SKILLS: Array<{
  id: string;
  category: string;
  scenario: string;
}> = [
  { id: "wireframe-sketch", category: "Wireframe", scenario: "design" },
  { id: "frontend-design", category: "Web Design", scenario: "design" },
  { id: "frontend-dev", category: "Web Development", scenario: "engineering" },
  {
    id: "frontend-skill",
    category: "Web Development",
    scenario: "engineering",
  },
  { id: "web-design-guidelines", category: "Web Design", scenario: "design" },
  { id: "web-artifacts-builder", category: "Web Design", scenario: "design" },
  { id: "ui-skills", category: "UI/UX", scenario: "design" },
  { id: "ui-ux-pro-max", category: "UI/UX", scenario: "design" },
  { id: "shadcn-ui", category: "Components", scenario: "engineering" },
  { id: "article-magazine", category: "Content", scenario: "marketing" },
  { id: "poster-hero", category: "Marketing", scenario: "marketing" },
  { id: "login-flow", category: "UI/UX", scenario: "product" },
  { id: "faq-page", category: "Content", scenario: "product" },
  { id: "resume-modern", category: "Documents", scenario: "personal" },
  { id: "data-report", category: "Documents", scenario: "operation" },
  { id: "canvas-design", category: "Design", scenario: "design" },
  { id: "slides", category: "Presentations", scenario: "product" },
  { id: "frontend-slides", category: "Presentations", scenario: "engineering" },
  { id: "brainstorming", category: "Documents", scenario: "product" },
  { id: "copywriting", category: "Content", scenario: "marketing" },
  { id: "platform-design", category: "Web Design", scenario: "design" },
  { id: "design-brief", category: "Design", scenario: "design" },
  { id: "gsap-core", category: "Animation", scenario: "engineering" },
  { id: "threejs", category: "3D/Animation", scenario: "engineering" },
  { id: "d3-visualization", category: "Data Viz", scenario: "engineering" },
  { id: "hand-drawn-diagrams", category: "Design", scenario: "design" },
];

// ── Craft rule metadata ──────────────────────────────────────────────────────
const CRAFT_RULES_META: Record<string, { name: string; description: string }> =
  {
    "accessibility-baseline": {
      name: "Accessibility",
      description: "WCAG 2.2 AA compliance, focus states, ARIA",
    },
    "animation-discipline": {
      name: "Animation",
      description: "Duration thresholds, easing curves, reduced motion",
    },
    "anti-ai-slop": {
      name: "Anti-AI Slop",
      description: "Avoid generic AI defaults, emoji icons, filler copy",
    },
    color: {
      name: "Color",
      description: "Palette structure, contrast ratios, semantic naming",
    },
    "form-validation": {
      name: "Forms",
      description: "Input state machine, error wiring, validation timing",
    },
    "laws-of-ux": {
      name: "Laws of UX",
      description: "Fitts's law, Hick's law, Miller's law, Gestalt",
    },
    "rtl-and-bidi": {
      name: "RTL / Bidi",
      description: "Logical properties, bidi controls, mirroring rules",
    },
    "state-coverage": {
      name: "States",
      description: "Loading, empty, error, populated, edge states",
    },
    typography: {
      name: "Typography",
      description: "Type scale, leading, tracking, line length",
    },
    "typography-hierarchy": {
      name: "Type Hierarchy",
      description: "Dominant entry points, rhythm, vectors",
    },
    "typography-hierarchy-editorial": {
      name: "Editorial Type",
      description: "Magazine typography, dramatic scale, pull quotes",
    },
  };

// ── Helpers ──────────────────────────────────────────────────────────────────
function parseFrontmatter(content: string): {
  name?: string;
  description?: string;
} {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const yaml = match[1];
  const name = yaml.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  let description = "";
  const descBlock = yaml.match(/description:\s*\|?\s*\n([\s\S]*?)(?=\n\S|$)/);
  if (descBlock) {
    description =
      descBlock[1]
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)[0] ?? "";
  } else {
    description = yaml.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? "";
  }
  return { name, description };
}

function rowToSummary(
  row: typeof designSessions.$inferSelect,
): DesignSessionSummary {
  return {
    id: row.id,
    title: row.title,
    skillId: row.skillId,
    designSystemId: row.designSystemId,
    currentArtifact: row.currentArtifact,
    createdAt: row.createdAt ?? new Date(),
    updatedAt: row.updatedAt ?? new Date(),
  };
}

function rowToSession(row: typeof designSessions.$inferSelect): DesignSession {
  return {
    ...rowToSummary(row),
    messages: (row.messagesJson as DesignSession["messages"]) ?? [],
  };
}

// ── Handler registration ─────────────────────────────────────────────────────
// Called lazily inside session handlers — DB is guaranteed initialized by then
function ensureSessionsTable(): void {
  db.$client.exec(`
    CREATE TABLE IF NOT EXISTS design_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      title TEXT NOT NULL,
      skill_id TEXT,
      design_system_id TEXT,
      messages_json TEXT NOT NULL DEFAULT '[]',
      current_artifact TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
}

export function registerDesignStudioHandlers() {
  // ── Skills ──────────────────────────────────────────────────────────────────
  createTypedHandler(designStudioContracts.listSkills, async () => {
    const skills: DesignSkill[] = [];
    for (const { id, category, scenario } of CURATED_SKILLS) {
      const skillMdPath = path.join(SKILLS_PATH, id, "SKILL.md");
      if (!fs.existsSync(skillMdPath)) {
        logger.warn(`SKILL.md not found: ${id}`);
        continue;
      }
      try {
        const content = fs.readFileSync(skillMdPath, "utf-8");
        const { name, description } = parseFrontmatter(content);
        skills.push({
          id,
          name:
            name ??
            id.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
          description: description ?? "",
          category,
          scenario,
          content,
        });
      } catch (err) {
        logger.error(`Failed to read skill ${id}:`, err);
      }
    }
    return skills;
  });

  // ── Design Systems ───────────────────────────────────────────────────────────
  createTypedHandler(designStudioContracts.listDesignSystems, async () => {
    const systems: DesignSystem[] = [];
    if (!fs.existsSync(DESIGN_SYSTEMS_PATH)) return systems;
    const entries = fs.readdirSync(DESIGN_SYSTEMS_PATH, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
      const designMdPath = path.join(
        DESIGN_SYSTEMS_PATH,
        entry.name,
        "DESIGN.md",
      );
      if (!fs.existsSync(designMdPath)) continue;
      try {
        const content = fs.readFileSync(designMdPath, "utf-8");
        systems.push({
          id: entry.name,
          name: entry.name
            .replace(/-/g, " ")
            .replace(/\b\w/g, (c) => c.toUpperCase()),
          content,
        });
      } catch (err) {
        logger.error(`Failed to read design system ${entry.name}:`, err);
      }
    }
    return systems.sort((a, b) => a.name.localeCompare(b.name));
  });

  createTypedHandler(
    designStudioContracts.getDesignSystemTokens,
    async (_, id) => {
      const tokensPath = path.join(DESIGN_SYSTEMS_PATH, id, "tokens.css");
      if (!fs.existsSync(tokensPath)) return null;
      return fs.readFileSync(tokensPath, "utf-8");
    },
  );

  // ── Craft Rules ──────────────────────────────────────────────────────────────
  createTypedHandler(designStudioContracts.listCraftRules, async () => {
    const rules: CraftRule[] = [];
    if (!fs.existsSync(CRAFT_PATH)) return rules;
    const files = fs
      .readdirSync(CRAFT_PATH)
      .filter((f) => f.endsWith(".md") && f !== "README.md");
    for (const file of files) {
      const id = file.replace(".md", "");
      const content = fs.readFileSync(path.join(CRAFT_PATH, file), "utf-8");
      const meta = CRAFT_RULES_META[id];
      rules.push({
        id,
        name:
          meta?.name ??
          id.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
        description: meta?.description ?? "",
        content,
      });
    }
    return rules.sort((a, b) => a.name.localeCompare(b.name));
  });

  // ── Sessions ─────────────────────────────────────────────────────────────────
  createTypedHandler(designStudioContracts.listSessions, async () => {
    ensureSessionsTable();
    const rows = await db
      .select()
      .from(designSessions)
      .orderBy(desc(designSessions.updatedAt));
    return rows.map(rowToSummary);
  });

  createTypedHandler(designStudioContracts.getSession, async (_, id) => {
    ensureSessionsTable();
    const [row] = await db
      .select()
      .from(designSessions)
      .where(eq(designSessions.id, id))
      .limit(1);
    if (!row) throw new Error(`Design session not found: ${id}`);
    return rowToSession(row);
  });

  createTypedHandler(
    designStudioContracts.createSession,
    async (_, { title, skillId, designSystemId }) => {
      ensureSessionsTable();
      const [row] = await db
        .insert(designSessions)
        .values({
          title,
          skillId: skillId ?? null,
          designSystemId: designSystemId ?? null,
          messagesJson: [],
          currentArtifact: null,
        })
        .returning();
      return rowToSession(row);
    },
  );

  createTypedHandler(
    designStudioContracts.updateSession,
    async (
      _,
      { id, title, skillId, designSystemId, messages, currentArtifact },
    ) => {
      ensureSessionsTable();
      const patch: Partial<typeof designSessions.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (title !== undefined) patch.title = title;
      if (skillId !== undefined) patch.skillId = skillId;
      if (designSystemId !== undefined) patch.designSystemId = designSystemId;
      if (messages !== undefined) patch.messagesJson = messages;
      if (currentArtifact !== undefined)
        patch.currentArtifact = currentArtifact;
      await db
        .update(designSessions)
        .set(patch)
        .where(eq(designSessions.id, id));
    },
  );

  createTypedHandler(designStudioContracts.deleteSession, async (_, id) => {
    ensureSessionsTable();
    await db.delete(designSessions).where(eq(designSessions.id, id));
  });

  // ── Export: HTML ──────────────────────────────────────────────────────────────
  createTypedHandler(
    designStudioContracts.exportHtml,
    async (_, { html, filename }) => {
      const { canceled, filePath } = await dialog.showSaveDialog({
        defaultPath: filename ?? "design.html",
        filters: [{ name: "HTML Files", extensions: ["html"] }],
      });
      if (canceled || !filePath) return { success: false };
      fs.writeFileSync(filePath, html, "utf-8");
      return { success: true, filePath };
    },
  );

  // ── Export: PDF ───────────────────────────────────────────────────────────────
  createTypedHandler(
    designStudioContracts.exportPdf,
    async (_, { html, filename }) => {
      const { canceled, filePath } = await dialog.showSaveDialog({
        defaultPath: filename?.replace(/\.html?$/, ".pdf") ?? "design.pdf",
        filters: [{ name: "PDF Files", extensions: ["pdf"] }],
      });
      if (canceled || !filePath) return { success: false };

      // Write HTML to temp file
      const tmpHtml = path.join(
        app.getPath("temp"),
        `od-pdf-${Date.now()}.html`,
      );
      fs.writeFileSync(tmpHtml, html, "utf-8");

      try {
        const win = new BrowserWindow({
          show: false,
          webPreferences: { offscreen: true },
        });
        await win.loadFile(tmpHtml);
        // Allow CSS/fonts to settle
        await new Promise((r) => setTimeout(r, 1200));
        const pdfData = await win.webContents.printToPDF({
          pageSize: "A4",
          printBackground: true,
          margins: { top: 0, bottom: 0, left: 0, right: 0 },
        });
        win.destroy();
        fs.writeFileSync(filePath, pdfData);
        return { success: true, filePath };
      } catch (err) {
        logger.error("PDF export failed:", err);
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      } finally {
        if (fs.existsSync(tmpHtml)) fs.unlinkSync(tmpHtml);
      }
    },
  );

  // ── Export: ZIP ───────────────────────────────────────────────────────────────
  createTypedHandler(
    designStudioContracts.exportZip,
    async (_, { html, filename }) => {
      const { canceled, filePath } = await dialog.showSaveDialog({
        defaultPath: filename?.replace(/\.html?$/, ".zip") ?? "design.zip",
        filters: [{ name: "ZIP Archive", extensions: ["zip"] }],
      });
      if (canceled || !filePath) return { success: false };

      const tmpDir = path.join(app.getPath("temp"), `od-zip-${Date.now()}`);
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.writeFileSync(path.join(tmpDir, "index.html"), html, "utf-8");

      try {
        if (process.platform === "win32") {
          execSync(
            `powershell -Command "Compress-Archive -Path '${tmpDir}\\*' -DestinationPath '${filePath}' -Force"`,
            { timeout: 15000 },
          );
        } else {
          execSync(`cd '${tmpDir}' && zip '${filePath}' index.html`, {
            timeout: 15000,
          });
        }
        return { success: true, filePath };
      } catch (err) {
        logger.error("ZIP export failed:", err);
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
  );

  // ── Claude CLI: Detect ────────────────────────────────────────────────────────
  createTypedHandler(designStudioContracts.detectClaude, async () => {
    try {
      const output = execSync("claude --version", {
        encoding: "utf-8",
        timeout: 5000,
        shell: true,
        // Suppress stderr so a missing binary doesn't pollute logs
        stdio: ["ignore", "pipe", "ignore"],
      } as any).trim();
      return { available: true, version: output };
    } catch {
      return { available: false };
    }
  });

  // ── Claude CLI: Stream Chat ───────────────────────────────────────────────────
  const activeChatStreams = new Map<string, ChildProcess>();

  createTypedHandler(
    designStudioContracts.startDesignChat,
    async (ipcEvent, { sessionId, systemPrompt, messages, model }) => {
      const existing = activeChatStreams.get(sessionId);
      if (existing) {
        existing.kill();
        activeChatStreams.delete(sessionId);
      }

      // Embed system context + conversation history in the message content.
      // We deliberately do NOT use --system-prompt: on Windows the shell
      // would mangle HTML/CSS characters in the prompt value.
      const historyText = messages
        .slice(0, -1)
        .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
        .join("\n\n");
      const lastMsg = messages[messages.length - 1];
      const userContent = lastMsg?.content ?? "";

      const fullContent = [
        systemPrompt,
        historyText ? `\n\nConversation so far:\n${historyText}` : "",
        `\n\nUser: ${userContent}`,
      ].join("");

      // Mirrors open-design's claudeAgentDef.buildArgs exactly:
      //   -p                            → print mode (required)
      //   --input-format stream-json    → reads JSONL from stdin
      //   --output-format stream-json   → JSONL events on stdout
      //   --verbose                     → required with stream-json output
      //   --include-partial-messages    → enables token-by-token streaming
      //                                   (stream_event/content_block_delta)
      //                                   instead of one block at turn end
      //   --permission-mode bypassPermissions → no interactive prompts
      const args = [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--permission-mode",
        "bypassPermissions",
      ];
      if (model) args.push("--model", model);

      const proc = spawn("claude", args, {
        shell: process.platform === "win32",
        env: { ...process.env },
        stdio: ["pipe", "pipe", "pipe"],
      });

      activeChatStreams.set(sessionId, proc);

      // Suppress EPIPE: if claude exits before reading stdin (bad auth,
      // wrong model, etc.) the regular stderr/exit path handles it.
      proc.stdin.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code !== "EPIPE" && err.message !== "write EOF") {
          logger.warn("[claude-cli] stdin error:", err.message);
        }
      });

      // Content must be an array of content blocks (matches open-design)
      const userMessage = JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: fullContent }],
        },
      });
      proc.stdin.write(`${userMessage}\n`, "utf8");
      proc.stdin.end(); // EOF tells claude the conversation is done; it exits after responding

      let stderrBuf = "";

      // Parse stream-json JSONL output — mirrors open-design's claude-stream.ts
      let stdoutBuf = "";
      const textStreamed = new Set<string>();
      let currentMsgId: string | null = null;
      let resultUsage:
        | { costUsd: number; inputTokens: number; outputTokens: number }
        | undefined;

      proc.stdout.on("data", (chunk: Buffer) => {
        stdoutBuf += chunk.toString();
        let nl: number;
        while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
          const line = stdoutBuf.slice(0, nl).trim();
          stdoutBuf = stdoutBuf.slice(nl + 1);
          if (!line) continue;
          let obj: unknown;
          try {
            obj = JSON.parse(line);
          } catch {
            continue;
          }
          if (!obj || typeof obj !== "object") continue;
          const ev = obj as Record<string, unknown>;

          // Primary path: streaming deltas via stream_event wrapper
          if (
            ev.type === "stream_event" &&
            ev.event &&
            typeof ev.event === "object"
          ) {
            const streamEv = ev.event as Record<string, unknown>;
            if (
              streamEv.type === "message_start" &&
              streamEv.message &&
              typeof (streamEv.message as Record<string, unknown>).id ===
                "string"
            ) {
              currentMsgId = (streamEv.message as Record<string, unknown>)
                .id as string;
            }
            if (streamEv.type === "content_block_delta") {
              const delta = streamEv.delta as
                | Record<string, unknown>
                | undefined;
              if (
                delta?.type === "text_delta" &&
                typeof delta.text === "string" &&
                delta.text
              ) {
                if (currentMsgId) textStreamed.add(currentMsgId);
                safeSend(ipcEvent.sender, "design-studio:chat:chunk", {
                  sessionId,
                  delta: delta.text,
                });
              }
            }
          }

          // Capture cost/token usage from the final result event
          if (ev.type === "result") {
            const usage = ev.usage as Record<string, unknown> | undefined;
            resultUsage = {
              costUsd:
                typeof ev.total_cost_usd === "number" ? ev.total_cost_usd : 0,
              inputTokens:
                typeof usage?.input_tokens === "number"
                  ? usage.input_tokens
                  : 0,
              outputTokens:
                typeof usage?.output_tokens === "number"
                  ? usage.output_tokens
                  : 0,
            };
          }

          // Fallback: assistant wrapper (older Claude Code without --include-partial-messages)
          if (
            ev.type === "assistant" &&
            ev.message &&
            typeof ev.message === "object"
          ) {
            const msg = ev.message as Record<string, unknown>;
            const msgId = typeof msg.id === "string" ? msg.id : null;
            if (msgId) currentMsgId = msgId;
            const alreadyStreamed = msgId ? textStreamed.has(msgId) : false;
            if (!alreadyStreamed && Array.isArray(msg.content)) {
              for (const block of msg.content as Record<string, unknown>[]) {
                if (
                  block?.type === "text" &&
                  typeof block.text === "string" &&
                  block.text.length > 0
                ) {
                  safeSend(ipcEvent.sender, "design-studio:chat:chunk", {
                    sessionId,
                    delta: block.text,
                  });
                }
              }
            }
          }
        }
      });

      proc.stderr.on("data", (d: Buffer) => {
        const txt = d.toString();
        stderrBuf += txt;
        logger.warn("[claude-cli] stderr:", txt.trim());
      });

      proc.on("close", (code) => {
        activeChatStreams.delete(sessionId);
        if (code === 0) {
          safeSend(ipcEvent.sender, "design-studio:chat:end", {
            sessionId,
            costUsd: resultUsage?.costUsd,
            inputTokens: resultUsage?.inputTokens,
            outputTokens: resultUsage?.outputTokens,
          });
        } else {
          const detail =
            stderrBuf.trim().slice(0, 400) || `exit code ${code ?? "?"}`;
          safeSend(ipcEvent.sender, "design-studio:chat:error", {
            sessionId,
            error: detail,
          });
        }
      });

      proc.on("error", (err) => {
        activeChatStreams.delete(sessionId);
        safeSend(ipcEvent.sender, "design-studio:chat:error", {
          sessionId,
          error: `Failed to start Claude CLI: ${err.message}`,
        });
      });

      return { ok: true } as const;
    },
  );

  // ── Claude CLI: Cancel ────────────────────────────────────────────────────────
  createTypedHandler(
    designStudioContracts.cancelDesignChat,
    async (_, sessionId) => {
      const proc = activeChatStreams.get(sessionId);
      if (proc) {
        proc.kill();
        activeChatStreams.delete(sessionId);
      }
      return { ok: true } as const;
    },
  );
}
