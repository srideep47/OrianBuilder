# Fully Automated Agentic Builder Plan

> Drafted on 2026-05-04 after reviewing the current Orian Builder agent architecture, local-agent tools, sandbox plans, and comparable agent systems.

## Aim

Turn Orian Builder into a durable autonomous developer that can take a product goal, discover or create the right project shape, implement the app, run it, visually inspect it, fix issues, verify quality, and keep working across long-running sessions with clear supervision points.

The target is not a hidden black box. The target is a high-autonomy developer cockpit: the agent can run with broad authority when the user chooses it, but every action is logged, resumable, reviewable, and recoverable.

## Current Baseline

The current codebase already has the right foundation:

- Native tool-calling local-agent loop in `src/pro/main/ipc/handlers/local_agent/local_agent_handler.ts`.
- Parallel tool execution per model step through the AI SDK.
- Tool registry in `src/pro/main/ipc/handlers/local_agent/tool_definitions.ts`.
- Read/write/search/edit/file operation tools, terminal execution, type checks, screenshot capture, accessibility tree capture, web search/fetch/crawl, image generation, Supabase/Neon tools, MCP tools, persisted todos, context compaction, step limits, and commit/version integration.
- Existing autonomous-mode UI in `src/components/AutonomousModeSwitch.tsx`.
- Thinking-budget support in `src/ipc/utils/thinking_utils.ts`.
- Cloud sandbox planning and a desktop provider implementation in `src/ipc/utils/cloud_sandbox_provider.ts`.

This means the next leap should be orchestration, durability, verification, and product intelligence, not just adding more individual tools.

## Lessons From External Agent Systems

- Agent Orchestrator: isolate parallel agents in branches/worktrees, route CI/review feedback back to the right worker, and supervise from a dashboard.
- OpenHands: use explicit sandbox providers. Docker should be the default high-autonomy environment; process/host mode is powerful but unsafe.
- LangGraph: durable execution matters. Every long-running workflow needs checkpoints, resumable state, human-in-the-loop interrupts, and state history.
- CrewAI and AutoGen: multi-agent role patterns are useful, but only when grounded in a controller that owns state, dependencies, and stop conditions.
- MetaGPT: product, architecture, engineering, and QA roles help large greenfield builds, especially when turning one vague request into requirements, design, tasks, APIs, and code.
- AutoGPT and BabyAGI: continuous task queues are powerful but drift without budgets, stop criteria, memory hygiene, and prioritization.
- Cline: developer trust comes from visible tool use, permission controls, terminal/browser integration, and clear progress feedback.
- SuperAGI: useful operating features include concurrent agents, toolkits, GUI supervision, memory, telemetry, and stuck-loop notification.

## Product Principles

1. Backend-flexible: keep model/provider, sandbox provider, SCM provider, and tool provider behind interfaces.
2. Productionizable: generated projects must be standard repos that can survive outside Orian Builder.
3. Transparent over magical: show plans, actions, diffs, terminal output, screenshots, and verification results.
4. Bridge, do not replace: integrate with GitHub, local git, MCP, cloud sandboxes, local tools, and external CLIs.
5. Autonomy with recoverability: high authority is acceptable only with checkpoints, rollback, logs, and bounded execution.

## End-State User Experience

### Autonomous Mission Mode

A new mode above single-turn local-agent:

- User states a goal: "Build a mobile-first CRM with auth, Postgres, analytics, deploy preview."
- Agent creates a mission: product brief, acceptance criteria, architecture, milestones, risks, tool permissions, budget, and verification plan.
- User chooses an autonomy profile:
  - Supervised: ask before writes, commands, installs, deploys.
  - Trusted workspace: auto-approve normal repo-scoped actions; ask for dangerous actions.
  - Full autopilot sandbox: full authority inside a Docker/cloud sandbox; ask only for external secrets, billing, destructive database actions, or host-level actions.
  - Host power mode: broad host access for trusted users, with persistent warning, audit log, and dangerous action guards.
- Agent works until done, blocked, over budget, or explicitly paused.
- UI shows a mission dashboard: active agents, tasks, files changed, commands, preview, screenshots, problems, test status, and next decision.

### Greenfield Builder

The agent should not depend on fixed templates. It should:

- Classify the project type from the goal.
- Pick a stack based on user constraints, target platform, and production needs.
- Create a repo from a scaffold, package manager command, framework CLI, or from scratch.
- Generate project-specific `AI_RULES.md`.
- Install dependencies, run initial checks, start preview, and iterate.
- Support unknown project types by researching current framework docs, creating a minimal working seed, and verifying with build/tests.

### Visual/UX Autopilot

For UI tasks, the agent should:

- Start or reuse the app runtime.
- Capture screenshots at desktop/tablet/mobile.
- Capture accessibility trees and console logs.
- Detect blank screens, overflow, overlap, unreadable contrast, broken routes, and missing first-viewport product signals.
- Run a visual critique pass before claiming completion.
- Make targeted UI fixes and re-screenshot until acceptance criteria pass.

