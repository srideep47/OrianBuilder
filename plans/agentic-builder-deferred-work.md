# Agentic Builder Deferred Work Ledger

This file records work deliberately left unfinished, deferred, or planned for a
later pass while rebuilding the automated agentic builder. Use it as the
follow-up checklist after the current phase sequence.

## Phase 0 - Research And Baseline

- Re-check external agent frameworks periodically for ideas worth adopting:
  LangGraph, AutoGen, CrewAI, OpenHands, Cline, AutoGPT, SuperAGI, BabyAGI,
  MetaGPT, and Composio agent orchestrator.
- Keep the framework review as design input only. Avoid copying broad
  architecture unless it fits OrianBuilder's Electron, IPC, local-agent, and app-preview
  model.
- Add a short architecture decision record once the full builder direction is
  stable.

## Phase 1 - Mission Model And Queue

- Add richer mission queue controls beyond the current pause/resume flow:
  priority, retry policy, cancellation reason, and visible run ownership.
- Add recovery for queued/running missions after app restart.
- Add queue-level telemetry and debugging views.
- Add broader tests around queue resumption, multiple chats, and cancelled
  mission cleanup.

## Phase 2 - Managed Runtime And Visual Loop

- Force a visual QA gate before mission completion instead of relying only on
  the agent choosing screenshot/accessibility/console/runtime tools.
- Add multi-viewport capture cadence for desktop, tablet, and mobile.
- Add explicit runtime readiness polling helpers where needed beyond existing
  runtime/dev-server tools.
- Store richer visual artifacts, including thumbnails/previews in the UI.
- Add screenshot diffing or visual regression checks for repeated mission runs.

## Phase 3 - Greenfield Project Factory

- Expand project templates beyond the initial supported stacks.
- Add template health checks that verify install/build/dev commands before
  presenting a template as available.
- Add guided project creation for unknown or custom project types.
- Improve dependency/package-manager detection for mixed or unusual repos.
- Add migration/upgrade paths for projects created by older factory versions.

## Phase 4 - Autonomy Profiles And Safety Guards

- Replace checkpoint visibility with real one-click rollback after defining safe
  file-state or Git restore semantics.
- Add per-mission autonomy override UI at mission creation time, not only a
  default setting.
- Add policy simulation/dry-run UI so users can see what a profile would allow.
- Add stricter command parsing for shell actions instead of regex-only risk
  classification.
- Add Docker/cloud isolation readiness checks before allowing the broadest
  autonomy profile to run high-risk actions without asking.
- Add a richer audit-log UI with filtering by tool, decision, risk, run, and
  profile.

## Phase 5 - Durable Resume And Long-Running Continuity

- Add true automatic resume after restart. Current recovery pauses interrupted
  missions, cancels the interrupted run, records a checkpoint/event, and lets the
  user resume from the Mission Control UI.
- Reconcile active dev servers, previews, and runtime sessions on startup. Current
  recovery handles mission/run database state but does not restart or reattach
  runtime processes.
- Add stronger stuck-run handling. Current implementation records repeated-step
  warnings; it does not automatically pause, split, or escalate the mission.
- Add per-mission budget controls in the UI. Current implementation records the
  active step budget/retry policy and checkpoints when the step budget is hit.
- Add integration tests for full restart recovery and resumed mission streams.
  Current coverage is utility-level plus local-agent regression tests.

## Phase 6 - Parallel Agent Orchestration

- Add true parallel/background execution for worker agents. Current
  implementation runs ready workers through an explicit Mission Control action
  and limits execution to one worker at a time to avoid overlapping chat stream
  state.
- Add coordinator logic that assigns tasks automatically from the mission graph.
  Current implementation can seed worker packages from active tasks, dispatch
  dependency-satisfied workers, run ready workers, and collect reports/diffs.
- Add richer patch handoff UX. Current implementation applies accepted worker
  outputs from worktrees/branches into the primary app checkout, logs applied
  files, cleans up applied worktrees explicitly, and shows a Mission Control
  worker dashboard with reports, changed files, blockers, validation,
  artifacts, captured diff body, file-by-file diff expansion, session events,
  and accept/reject/apply controls. Remaining work is moving this into a
  standalone route if the chat surface becomes too dense.
- Add stronger merge/review gates for worker outputs before applying final
  changes. Current implementation lets Mission Control mark reports
  applied/rejected, detects changed-file conflicts, and applies accepted output
  explicitly.
- Add automatic worker resume after restart. Current implementation recovers
  interrupted running workers by marking them failed with retryable recovery
  metadata and a mission event.
- Add terminal replay from raw worker process output when available. Current
  Mission Control shows compact worker status, worktree branch/path, reports,
  integration status, conflict warnings, and an expandable worker dashboard for
  diffs/artifacts/session events. Remaining work is raw terminal stream capture
  per worker and a standalone dashboard route if needed.

## Phase 6.5 - jcode Runtime Integration Additions

