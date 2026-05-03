# Contributing to Orian Builder

Before opening a pull request, please open an issue and discuss whether the change makes sense. Ensuring a cohesive user experience sometimes means we can't include every possible feature, or we need to consider the long-term design of how we want to support a feature area.

- For a high-level overview of how Orian Builder works, see the [Architecture Guide](./docs/architecture.md).
- For details on the local agent loop (Agent v2 / tool-calling mode), see the [Agent Architecture Guide](./docs/agent_architecture.md).

> **Note:** By submitting a contribution within `src/pro`, you agree that such contribution is licensed under the Fair Source License (FSL) used by that directory.

## Non-code contributions

Bug reports, feature requests, and design feedback are just as valuable as code. If you found an issue or have an idea, open a GitHub issue at [github.com/srideep47/OrianBuilder/issues](https://github.com/srideep47/OrianBuilder/issues).

## Development

Orian Builder is an Electron app.

**Install dependencies:**

```sh
npm install
```

**Create the userData directory (required for database):**

```sh
# Unix/macOS/Linux:
mkdir -p userData

# Windows PowerShell (run only if folder doesn't exist):
mkdir userData
```

**Generate DB migrations:**

If you change the DB schema (`src/db/schema.ts`), generate a migration:

```sh
npm run db:generate
```

> To discard a migration, delete `userData/sqlite.db` to reset your local database.

**Run locally:**

```sh
npm start
```

## Setup

Set up pre-commit hooks to run the formatter and linter before each commit:

```sh
npm run init-precommit
```

## Pre-commit checks

Run all checks before committing:

**Formatting:**

```sh
npm run fmt
```

**Linting:**

```sh
npm run lint
```

**Type-checking:**

```sh
npm run ts
```

> **WARNING:** Do NOT run `npx tsc` directly. Always use `npm run ts` — it uses the correct configuration and compiler (`tsgo`).

## Testing

### Unit tests

```sh
npm test
```

### E2E tests

Build the app for E2E testing (required before running tests):

```sh
npm run build
```

> You only need to rebuild when changing app code. Changes to test files alone do not require a rebuild.

Run the full E2E test suite:

```sh
npm run e2e
```

Run a specific test file:

```sh
npm run e2e e2e-tests/context_manage.spec.ts
```

Update snapshots for a test:

```sh
npm run e2e e2e-tests/context_manage.spec.ts -- --update-snapshots
```

## TensorRT development

To build a TensorRT engine locally (requires NVIDIA GPU, CUDA 12.x, Python 3.10, TensorRT 10.x):

```sh
npm run build:trt-llm-engine
```

The Python runner lives at `native/trt-llm-runner/runner.py`. The TypeScript backend is at `src/ipc/utils/tensorrt_native_backend.ts`.

## Code reviews

Use local review tools for quick feedback before pushing:

- Claude Code CLI — `claude` → `/review`

## Code style

- Use **Base UI** (`@base-ui/react`) for all UI primitives — never Radix UI.
- IPC errors that are not bugs (validation, missing entities, user refusal) must be thrown as `DyadError` with a `DyadErrorKind`. See [rules/dyad-errors.md](rules/dyad-errors.md).
- Keep Electron security practices in mind: no `remote`, validate by `appId` when mutating shared resources.
- Add tests in the same folder tree when touching renderer components.
