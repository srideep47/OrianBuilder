# bolt.diy vs Dyad — Comprehensive Architecture Comparison

**Date:** 2026-05-14  
**Analyst:** Claude Opus 4.7  
**bolt.diy path:** `D:\Work\LegionStudios\Reference\bolt.diy`  
**Dyad path:** `D:\Work\LegionStudios\ProjectOrion\Builder\dyad`

---

## Executive Summary

bolt.diy is a browser-first AI IDE that runs a virtual Linux file system inside the browser tab (via StackBlitz WebContainers). Dyad is an Electron-first AI app builder that targets real native outputs (web apps, Expo/React Native APKs). Both use a streaming XML-tagged action protocol but their execution surfaces, LLM integration layers, and state models are architecturally opposite.

| Dimension            | bolt.diy                                 | Dyad                                         |
| -------------------- | ---------------------------------------- | -------------------------------------------- |
| Runtime target       | Browser tab (WebContainer)               | Electron main process (real Node.js)         |
| LLM integration      | Vercel AI SDK, 19+ cloud providers       | Local LLM via llama.cpp / LM Studio / Ollama |
| Tool protocol        | Streaming XML `<boltAction>` tags        | Streaming XML `<orianbuilder-*>` tags        |
| File system          | In-browser virtual (WebContainer)        | Real OS file system (`fs`, `path`)           |
| Persistence          | IndexedDB (client-side)                  | SQLite via Drizzle ORM (Electron main)       |
| Mobile output        | None                                     | Expo APK via Gradle                          |
| Deployment           | Cloudflare Pages/Workers + Docker        | Electron only (self-hosted)                  |
| State management     | nanostores + Zustand                     | Zustand + React Query (IPC layer)            |
| Streaming recovery   | SwitchableStream + StreamRecoveryManager | None currently                               |
| Context optimization | Chat summary + selective file context    | Full context always sent                     |
| Auth                 | Cookie-based API keys                    | None (local-only)                            |

---

## 1. LLM Provider Architecture

### bolt.diy

Uses a **plugin-based provider registry** built on Vercel AI SDK (`ai` package). Every provider extends `BaseProvider` which enforces a `getModelInstance()` contract:

```typescript
// bolt.diy: app/lib/modules/llm/base-provider.ts
abstract class BaseProvider {
  abstract getModelInstance(options: GetModelInstanceOptions): LanguageModelV1;
}
```

19+ providers ship out of the box (OpenAI, Anthropic, Gemini, Groq, Ollama, LM Studio, DeepSeek, xAI, Mistral, Cohere, Together, Perplexity, HuggingFace, OpenRouter, Moonshot, Hyperbolic, GitHub Models, Amazon Bedrock).

**Dynamic model discovery:** Each provider can implement `getDynamicModels()` — bolt.diy fetches live model lists from provider APIs and caches them with a 5-second timeout. This means the model dropdown is always current.

**API key routing:** Keys stored in browser cookies → never leave the client. The backend reads from `req.headers.cookie` to forward to provider APIs. Cloudflare bindings are used for enterprise key injection without exposing them to users.

### Dyad

Currently hardcodes support for OpenAI-compatible local endpoints (LM Studio, Ollama). Provider selection is not abstracted — the LLM call is wired directly into `local_agent_handler.ts`. Adding a new provider requires modifying the handler.

### What's Better in bolt.diy

- **Provider registry pattern** is far more maintainable and extensible. Adding a new LLM is a single file that extends `BaseProvider`.
- **Dynamic model caching** prevents stale model lists without manual updates.
- **Vercel AI SDK** as the unified abstraction means automatic support for new providers as the SDK is updated.
- **Reasoning model detection** — bolt.diy detects `o1`/`o3`/`gpt-5` variants and switches from `maxTokens` to `maxCompletionTokens` automatically, preventing API errors.
- **Token-aware prompting** — each model's context window is respected; messages are sliced to fit.

### What Dyad Does Better / Differently

- Local-first model support is Dyad's core value prop — bolt.diy's local provider support (Ollama/LM Studio) is added as a plugin rather than the primary path.
- Dyad's agent has richer native tool execution (real shell, real file system, Android packaging) vs bolt.diy's virtualized WebContainer.

---

## 2. File System Architecture

### bolt.diy

Uses **StackBlitz WebContainer API** (`@webcontainer/api 1.6.1`) — a virtualized Linux environment running entirely in a browser tab via WASM. There is no real file system access; all files live in memory mapped to a virtual FS.

