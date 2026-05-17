# Claude Implementation Prompt: Autonomous Agentic Builder Phase 2

You are working in `D:\Work\LegionStudios\ProjectOrion\Builder\orianbuilder`, the Orian Builder Electron app. Read `AGENTS.md`, `CONTRIBUTING.md`, and the relevant rule files before touching code:

- `rules/local-agent-tools.md`
- `rules/electron-ipc.md`
- `rules/database-drizzle.md`
- `rules/base-ui-components.md`
- `rules/product-principles.md`
- `rules/e2e-testing.md` if you add E2E coverage

Do not hand-wave. Implement, test, and leave the repo in a coherent state. Use existing patterns over new architecture unless there is a clear reason.

## Final Product Plan

The final plan is stored in `plans/fully-automated-agentic-builder.md`. Treat it as the source of truth for the long-term direction:

1. Phase 0: Stabilize Current Agent
2. Phase 1: Mission Data Model and Dashboard Skeleton
3. Phase 2: Managed Runtime and Visual Loop
4. Phase 3: Greenfield Project Factory
5. Phase 4: Autonomy Profiles and Safety Guards
6. Phase 5: Durable Long-Running Execution
7. Phase 6: Parallel Worker Orchestration
8. Phase 7: External Development Integrations
9. Phase 8: Production Hardening

The current work is **Phase 2 only**. Do not jump to parallel agents, greenfield project factory, GitHub PR orchestration, or deployment providers yet.

## Current Implemented Baseline

Phase 0 and Phase 1 are implemented or in progress in this branch:

- `autonomousMode` setting exists and local-agent tool consent auto-approves when enabled.
- Mission records exist.
- Mission events exist.
- Mission tasks are synced from `update_todos`.
- Mission runs and checkpoints persist local-agent stream execution.
- Mission panel shows mission status, task progress, verification chips, timeline, and latest run/checkpoint state.
- The local-agent stream logs structured file, dependency, terminal, verification, and lifecycle events.

Important files:

- `src/db/schema.ts`
- `src/ipc/types/mission.ts`
- `src/ipc/handlers/mission_handlers.ts`
- `src/ipc/utils/mission_utils.ts`
- `src/ipc/utils/mission_tasks.ts`
- `src/ipc/utils/mission_verification.ts`
- `src/ipc/utils/mission_xml_events.ts`
- `src/pro/main/ipc/handlers/local_agent/local_agent_handler.ts`
- `src/components/chat/MissionControl.tsx`
- `src/hooks/useMissions.ts`

## Phase 2 Objective

Implement **Managed Runtime and Visual Loop** properly, using the app's existing runtime and visual tools instead of duplicating them.

The existing app already has:

- App runtime handlers: `runApp`, `stopApp`, `restartApp` in `src/ipc/handlers/app_handlers.ts`
- Running app state in `src/ipc/utils/process_manager.ts`
- Local-agent tools:
  - `take_screenshot`
  - `get_accessibility_tree`
  - `read_console_output`
  - `run_terminal_command`

Build Phase 2 around those primitives.

## Required Phase 2 Deliverables

1. Persist mission artifacts:
   - Add a `mission_artifacts` table.
   - Store screenshots, accessibility trees, console checks, and runtime/preview checks as durable mission artifacts.
   - Add IPC contracts and handlers to list artifacts by mission.
   - Add React Query keys and hook support.

2. Visual/runtime gate events:
   - Parse final local-agent XML output for:
     - `<orianbuilder-screenshot ...>`
     - `<orianbuilder-accessibility-tree ...>`
     - `<orianbuilder-console-output ...>`
     - `<orianbuilder-terminal-command ...>` when it represents app start/dev/preview
   - Log structured mission events:
     - `visual_screenshot_captured`
     - `visual_accessibility_captured`
     - `visual_console_checked`
     - `runtime_preview_checked`
   - Mark each event metadata with `status: "passed" | "failed" | "unknown"` and useful details.

3. Mission panel:
   - Show visual/runtime gate chips in `MissionControl`.
   - At minimum show Screenshot, A11y, Console, Runtime.
   - Chips must reflect passed/failed/unknown based on mission event metadata.

4. Tests:
   - Unit-test XML artifact/event extraction.
   - Type-check with `npm run ts`.
   - Run focused tests for mission utilities and the local-agent regression.

5. Do not implement yet:
   - Multi-agent workers
   - Worktrees
   - Docker/cloud sandbox orchestration beyond existing app runtime integration
   - Greenfield project factory
   - Deployment/PR automation

## Acceptance Criteria

- A mission records a screenshot as a durable artifact when `take_screenshot` succeeds.
- A mission records accessibility tree and console output artifacts/checks when those tools run.
- Mission timeline shows visual/runtime checks.
- Mission panel shows visual/runtime check status.
- Existing agent behavior outside mission mode is unchanged.
- TypeScript passes.
- Focused tests pass.

## Verification Commands

Use only supported commands:

```sh
npm run ts
npm test -- src/__tests__/mission_tasks.test.ts src/__tests__/mission_verification.test.ts src/__tests__/mission_xml_events.test.ts
npm test -- src/__tests__/local_agent_handler.test.ts -t "auto-approves local-agent tools"
```

On Windows in Codex, Vitest may require elevated execution because esbuild spawn can fail with `EPERM`.
