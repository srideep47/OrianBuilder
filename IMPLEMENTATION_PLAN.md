# Implementation Plan — bolt.diy Borrowings + Android Pipeline Fix

**Status as of 2026-05-14** — sorted by priority for one-by-one execution.

---

## A. Android Pipeline — Still Broken (Investigate First)

Last session shipped a 3-layer defense (browser_qa_gate placeholder refusal, package_native_artifact QA-gate check, in-file placeholder assertion) + synthetic "read app/index.tsx next" user message + 120s Expo timeout + Android env preflight. User reports the pipeline still does not work end-to-end.

The gates **prevent bad output** (no more placeholder APKs), but they don't **make the agent do the right thing**. The likely remaining failure modes:

### A1. Agent ignores the synthetic directive and skips implementation

The injected user message says "Your VERY NEXT tool call MUST be read_file({path: 'app/index.tsx'})". With a weak local LLM (Qwen3.6-27B-Q4) this is advisory text — the model may decide otherwise.

**Fix candidates:**

- Make `package_native_artifact` refuse if `runState.filesWrittenSinceCreateProject.size === 0` (we track this but never check it).
- After `create_project(expo)`, set a `runState.expoImplementationRequired = true` flag and refuse `browser_qa_gate`/`package_native_artifact` until `app/index.tsx` has been written with non-placeholder content. (Stronger than the current "read file first" advisory.)
- Replace the synthetic user message with a `<orianbuilder-required-next-tool>` server-driven directive that the agent loop enforces: the next tool call MUST be `read_file({path: 'app/index.tsx'})` or the harness rejects it.

### A2. Agent writes content but it's still placeholder-like

The current `PLACEHOLDER_PATTERNS` regex set checks for exact phrases. If the LLM writes "// TODO: replace with real content" the gate passes but the app is empty.

**Fix candidates:**

- Add a "minimum content" check: `app/index.tsx` must contain at least one non-trivial JSX element (≥3 lines of return JSX, or ≥200 chars of content).
- Or check that the file has been written **after** create_project — if it hasn't been written at all since scaffold, refuse.

### A3. browser_qa_gate runs but Expo dev server flakes

Even with PORT injection and 120s timeout, `expo export --platform web` is fragile. Common failures:

- `expo` not installed locally (npm install missed it)
- `serve` not finding the right port
- web-build folder missing or empty

**Fix candidates:**

- Add a `verify_project` style check before `browser_qa_gate` that confirms `web-build/index.html` exists.
- Better error messages from `waitForManagedRuntimeReady` so the agent knows whether to fix dependencies vs. wait longer.

### A4. APK packaging fails on Android env even when env was OK at scaffold time

SDK/NDK may be present but not on the PATH at packaging time, or Gradle may need additional config.

**Fix candidates:**

- Run `checkAndroidEnv()` AGAIN at packaging time, not just at scaffold time.
- Print full Gradle error output to agent so it can self-correct.

**Recommendation:** Tackle A1 (the implementation-gap-detection gate) first — it's surgical and forces the right behavior regardless of model quality.

---

## B. bolt.diy Borrowings — Prioritized

### B1. Stream Recovery (HIGH priority, MODERATE effort)

**Why:** Local LLMs hang. Today, any timeout kills the whole turn. bolt.diy retries 3x with 45s timeout.

**Files to create:**

- `src/pro/main/ipc/handlers/local_agent/streaming/switchable_stream.ts`
- `src/pro/main/ipc/handlers/local_agent/streaming/stream_recovery_manager.ts`

**Files to modify:**

- `src/pro/main/ipc/handlers/local_agent/local_agent_handler.ts` — wrap the LLM stream call

**Effort:** ~300 lines, one-day task.

### B2. Context Optimization (HIGH priority, HIGHER effort)

**Why:** Long sessions overflow local LLM context (8K–32K). bolt.diy generates chat summaries and selects relevant files per turn.

**Approach:**

1. Add a `summary` field to the chat schema (Drizzle migration).
2. Add a `createSummary()` function that calls the same local LLM with a summarization prompt.
3. Add `selectContext()` that prunes the file list per turn based on relevance.
4. Trigger summarization when context length exceeds a threshold (e.g., 75% of model window).

**Files to modify:**

- `src/db/schema.ts` (add `summary` field)
- `src/pro/main/ipc/handlers/local_agent/local_agent_handler.ts`
- New: `src/pro/main/ipc/handlers/local_agent/context/create_summary.ts`
- New: `src/pro/main/ipc/handlers/local_agent/context/select_context.ts`

**Effort:** ~400 lines, two-day task. Needs schema migration.

### B3. File Snapshots Per Chat Turn (HIGH priority, MODERATE effort)

**Why:** No rollback today. If the agent corrupts the project, user has to manually revert via git or starts over.

**Approach:**

1. Take a snapshot of the project file tree on each turn (only changed files relative to previous snapshot).
2. Store snapshots in SQLite with `chatId + turnIndex` key.
3. Add a "Restore to this turn" button in the UI.