```typescript
// bolt.diy: app/lib/stores/files.ts
export class FilesStore {
  #webcontainer: Promise<WebContainer>;
  #modifiedFiles: Map<string, string>;
  files: MapStore<FileMap>;
}
```

**File locking:** Users can lock individual files or folders per chat session, preventing the AI from modifying them. This is a first-class UX feature.

**Change tracking:** `pathWatcher` events from WebContainer feed into a buffered change detector using the `diff` library for granular diffs. Binary file detection via `istextorbinary`.

**Limitation:** No native binaries, no pip, no apt-get, no compiled extensions. Python is stdlib-only. Git is not available in WebContainer.

### Dyad

Uses real Node.js `fs` module directly on the OS file system. The agent writes to the actual app directory (`ctx.appPath`). This enables:

- Real shell execution (`executeAppLocalNode`)
- Gradle/Android toolchain (`package_native_artifact`)
- Playwright browser automation (`browser_qa_gate`)
- Real npm/pnpm/bun package installs

### What's Better in bolt.diy

- **File locking per chat session** — Dyad has no equivalent. Users cannot protect specific files from AI modification.
- **`#modifiedFiles` tracking** — bolt.diy tracks exactly what changed since the last message and includes only diffs in subsequent context, saving tokens.
- **`#deletedPaths` Set** — persisted in localStorage to prevent deleted files from reappearing on re-render.
- **Reactive `FileMap` store** — the entire file tree is a reactive atom; any component can subscribe without prop drilling.

### What Dyad Does Better

- Real file system = real toolchain. bolt.diy literally cannot build an APK or run Playwright.
- Dyad's `project_factory.ts` creates deterministic scaffolds from bundled templates — bolt.diy relies on the LLM to write every file from scratch.

---

## 3. Streaming & Tool-Calling Protocol

### bolt.diy

Streaming response is parsed by `StreamingMessageParser` which recognizes XML tags:

```xml
<boltArtifact id="my-app" title="React App">
  <boltAction type="file" filePath="src/App.tsx">
    ... file content ...
  </boltAction>
  <boltAction type="shell">
    npm install
  </boltAction>
  <boltAction type="start">
    npm run dev
  </boltAction>
</boltArtifact>
```

**Action types:** `file`, `shell`, `supabase` (migration/query), `start`, `build`

The `ActionRunner` executes these sequentially with a state machine:

```
pending → running → complete | aborted | failed
```

**Stream recovery:** `SwitchableStream` can switch between multiple readable streams mid-response. `StreamRecoveryManager` monitors for timeout (45s) and retries up to 3 times — meaning a stalled Claude API connection auto-recovers.

**Quick actions:** The LLM can emit `<bolt-quick-action>` elements suggesting follow-up actions rendered as one-click buttons in the UI.

### Dyad

Uses a similar XML streaming approach (`<orianbuilder-*>` tags) but tool execution is handled differently:

- Tools are TypeScript functions registered in `local_agent_handler.ts`
- Each tool has `buildXml()` for streaming preview and `execute()` for actual work
- No stream recovery mechanism — if the local LLM times out, the turn fails
- No quick-action suggestions

### What's Better in bolt.diy

- **Stream recovery (SwitchableStream + StreamRecoveryManager):** Network hiccups or slow cloud APIs are auto-retried. Critical for production use with paid APIs. Dyad has none of this.
- **`<bolt-quick-action>` UX pattern:** The AI can suggest "Deploy to Netlify" or "Run tests" as clickable buttons after completing a task — much better UX than the user having to type follow-up prompts.
- **Shell action with streaming output:** bolt.diy pipes shell output back into the chat in real-time via WebContainer. Users see npm install logs live.
- **Action state machine** with abortable actions — the user can cancel mid-execution.

### What Dyad Does Better

- Dyad's tool protocol has `defaultConsent` and `getConsentPreview()` — users can approve/deny each tool call. bolt.diy auto-executes everything without user consent gates.
- Dyad's `runState` cross-tool coordination (QA gate must pass before APK packaging) is more robust than bolt.diy's sequential-only execution.

---

## 4. Context Management & Token Optimization

### bolt.diy

Has a sophisticated **context optimization system**:

```typescript
// app/lib/.server/llm/select-context.ts
// When contextOptimization=true:
// 1. Separate LLM call generates a chat summary
// 2. AI-driven file selection picks only relevant files
// 3. Messages sliced to last 3 + current turn
```

