import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import log from "electron-log";
import { dialog, app, BrowserWindow } from "electron";
import { eq, desc } from "drizzle-orm";
import { createTypedHandler } from "./base";
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
}