- Shared MCP connection ref-counting and reconnect cooldowns are implemented.
  The shared MCP manager tracks config hashes, active session IDs, ref counts,
  connected/last-used timestamps, forced reloads, guarded disconnects, and
  reconnect cooldowns. `manage_mcp_server` lists connection state.
- Browser interaction protocol persistence is implemented through mission events
  for every `browser_control` action, while screenshots/snapshots still also
  produce visual gate artifacts.
- Expand soft interrupts to every producer. Current implementation stores
  mission interrupts, shows them in Mission Control, injects pending items at
  local-agent step boundaries, marks them injected, and automatically queues
  interrupts for worker reports, stale workers, worker-output conflicts, failed
  visual/runtime gates, and failed verification/test commands.
- Add richer memory retrieval controls. Current implementation stores
  inspectable app-scoped and mission-scoped memory records with IPC and Mission
  Control visibility, then injects a bounded explicit memory message at the
  first safe local-agent step for a mission run.
- Add permission escalation behavior. Current implementation persists
  local-agent permission requests, resolves them after consent decisions, exposes
  IPC, records audit events, shows pending requests in Mission Control, and can
  expire stale pending requests. Shared mission utility helpers are available
  for background jobs outside the local-agent consent path.

## Phase 7 - Tooling Expansion

- Dedicated project-check tooling is implemented. `run_project_check` covers
  package install, lint, typecheck, build, unit test, and e2e test checks with
  detected package-manager/script commands and structured mission verification
  XML.
- Dedicated browser QA bundle is implemented. `browser_qa_gate` starts/reuses the
  managed runtime, waits for readiness, captures desktop and mobile screenshots,
  records an accessibility snapshot, checks recent console errors, and persists
  mission visual/runtime artifacts.
- Dedicated deploy-preview tooling is implemented. `deploy_preview` creates a
  real Vercel deployment for linked Vercel/GitHub apps, records the deployment
  URL as a durable mission artifact, and always requires explicit consent
  because it changes external deployment state. It polls Vercel until READY,
  ERROR, or timeout, records the final state, and captures a compact Vercel
  build-log excerpt. It also supports Netlify CLI and custom deployment commands
  with URL extraction for providers that are not modeled as first-class app
  integrations yet. Mission Control surfaces deployment provider/status/state,
  URL, and log-backed artifact details.
- Image-generation artifact tracking is implemented for the existing
  `generate_image` tool. Generated image XML now becomes a durable mission
  artifact.
- Dedicated media asset tooling is implemented through `generate_media_asset`,
  which can call a configurable local media backend for image/audio/video
  generation, save outputs to `.orianbuilder/media`, and persist durable image, audio,
  and video mission artifacts. The prior `mediaai-backend` gitlink is no longer
  required by the agentic builder path; the backend is treated as an external
  configurable service URL.
- Stronger MCP tool policy integration is implemented so external tools follow
  the same autonomy model as built-in local-agent tools. The built-in tool policy
  consumes the shared capability manifest, unknown MCP tool keys receive a
  sandboxed external-tool capability by default, known MCP tools are mapped by
  server/tool patterns into read-only, workspace, runtime, or external scopes,
  and remote write/unknown MCP tools require explicit consent. User-editable MCP
  trust overrides are implemented in MCP settings and are enforced by the
  local-agent autonomy policy for sanitized server/tool keys.
- Tool capability manifests are implemented for built-in local-agent tools with
  risk, state scope, isolation requirement, and expected artifacts, and
  `list_tool_capabilities` exposes the manifest to the agent at runtime.
  Mission Control now has a compact grouped tool-capability inspector.
- MCP tool settings now show inferred default risk/scope/trust next to the
  editable overrides so users can see what they are changing.

## Phase 8 - Product Hardening

- Add full E2E coverage for mission creation, autonomous execution, visual gates,
  policy prompts, and recovery. Initial contract-level E2E coverage now covers
  mission creation/status, visual gate completion blocking and waiver,
  permission approve/deny, and worker dispatch/report/review flow.
- Add performance budgets for long missions and large repos. Implemented
  guardrails now include mission runtime budget checks, repeated tool-failure
  aborts, repeated step-loop warnings, worker fan-out caps, worker report caps,
  and mission persistence redaction/size caps for events, checkpoints,
  artifacts, interrupts, and permission records.
- Add user-facing documentation for profiles, safety model, runtime isolation,
  and rollback. Initial documentation lives in
  `docs/agentic-builder-hardening.md` and covers autonomy profiles, permission
  prompts, browser QA, MCP trust overrides, deploy previews, media generation,
  privacy, and budget boundaries.
- Add onboarding prompts that explain the difference between supervised,
  trusted-workspace, and full-autopilot-sandbox profiles.
- Review telemetry and privacy boundaries for mission artifacts, screenshots,
  and generated media. Initial privacy boundary is enforced at mission
  persistence via secret redaction and payload-size caps; runtime budgets now
  also prevent repeated failing tools from continuously producing sensitive or
  oversized logs. A broader telemetry audit is still needed before release.