The system prompt is dynamically sized based on model context window. When a chat grows long, a summary replaces the full history — keeping token usage bounded.

**Code context selection:** Only files relevant to the current question are included (AI-judged via `selectContext()`), not the entire project.

**Data stream annotations:** Progress messages, tool call metadata, and context signals flow through SSE annotations alongside the main token stream.

### Dyad

Currently sends the full context on every turn. No summary generation, no selective file inclusion, no token limit awareness at the prompt level.

### What's Better in bolt.diy

- **Context optimization is essential** for long conversations — without it, every turn costs tokens proportional to total chat history. Dyad will hit local LLM context limits in long sessions.
- **Selective file context** — including only relevant files prevents "needle in a haystack" token waste.
- **Progress annotations** — the client gets structured progress signals (not just text) allowing richer loading UIs.

---

## 5. State Management

### bolt.diy

Uses a **dual-store approach**:

- **nanostores** for atomic, reactive state (files, editor cursor, previews, terminal) — extremely lightweight (1KB)
- **Zustand** for complex state with actions (workbench artifacts, settings, theme)
- **MapStore** specifically for the `FileMap` (key-value reactive map)

This separation means simple state (cursor position) never triggers re-renders in complex components (workbench).

### Dyad

Uses Zustand + React Query. React Query handles the async IPC layer well but doesn't distinguish between reactive atoms and complex state — everything goes through the same store pattern.

### What's Better in bolt.diy

- **nanostores** for file tree state is a good fit — file maps change frequently and nanostores' minimal re-render footprint matters.
- **MapStore** is a natural primitive for a file tree (string → FileEntry) with O(1) lookups.
- Store separation keeps bundle size small and avoids unnecessary component re-renders.

---

## 6. Persistence Layer

### bolt.diy

**IndexedDB** (client-side only) via a custom `db.ts`:

```typescript
// Schema:
// chats: { id, messages, urlId, description, timestamp, metadata }
// snapshots: { chatId, files, summary }
```

Chat history, file snapshots, and summaries are all stored per-chat in IndexedDB. There is no server-side persistence — no user accounts, no cloud sync unless Supabase is configured.

**Supabase integration** (optional): An additional `supabase` action type lets the AI run SQL migrations and queries against a user-provided Supabase project. This is the only backend persistence option.

### Dyad

**SQLite via Drizzle ORM** in the Electron main process. This is a more robust persistence model — ACID transactions, relational queries, schema migrations. The DB persists across app restarts and is queryable without browser context.

### What's Better in bolt.diy

- **Supabase action type** is brilliant — the AI can create tables, run migrations, and seed data as part of a single artifact. The AI becomes a full-stack developer that can both scaffold the UI and set up the database in one conversation turn.
- **Snapshot system** — bolt.diy snapshots the entire file state at each chat index, enabling point-in-time restore. Dyad has no equivalent rollback mechanism.
- **File state tied to chat** — each conversation has its own file snapshot, so switching between chats restores the corresponding file state automatically.

### What Dyad Does Better

- SQLite is more reliable than IndexedDB for complex queries and concurrent access.
- Drizzle schema migrations give Dyad a versioned, testable DB schema.

---

## 7. Deployment & Git Integration

### bolt.diy

Has first-class deployment support:

- **Netlify** deploy via API (`api.netlify-deploy.ts`)
- **Vercel** deploy (`api.vercel-*` routes)
- **GitHub** repo creation + push (`api.github-*`)
- **GitHub/GitLab** clone into WebContainer (`useGit.ts` with `isomorphic-git`)
- **ZIP export** of project files
- Auto-detects `gitUrl`, `gitBranch`, and `netlifySiteId` in chat metadata

```typescript
interface IChatMetadata {
  gitUrl?: string;
  gitBranch?: string;
  netlifySiteId?: string;
}
```

### Dyad

No deployment integration. No git integration. Projects exist as local directories.

### What's Better in bolt.diy

- **One-click Netlify/Vercel deploy** is a core user workflow that Dyad completely lacks.
- **GitHub clone + edit** workflow — users can import existing repos, make AI changes, and push back to GitHub without leaving the app.
- **isomorphic-git in browser** means all git operations run client-side — no server needed.
- **ZIP export** is a simple but essential escape hatch.

---

## 8. Platform Distribution

### bolt.diy