**Files to create:**

- `src/db/snapshot_schema.ts` (Drizzle migration for snapshots table)
- `src/pro/main/ipc/handlers/snapshots_handler.ts`

**Effort:** ~250 lines + UI work.

### B4. File Locking (MEDIUM priority, LOW effort)

**Why:** Users can't protect manually-edited files from being overwritten by the agent.

**Approach:**

1. Add a `lockedPaths: string[]` field to chat metadata.
2. UI: lock icon next to each file in the file tree.
3. Agent tools (`write_file`, `search_replace`, `delete_file`) check the lock before writing.

**Files to modify:**

- `src/db/schema.ts`
- `src/pro/main/ipc/handlers/local_agent/tools/write_file.ts`
- `src/pro/main/ipc/handlers/local_agent/tools/search_replace.ts`
- `src/pro/main/ipc/handlers/local_agent/tools/delete_file.ts`
- UI: file tree component

**Effort:** ~150 lines + small UI change.

### B5. BaseProvider Plugin Registry (HIGH priority, HIGH effort)

**Why:** Today Dyad hardcodes the local LLM endpoint. To support cloud fallback (e.g., when local is unavailable) or multi-provider, we need an abstraction.

**Approach:**

1. Adopt Vercel AI SDK (`ai` + `@ai-sdk/*` packages).
2. Create `BaseProvider` abstract class.
3. Implement providers for: local (llama.cpp / LM Studio / Ollama), OpenAI-compatible, Anthropic.
4. Provider selection in settings.

**Files to create:**

- `src/pro/main/llm/base_provider.ts`
- `src/pro/main/llm/providers/local_provider.ts`
- `src/pro/main/llm/providers/openai_compatible_provider.ts`
- `src/pro/main/llm/providers/anthropic_provider.ts`
- `src/pro/main/llm/llm_manager.ts`

**Effort:** ~600 lines + settings UI. Multi-day task.

### B6. Deployment Integration (MEDIUM priority, MODERATE effort)

**Why:** Build apps and ship them without leaving Dyad. Major product gap.

**Approach:**

1. Netlify deploy via API (requires user-provided token in settings).
2. Vercel deploy via API.
3. Agent tool: `deploy_app(target: 'netlify' | 'vercel')`.

**Files to create:**

- `src/ipc/handlers/deploy_netlify_handler.ts`
- `src/ipc/handlers/deploy_vercel_handler.ts`
- `src/pro/main/ipc/handlers/local_agent/tools/deploy_app.ts`

**Effort:** ~400 lines + settings UI for tokens.

### B7. GitHub Integration (MEDIUM priority, MODERATE effort)

**Why:** Make Dyad usable for existing projects, not just greenfield.

**Approach:**

1. `isomorphic-git` for clone/commit/push.
2. GitHub API for repo creation/listing.
3. Agent tools: `git_commit`, `git_push`, `github_create_repo`.

**Files to create:**

- `src/ipc/handlers/github_handler.ts`
- `src/pro/main/ipc/handlers/local_agent/tools/git_commit.ts`
- `src/pro/main/ipc/handlers/local_agent/tools/git_push.ts`

**Effort:** ~500 lines + auth flow for GitHub OAuth.

### B8. Quick-Action Suggestion Pattern (LOW priority, LOW effort)

**Why:** Better post-turn UX — one-click follow-ups instead of typing prompts.

**Approach:**

1. Add a `<orianbuilder-quick-action label="..." prompt="...">` XML tag.
2. Renderer parses and shows buttons after the turn.

**Files to modify:**

- `src/prompts/local_agent_prompt.ts` (document the tag)
- UI: chat message renderer

**Effort:** ~100 lines + UI.

### B9. Progress Annotations in SSE (LOW priority, LOW effort)

**Why:** Rich loading states during multi-step turns. Currently we only stream text.

**Approach:**

1. Define a `ProgressAnnotation` interface.
2. Tools emit annotations via a new `ctx.emitProgress()` method.
3. UI renders annotations as progress bars / step indicators.

**Effort:** ~150 lines.

### B10. ZIP Export Tool (LOW priority, LOW effort)

**Why:** Simple escape hatch — let users download their project.

**Files to create:**

- `src/ipc/handlers/export_zip_handler.ts`

**Effort:** ~50 lines.

---

## Recommended Execution Order

1. **A1** — Android pipeline implementation-gap gate (1-2 hours, unblocks the user's core complaint)
2. **B1** — Stream recovery (most impactful reliability fix)
3. **B3** — File snapshots (best UX win for safety)
4. **B4** — File locking (low effort, real value)
5. **B2** — Context optimization (needed before long sessions become viable)
6. **B5** — BaseProvider registry (architectural foundation for everything cloud-related)
7. **B6** — Deployment (biggest product gap)
8. **B7** — GitHub integration
9. **B8, B9, B10** — Polish

---

_Tackle one at a time. Confirm scope before starting each._
