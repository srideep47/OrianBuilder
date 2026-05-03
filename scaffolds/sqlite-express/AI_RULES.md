# Tech Stack

- You are building a **full-stack** application: **Express** backend + **React** frontend.
- Backend: `server/` — Express 4 + **better-sqlite3** (synchronous SQLite).
- Frontend: `client/` — React 18 + Vite + TanStack Query + React Router DOM + Tailwind CSS.

## Project Structure

```
server/
  index.ts        — Express entry point (API routes)
  db/database.ts  — SQLite connection + WAL mode + schema migrations
  tsconfig.json   — Server-only TypeScript config
client/
  index.html
  src/
    main.tsx      — React root + QueryClientProvider + BrowserRouter
    pages/        — Page components
    hooks/        — TanStack Query hooks (useQuery / useMutation)
    components/   — Shared UI components
    index.css     — Tailwind directives
```

## Backend: better-sqlite3 patterns

**CRITICAL**: `better-sqlite3` is **synchronous** — no `async/await`, no `.then()`.

```ts
// Correct — synchronous
const user = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
const users = db.prepare("SELECT * FROM users").all();
const result = db
  .prepare("INSERT INTO users (name) VALUES (?) RETURNING *")
  .get(name);

// Transactions — use db.transaction() for atomicity
const transfer = db.transaction((from: number, to: number, amount: number) => {
  db.prepare("UPDATE accounts SET balance = balance - ? WHERE id = ?").run(
    amount,
    from,
  );
  db.prepare("UPDATE accounts SET balance = balance + ? WHERE id = ?").run(
    amount,
    to,
  );
});
transfer(1, 2, 100);

// WRONG — do NOT use async with better-sqlite3
const user = await db.prepare("...").get(id); // ❌
```

## Backend: Express route pattern

```ts
app.get("/api/users", (_req, res) => {
  const users = db
    .prepare("SELECT * FROM users ORDER BY created_at DESC")
    .all();
  res.json(users);
});

app.post("/api/users", (req, res) => {
  const { name } = req.body as { name?: string };
  if (!name?.trim()) return res.status(400).json({ error: "name is required" });
  const user = db
    .prepare("INSERT INTO users (name) VALUES (?) RETURNING *")
    .get(name.trim());
  res.status(201).json(user);
});
```

## Database migrations

Add new tables/columns in `server/db/database.ts` inside the `db.exec(...)` block.
Always use `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` for safety.

```ts
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  -- Add columns idempotently:
  -- ALTER TABLE users ADD COLUMN email TEXT;
`);
```

## Frontend: TanStack Query pattern

```ts
// hooks/useUsers.ts
export function useUsers() {
  return useQuery({
    queryKey: ["users"],
    queryFn: () => fetch("/api/users").then((r) => r.json()),
  });
}

export function useCreateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      }).then((r) => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  });
}
```

## Available packages (already installed)

- **Server**: `express`, `better-sqlite3`, `cors`, `tsx`
- **Client**: `react`, `react-dom`, `react-router-dom`, `@tanstack/react-query`, `tailwindcss`

## Rules

- Never use `async/await` with better-sqlite3 — it's synchronous by design.
- Always enable WAL mode and foreign keys (already in `db/database.ts`).
- Never hardcode secrets — use `process.env.SECRET` on the server.
- Keep API routes RESTful: GET for reads, POST for creates, PUT/PATCH for updates, DELETE for deletes.
- The Vite dev server proxies `/api` to `http://localhost:3001` — use relative `/api/...` URLs in the frontend.