| Target    | Mechanism                                       |
| --------- | ----------------------------------------------- |
| Web       | Cloudflare Pages/Workers (SSR via Remix)        |
| Desktop   | Electron 33.2 with custom HTTP protocol handler |
| Container | Docker multi-stage with health checks           |

**Electron approach:** Intercepts all `http://` requests via `protocol.handle()`. Dev mode proxies to Vite server; prod serves from `build/client` with Remix fallback. Cookies persisted via `electron-store`. Auto-updater via `electron-updater`.

### Dyad

Electron-only. The Electron main process is the primary runtime — all agent tools, LLM calls, file operations happen there. No web deployment path. No Docker.

### What's Better in bolt.diy

- **Web deployment** — users can use bolt.diy from any browser without installing anything.
- **Docker support** — enables self-hosted enterprise deployments.
- **Auto-updater** in Electron — Dyad has no auto-update mechanism currently.
- **Protocol handler pattern** in Electron (intercept `http://`) is cleaner than separate IPC handlers for every operation.

---

## 9. Code Editor Integration

### bolt.diy

**CodeMirror 6** with:

- 10+ language syntax highlighting (JS/TS/JSX/TSX, HTML, CSS, JSON, Markdown, Python, etc.)
- File diff view
- Inline editing from chat
- Keyboard shortcuts

**Preview integration:** Iframe-based preview served directly from WebContainer's dev server. Multiple preview windows supported (`previewsStore`).

### Dyad

Does not embed a code editor in the main app — projects are opened in the OS file system and edited externally (or by agent tools). The preview is a separate Electron window / browser view.

### What's Better in bolt.diy

- **Embedded editor** keeps the user in one window — edit, preview, and chat without switching apps.
- **Side-by-side chat + editor + preview** layout is the core UX of bolt.diy and much more fluid than Dyad's modal approach.
- **Diff view** lets users see exactly what the AI changed before accepting.

---

## 10. System Prompt & AI Guidance

### bolt.diy

The system prompt explicitly documents WebContainer constraints:

- No native binaries / C++ compilation
- Python = stdlib only
- No git
- Prefer Vite for web servers, Supabase for databases
- Node.js is the only runtime
- Sanitized HTML subset allowed in Markdown responses

**Context injection:** Relevant file contents are injected into the system prompt dynamically, not as tool call results.

### Dyad

System prompt (`local_agent_prompt.ts`) describes available tools and expected XML output format. Less environment constraint documentation — the environment is real so fewer restrictions.

**Synthetic user messages** (`ctx.appendUserMessage`) steer the agent mid-conversation without modifying the system prompt — this is a Dyad-specific pattern for cross-tool sequencing that bolt.diy doesn't use.

---

## 11. Quick Reference: Features Only bolt.diy Has

| Feature               | bolt.diy Implementation                                               |
| --------------------- | --------------------------------------------------------------------- |
| Stream recovery       | `SwitchableStream` + `StreamRecoveryManager` (3 retries, 45s timeout) |
| Quick action buttons  | `<bolt-quick-action>` LLM-suggested follow-up actions                 |
| File locking          | Per-chat, per-file/folder locks prevent AI modification               |
| File snapshots        | IndexedDB snapshot per chat index, enables rollback                   |
| Context optimization  | Chat summary + AI-selected file context per turn                      |
| Netlify/Vercel deploy | One-click deploy from chat                                            |
| GitHub clone/push     | `isomorphic-git` in browser                                           |
| ZIP export            | jszip-based project export                                            |
| Supabase action       | AI runs SQL migrations/queries as a tool                              |
| MCP support           | `experimental_createMCPClient` for external tool servers              |
| Dynamic model lists   | Provider API polling with 5s timeout + caching                        |
| 19+ cloud providers   | `BaseProvider` plugin registry                                        |
| CodeMirror editor     | Embedded editor with diff view                                        |
| Embedded preview      | WebContainer dev server in iframe                                     |
| Docker deployment     | Multi-stage Dockerfile                                                |
| Auto-updater          | `electron-updater` in Electron                                        |
| Progress annotations  | Structured SSE annotations for UI loading states                      |

---

## 12. Quick Reference: Features Only Dyad Has

