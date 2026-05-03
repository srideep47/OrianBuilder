import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { db } from "./db/database.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT ?? 3001;

app.use(cors({ origin: "http://localhost:5173" }));
app.use(express.json());

// Serve built client in production
app.use(express.static(path.join(__dirname, "../../dist/client")));

// ── Example API route ─────────────────────────────────────────────────────────
app.get("/api/items", (_req, res) => {
  const items = db
    .prepare("SELECT * FROM items ORDER BY created_at DESC")
    .all();
  res.json(items);
});

app.post("/api/items", (req, res) => {
  const { name } = req.body as { name?: string };
  if (!name?.trim()) {
    return res.status(400).json({ error: "name is required" });
  }
  const result = db
    .prepare("INSERT INTO items (name) VALUES (?) RETURNING *")
    .get(name.trim());
  res.status(201).json(result);
});

app.delete("/api/items/:id", (req, res) => {
  const { id } = req.params;
  db.prepare("DELETE FROM items WHERE id = ?").run(id);
  res.json({ ok: true });
});

// SPA fallback in production
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "../../dist/client/index.html"));
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
