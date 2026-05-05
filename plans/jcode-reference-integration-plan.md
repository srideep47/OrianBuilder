# jcode Reference Integration Plan

## Summary

jcode is useful for our plan, but mostly as an architecture reference, not as
code to directly merge. It is a Rust TUI/server agent harness, while Orian is an
Electron/React/TypeScript builder with an existing mission system.

Compatibility verdict: compatible and helpful. Do not remove the current Phase
1-6 Orian work. Keep our mission tables, Mission Control UI, local-agent tools,
autonomy policy, greenfield factory, visual gates, checkpointing, and worker
records. Use jcode to strengthen the missing parts: real parallel worker
orchestration, shared MCP runtime, agent memory, soft interrupts, browser
interaction protocol, and safer autonomous permission flow.

## What To Reuse From jcode

- Swarm orchestration model: coordinator, workers, statuses, dependency-aware
  assignment, completion reports, stale worker detection, file-touch conflict
  alerts.
- Shared MCP pool: avoid spawning duplicate MCP server processes per session;
  add connect/reload/list/disconnect management.
- Soft interrupts: inject user/worker/system messages into running agents at
  safe points instead of cancelling the run.
- Agent memory: app-scoped and mission-scoped memory with inspectable retrieval,
  not hidden prompt stuffing.
- Browser tool protocol: one first-class browser control interface with
  capability negotiation, instead of scattered screenshot-only tools.
- Safety queue: persistent permission requests for autonomous/background work.

Do not port jcode's Rust TUI, desktop shell, mobile simulator, terminal
rendering, or self-dev binary reload system. Those are not aligned with Orian's
Electron UI and current architecture.

## Key Changes

### 1. Preserve Current Orian Code

- Keep existing `missions`, `mission_tasks`, `mission_runs`, `mission_events`,
  `mission_checkpoints`, `mission_artifacts`, and `mission_workers`.
- Extend the current worker foundation instead of replacing it.
- Replace only shallow/placeholder behavior:
  - current worker "seed only" flow becomes real worker dispatch;
  - current MCP singleton becomes pooled/reloadable MCP runtime;
  - current restart recovery that pauses missions becomes resumable mission
    scheduling;
  - current screenshot/a11y loop becomes broader browser interaction and visual
    QA.

### 2. Phase 6 Completion: Real Worker Swarm

- Add a worker runtime service that can dispatch queued `mission_workers` into
  isolated workspaces.
- Default worker isolation:
  - `builder` and `qa`: git worktree or cloud sandbox.
  - `planner`, `reviewer`, and `integrator`: local read/write only when safe.
- Add worker lifecycle states matching jcode's useful model: `queued`, `ready`,
  `running`, `blocked`, `completed`, `failed`, `cancelled`, plus a metadata flag
  for `stale`.
- Add dependency-aware assignment:
  - worker runs only when `dependsOn` workers are completed.
  - stale workers emit mission events and can be retried/reassigned.
- Add completion reports:
  - every worker must produce summary, changed files, validation, blockers, and
    artifacts.
  - integrator applies/rejects worker output after review.

### 3. MCP Runtime Upgrade

- Keep Orian's existing `mcp_servers` DB/settings UI and MCP consent model.
- Add a shared MCP client pool keyed by server id/config hash.
- Add per-session handles so multiple missions can reuse the same MCP process
  safely.
- Add local-agent management tool: `manage_mcp_server` with actions `list`,
  `connect`, `disconnect`, `reload`.
- Route MCP management through autonomy policy:
  - list/reload existing enabled servers: low/medium risk.
  - connect new stdio command: ask unless sandboxed.
  - unknown external MCP tools: require consent unless explicitly trusted.

### 4. Browser And Visual QA Upgrade

- Keep `start_dev_server`, `take_screenshot`, `get_accessibility_tree`, and
  `read_console_output`.