### Parallel Agent Swarm

Parallelism should be explicit and isolated:

- Orchestrator agent owns mission state.
- Planner/product agent writes acceptance criteria and milestone breakdown.
- Architect agent designs repo/stack/data model.
- Builder workers implement disjoint work packages in separate git worktrees or cloud sandboxes.
- QA agent runs checks, reproduces failures, screenshots UI, and files findings.
- Reviewer/security agent inspects diffs for regressions, dangerous code, leaked secrets, and dependency risks.
- Integrator agent merges successful worker patches back into the main app workspace.

Workers should never write into the same checkout at the same time. Use branches/worktrees or cloud sandbox snapshots.

## Architecture

### 1. Mission Orchestrator

Add a durable mission layer above `handleLocalAgentStream`.

Responsibilities:

- Convert user goals into mission records.
- Maintain task graph, dependencies, priorities, budgets, and acceptance criteria.
- Spawn/resume agent runs.
- Persist step checkpoints.
- Decide when to ask the user, continue, retry, split work, or stop.
- Aggregate agent outputs into one final result.

Suggested storage:

- `missions`
- `mission_tasks`
- `mission_runs`
- `mission_events`
- `mission_artifacts`
- `mission_checkpoints`

### 2. Durable Execution

Every mission step should persist:

- input messages
- selected model/provider
- tools available
- tool call args and outputs
- files changed
- commands run
- screenshots/logs
- token/cost/latency
- checkpoint summary
- failure/retry metadata

This enables pause/resume, crash recovery, time travel debugging, and "why did it do that?" explanations.

### 3. Workspace Isolation

Add a `WorkspaceProvider` interface:

- local checkout
- git worktree
- Docker sandbox
- cloud sandbox
- future remote provider

High-autonomy work should default to Docker/cloud. Host mode should be an explicit power setting.

### 4. Agent Runtime Profiles

Define capability bundles instead of global "all permissions":

- `read`: inspect files, repo map, grep, logs, screenshots, web.
- `write`: file writes, search replace, AST edits, dependency changes.
- `execute`: terminal commands, test/build scripts.
- `external`: web fetch/search/crawl, MCP tools, GitHub, deployment APIs.
- `dangerous`: destructive SQL, host-level shell, secrets, publishing, deletes outside generated repo.

Each mission profile maps capabilities to ask/always/never plus hard guards.

### 5. Tool Expansion

Keep existing tools and add the missing developer-grade ones:

- `create_project`: initialize a project from CLI/scaffold/manual seed.
- `detect_project_stack`: inspect package/framework/build/runtime.
- `start_dev_server`: managed long-running process with readiness detection.
- `stop_dev_server` / `restart_dev_server`.
- `run_test_command`: structured test execution with parsed failures.
- `run_lint_command`, `run_build_command`, `run_typecheck_command`.
- `read_terminal_session`: get current process output by session id.
- `browser_navigate`, `browser_click`, `browser_type`, `browser_eval`, `browser_screenshot`.
- `visual_inspect`: screenshot plus heuristics and optional model critique.
- `git_create_worktree`, `git_apply_patch_from_worker`, `git_diff_summary`.
- `secret_request`: ask user for required API keys without exposing them to logs.
- `deploy_preview`: Vercel/cloud preview behind provider interface.
- `create_pr`: provider-backed PR creation for completed missions.

### 6. Model Strategy

Use model roles rather than one model for everything:

- planner/reviewer: strongest reasoning model, high thinking.
- builder: strong coding model, medium/high thinking.
- search/summarizer: cheaper fast model.
- visual critique: multimodal model.
- local/offline fallback: local tool-capable model with smaller mission scope.

OpenAI reasoning models should keep Responses API support and orphaned reasoning cleanup. Thinking controls should be per mission role, not only a global setting.

### 7. Memory and Knowledge

Add scoped memory:

- per app: stack, commands, gotchas, AI_RULES, user preferences.
- per mission: decisions, rejected approaches, unresolved risks.
- global: reusable patterns, but never secrets.

Use memory for retrieval and planning, not as a free-form hidden prompt dump. Every memory item should be inspectable and deletable.

### 8. Verification Pipeline

A mission is not done until verification passes or failures are explicitly reported.

Default checks:

- package install status
- type check
- lint/format
- unit tests relevant to changed files
- build
- app starts successfully
- screenshot nonblank
- console free of fatal errors
- accessibility tree exists
- responsive screenshots for UI work

For database/backend work:

- migrations generated
- migration apply tested locally or in sandbox
- schema introspection confirms expected tables/columns
- rollback or recovery note exists

### 9. Safety and Authority

Full authority should mean "does not need repeated prompts for normal development actions within the chosen workspace." It should not mean silent destructive access to the whole machine.

Required safeguards:

- hard path boundary by workspace provider
- deny access to `.env`, keys, SSH configs, tokens unless explicitly requested through `secret_request`
- dangerous action guards for SQL, dependency install, suspicious code, destructive file ops
- command allow/deny policy with shell parsing, not regex-only
- audit log for every action
- one-click pause/kill mission
- rollback to last checkpoint/version
- budget and time limits
- stuck-loop detection

### 10. UI

Add an Agent Mission page/panel:

- mission goal and status
- task graph/kanban
- active worker list
- live tool timeline
- current preview and latest screenshots
- changed files and diffs
- terminal sessions
- verification status
- permissions profile
- pause/resume/stop controls
- "merge/apply worker result" controls

Keep chat as the command surface, but mission state should be visual and inspectable.

## Implementation Plan

### Phase 0: Stabilize Current Agent

- Run current local-agent unit/E2E suite and snapshot where behavior is known-good.
- Document current tool defaults, consent defaults, and autonomous-mode behavior.
- Fix mismatches between UI copy and actual behavior. `AutonomousModeSwitch` mentions auto-grant/auto-continue/auto-restart, but the settings schema shown in this review does not define `autonomousMode`.
- Add tests that assert autonomous-mode behavior before expanding it.

### Phase 1: Mission Data Model and Dashboard Skeleton

- Add mission/task/run/event schemas and IPC contracts.
- Add mission creation from a chat prompt.
- Add mission event timeline fed by existing local-agent tool calls.
- Add pause/resume/cancel state.
- No sub-agents yet. First goal is durable single-agent missions.

### Phase 2: Managed Runtime and Visual Loop

- Add first-class dev-server session tools.
- Add browser automation tools for local/cloud preview.
- Add screenshot and accessibility quality gates.
- Add visual QA step to UI-related missions.
- Persist screenshots as mission artifacts.

### Phase 3: Greenfield Project Factory

- Add `create_project` and `detect_project_stack`.
- Support CLI-generated projects, existing scaffolds, and blank custom projects.
- Add stack decision prompt and generated `AI_RULES.md`.
- Verify initial project with install/build/start before feature work.

### Phase 4: Autonomy Profiles and Safety Guards

- Add explicit autonomy profiles to settings and mission creation.
- Implement scoped capability policy.
- Add dangerous action detection before consent.
- Add host power mode only after Docker/cloud isolation is solid.
- Add audit log UI and rollback affordances.

### Phase 5: Durable Long-Running Execution

- Persist checkpoints after every model step and tool execution.
- Resume missions after app restart.
- Add retry/backoff policies.
- Add stuck-loop detection and escalation.
- Add budget/time/step controls per mission.

### Phase 6: Parallel Worker Orchestration

- Add worktree/cloud-sandbox workspace provider for workers.
- Add worker run records and status UI.
- Split task graph into disjoint work packages.
- Run builder/QA/reviewer agents in parallel.
- Add integrator flow to merge or reject worker output.
- Add conflict detection and resolution.

### Phase 7: External Development Integrations

- Add GitHub issue/PR/CI tools behind provider interfaces.
- Add review-comment routing back to worker missions.
- Add CI-failure log ingestion and auto-fix missions.
- Add deployment preview provider.
- Add MCP marketplace/toolkit recommendations.

### Phase 8: Production Hardening

- Add telemetry for mission quality, loops, failures, cost, and tool success.
- Add benchmark suite with known app-building tasks.
- Add regression evals for project creation, UI QA, bug fixing, dependency handling, and database work.
- Add red-team tests for prompt injection and destructive actions.
- Add docs for autonomy profiles and sandbox security.

## First Concrete Milestone

Build "Durable Single-Agent Mission Mode":

1. User can create a mission from chat.
2. Mission persists goal, plan, todo graph, tool events, files changed, terminal output, screenshots, and verification status.
3. Existing local-agent loop runs under mission context.
4. Agent can continue automatically until done or blocked.
5. User can pause/resume/cancel.
6. UI shows a timeline and verification checklist.
7. Existing app-building behavior remains unchanged outside mission mode.

This is the correct first milestone because it turns the current working agent into a reliable long-running developer without the added complexity of multiple workers.

## Non-Negotiable Acceptance Criteria

- A mission can survive app restart and resume without losing state.
- Every file write, command, dependency install, database mutation, and external call appears in the mission timeline.
- UI work includes screenshots before completion.
- A greenfield app can be created without a pre-existing template.
- The agent can run build/type/test/start commands and self-correct from failures.
- High-autonomy mode has a kill switch, audit trail, and workspace boundary.
- Parallel workers never write to the same checkout directly.
- The final answer includes what was built, what was verified, what failed, and where the user can inspect changes.

## Recommended Next Step

Implement Phase 0 and Phase 1 together:

- reconcile `autonomousMode` schema/UI behavior,
- add mission records and event timeline,
- wrap the existing local-agent stream with mission context,
- persist tool events and checkpoints,
- add a minimal Mission panel.

After that, add the visual loop and greenfield project factory before attempting parallel swarms.