| Feature                 | Dyad Implementation                                      |
| ----------------------- | -------------------------------------------------------- |
| Real APK packaging      | Expo prebuild + Gradle + `package_native_artifact`       |
| Real shell execution    | `executeAppLocalNode` on actual OS                       |
| Playwright browser QA   | `browser_qa_gate` with screenshot + accessibility        |
| Tool consent gates      | `defaultConsent: "ask"` — user approves each tool call   |
| Cross-tool run state    | `AgentRunState` — QA must pass before packaging          |
| Deterministic scaffolds | `project_factory.ts` with bundled templates              |
| Stack detection         | `project_stack_detector.ts` identifies existing projects |
| Local LLM primary       | llama.cpp / LM Studio / Ollama as first-class target     |
| Android env preflight   | SDK/NDK/JBR detection before packaging                   |
| Real ACID DB            | SQLite via Drizzle ORM                                   |
| Port management         | `getAppPort(appId)` per-app dynamic port allocation      |
| Cloud sandbox sync      | `queueCloudSandboxSnapshotSync` for file backup          |

---

## 13. Highest-Priority Borrowings for Dyad

Ranked by impact-to-effort ratio:

### Tier 1 — High Impact, Moderate Effort

**1. Stream Recovery (`SwitchableStream` + `StreamRecoveryManager`)**  
Local LLMs hang and disconnect. Without recovery, the turn fails silently. bolt.diy's 3-retry pattern with 45s timeout would dramatically improve reliability with llama.cpp. ~300 lines to port.

**2. Context Optimization (Chat Summary + Selective File Context)**  
Local LLMs have 4K–32K context windows. Without summarization, long sessions silently corrupt. bolt.diy's `createSummary()` + `selectContext()` pattern should be adapted for local LLMs. ~400 lines.

**3. File Snapshot per Chat Turn**  
Dyad has no rollback. If the agent breaks an app, the user cannot recover the previous state. bolt.diy's IndexedDB snapshot per chat index (or equivalent SQLite snapshots) would be a major UX win. ~200 lines.

**4. File Locking**  
Users cannot protect files they've manually edited from being overwritten. bolt.diy's per-file/folder lock tied to chat ID is a first-class safety feature. ~150 lines.

### Tier 2 — High Impact, Higher Effort

**5. BaseProvider Plugin Registry**  
Dyad currently hardcodes the local LLM endpoint. Adopting the `BaseProvider` pattern with Vercel AI SDK would enable cloud LLM fallback and multi-provider support without architectural rewrites.

**6. One-Click Deployment (Netlify/Vercel)**  
Build apps and deploy them without leaving Dyad. This is a major product gap — bolt.diy deploys in one click. Would require adding deployment API routes.

**7. GitHub Integration (`isomorphic-git`)**  
Import existing repos, commit AI changes, push back. No server needed. This would make Dyad usable for existing projects, not just greenfield.

### Tier 3 — Nice to Have

**8. `<bolt-quick-action>` Pattern**  
Post-completion action suggestions (e.g., "Run tests", "Deploy", "Add a feature") as one-click buttons. Relatively small addition with meaningful UX improvement.

**9. Supabase Action Type**  
For apps that need a backend database, a `supabase` action type that runs migrations would close a major gap vs. bolt.diy.

**10. Progress Annotations in SSE**  
Structured progress signals (not just text) would allow Dyad's UI to show rich loading states during multi-step agent turns.

---

## 14. Where Dyad's Architecture Is Stronger

1. **Real native outputs** — No WebContainer limitation means Dyad can build real mobile apps, run real tests, execute real shell commands. bolt.diy is fundamentally constrained to browser-compatible Node.js.

2. **Tool consent model** — bolt.diy auto-executes all AI actions. Dyad's `defaultConsent: "ask"` pattern gives users agency over dangerous operations.

3. **Cross-tool state coordination** — `AgentRunState` with the QA-gate-before-packaging enforcement is a sophisticated sequencing pattern bolt.diy has no equivalent of.

4. **Deterministic scaffolding** — `project_factory.ts` with bundled templates means project creation is instant, reproducible, and offline-capable. bolt.diy's LLM-written scaffolds vary per run.

5. **Real ACID database** — SQLite + Drizzle is a more reliable persistence foundation than IndexedDB for complex relational data.

6. **Local-first privacy** — Everything runs on the user's machine. No files touch a server. bolt.diy sends file contents to Cloudflare workers on every LLM call.

---

_This document was generated from direct analysis of both codebases. bolt.diy path: `D:\Work\LegionStudios\Reference\bolt.diy`. Dyad path: `D:\Work\LegionStudios\ProjectOrion\Builder\dyad`._