- Add one browser-control tool family with actions: `open`, `snapshot`, `click`,
  `type`, `press`, `scroll`, `eval`, `screenshot`.
- Use the existing managed preview URL as the default browser target.
- Persist browser snapshots/screenshots as mission artifacts.
- Add forced pre-completion visual gate for UI missions:
  - desktop screenshot
  - mobile screenshot
  - accessibility tree
  - console check
  - runtime readiness
- Mission completion remains blocked unless required gates pass or the user
  waives them.

### 5. Memory And Soft Interrupts

- Add inspectable memory records scoped by `appId` and optionally `missionId`.
- Store: stack decisions, commands, gotchas, user preferences, accepted/rejected
  approaches, recurring errors.
- Add memory search/injection only at mission start and step boundaries.
- Add soft-interrupt queue for:
  - user messages during long mission runs
  - worker completion reports
  - conflict alerts
  - runtime/test failure notifications
- Inject only at safe model-loop points after tool results are recorded.

### 6. Safety And Permission Queue

- Keep current autonomy profiles.
- Add persistent permission requests for background/autonomous actions.
- Actions that affect humans, remotes, billing, secrets, deployment,
  destructive SQL, or host-level state require explicit approval.
- Full-autopilot remains "full authority inside the selected sandbox," not
  silent full-machine control.
- Add audit events for every auto-approved, asked, denied, and waived action.

## Implementation Order

### 1. Worker Orchestrator Core

- Add worker dispatch service, dependency selection, stale detection, completion
  reports.
- Tests for worker DAG ordering, stale marking, retry, and status events.

### 2. Workspace Isolation

- Add git worktree provider first.
- Later plug in Docker/cloud provider using the same interface.
- Tests for non-overlapping worker scopes and conflict detection.

### 3. Integrator Flow

- Add worker output artifact format: patch/diff summary, changed files,
  validation.
- Add integrator review/apply/reject flow.
- Mission Control shows worker outputs and integration status.

### 4. Shared MCP Pool

- Refactor MCP manager to use pooled clients and reconnect cooldowns.
- Add `manage_mcp_server`.
- Preserve current Settings UI and DB schema where possible.

### 5. Browser Tool Protocol

- Add browser action tool over managed preview.
- Enforce visual QA gates before mission completion.

### 6. Memory And Soft Interrupts

- Add mission/app memory tables and IPC.
- Add safe interrupt queue into local-agent loop.
- Use interrupts for worker reports and live user guidance.

### 7. Safety Queue

- Persist autonomous permission requests.
- Add Mission Control permission section.
- Add tests for approval/denial/timeout behavior.

## Test Plan

### Unit Tests

- Worker dependency scheduling.
- Worker scope conflict detection.
- Stale worker detection.
- Completion report parsing.
- MCP pool reuse/ref-counting/reload.
- Autonomy decisions for MCP/browser/worktree tools.
- Memory scope filtering.
- Soft-interrupt safe injection ordering.

### IPC Tests

- Create/list/update workers.
- Dispatch worker.
- List worker artifacts.
- Approve/deny permission request.
- Browser tool events and artifacts.

### Local-Agent Tests

- Mission with two independent workers runs both.
- Dependent worker waits for prerequisite.
- Failed worker can be retried.
- Integrator refuses conflicting outputs.
- UI mission cannot complete before visual gates pass.

### E2E Tests

- Create greenfield app, run visual QA, complete mission.
- Seed workers, run worker flow, integrate result.
- Restart app during running mission and resume.
- MCP server enabled in settings appears in agent tools without duplicate
  process spawn.

## Assumptions

- We will not directly merge jcode's Rust runtime into Orian.
- jcode is MIT licensed, so small algorithmic ports are acceptable with
  attribution if copied closely.
- Current Orian phase work stays intact.
- Media generation pipeline remains out of scope for this integration.
- The immediate next implementation target is completing Phase 6 using jcode's
  swarm ideas.
