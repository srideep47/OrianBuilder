# Agentic Builder Deferred Work Ledger

This file records work deliberately left unfinished, deferred, or planned for a
later pass while rebuilding the automated agentic builder. Use it as the
follow-up checklist after the current phase sequence.

## Phase 0 - Research And Baseline

- Re-check external agent frameworks periodically for ideas worth adopting:
  LangGraph, AutoGen, CrewAI, OpenHands, Cline, AutoGPT, SuperAGI, BabyAGI,
  MetaGPT, and Composio agent orchestrator.
- Keep the framework review as design input only. Avoid copying broad
  architecture unless it fits Dyad's Electron, IPC, local-agent, and app-preview
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

- Add actual execution for worker agents in isolated worktrees/cloud sandboxes.
  Current implementation persists worker records, roles, scope metadata, status,
  and Mission Control visibility.
- Add coordinator logic that assigns tasks automatically from the mission graph.
  Current implementation can seed worker packages from active tasks, but does not
  dispatch model runs for each worker.
- Add patch handoff and integrator flows for worker outputs.
- Add merge/review gates for worker outputs before applying final changes.
- Expand conflict detection from planned file scopes to actual changed files.
  Current implementation detects overlapping declared scopes before execution.
- Add a full worker dashboard with terminal sessions, diffs, and per-worker
  artifacts. Current Mission Control shows compact worker status and conflict
  warnings.

## Phase 7 - Tooling Expansion

- Add dedicated tools for package install, lint, typecheck, build, e2e, unit
  test, browser QA, asset generation, and deploy preview flows where direct
  shell usage is too opaque.
- Add media-generation tools and artifact tracking for image, video, and audio
  pipelines after reviewing the incoming implementation.
- Fix the pulled Media AI backend source linkage. The current `mediaai-backend`
  entry is a gitlink without a `.gitmodules` URL, so fresh clones cannot fetch
  the Python backend and the app can only skip backend auto-start.
- Add stronger MCP tool policy integration so external tools follow the same
  autonomy and audit model as built-in local-agent tools.
- Add tool capability manifests with risk, state scope, isolation requirement,
  and expected artifacts.

## Phase 8 - Product Hardening

- Add full E2E coverage for mission creation, autonomous execution, visual gates,
  policy prompts, and recovery.
- Add performance budgets for long missions and large repos.
- Add user-facing documentation for profiles, safety model, runtime isolation,
  and rollback.
- Add onboarding prompts that explain the difference between supervised,
  trusted-workspace, and full-autopilot-sandbox profiles.
- Review telemetry and privacy boundaries for mission artifacts, screenshots,
  and generated media.
