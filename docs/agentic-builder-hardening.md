# Agentic Builder Hardening

This page describes the user-visible safety model for autonomous missions.

## Autonomy Profiles

- **Supervised**: write and external-state actions ask first. This is the default profile for cautious work.
- **Trusted workspace**: ordinary workspace edits and verification can run without repeated prompts, while remote, destructive, billing, credential, deployment, and unknown MCP actions still require approval.
- **Full autopilot sandbox**: broad authority is limited to the selected sandbox/runtime boundary. Host-level, remote, billing, credential, and destructive actions still need explicit approval unless a future sandbox implementation can prove isolation.

## Runtime Isolation And Rollback

Missions run against the selected app workspace. Worker runs can use isolated git worktrees, and Mission Control records worker branch/path details before output is applied. Current checkpointing records mission state, step metadata, verification events, and artifact references. One-click rollback remains deferred until file restore semantics are finalized.

## Permission Model

Built-in and MCP tools are classified by risk, state scope, isolation needs, and expected artifacts. Consequential actions create visible permission requests in Mission Control. Approve/deny decisions are logged as mission events. Deploy previews always ask because they affect external systems.

## Browser QA And Visual Gates

Browser QA starts or reuses the managed runtime, waits for readiness, captures desktop and mobile screenshots, records accessibility output, and checks recent console errors. Missions that require post-create verification cannot be marked complete until required checks pass or the user waives the gate with a reason.

## MCP Trust Overrides

MCP tools inherit inferred risk/scope defaults. Users can override trust for specific server/tool keys in MCP settings. Unknown or remote-write MCP tools are treated conservatively and require explicit consent unless trusted.

## Deploy Preview And Media Generation

Deploy previews support Vercel, Netlify, and custom commands. Deployment URLs, provider state, and compact logs are stored as mission artifacts. Media generation uses a configurable local backend and stores image/audio/video outputs under `.orianbuilder/media`.

## Privacy And Budgets

Mission events, checkpoints, artifacts, interrupts, memories, and permission records may contain screenshots, accessibility output, console logs, deployment logs, generated media metadata, MCP tool metadata, or user-provided instructions. Before mission records are persisted, obvious tokens/secrets are redacted and large text/metadata fields are capped to prevent runaway logs and accidental storage of huge artifacts. Binary media stays in `.orianbuilder/media`; mission artifacts store references and compact metadata.

Mission execution also has runtime guardrails. Long-running turns are paused after the mission runtime budget, repeated failures from the same tool abort the turn, and excessive total tool failures abort the turn even when failures are spread across tools. Mission Control records these as budget events/checkpoints so the user can inspect the reason and resume intentionally.

Worker orchestration is bounded separately. Mission Control only seeds a capped number of active tasks into worker packages at once, and worker completion reports cap summary, validation, blocker, changed-file, and artifact fields before storing them in mission metadata.
