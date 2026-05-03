# Tech Stack

- You are building a **SvelteKit** application.
- Use TypeScript (`.svelte` files with `<script lang="ts">`).
- Use **file-based routing**: pages live in `src/routes/`.
  - `+page.svelte` — page component
  - `+layout.svelte` — layout wrapper (use sparingly, only for shared shell)
  - `+page.ts` — load function (runs on server + client)
  - `+page.server.ts` — server-only load function (DB calls, secrets)
  - `+server.ts` — API endpoint (returns `Response` or use `json()`)
- Use **Svelte 5 runes** syntax (`$state`, `$derived`, `$effect`, `$props`) — NOT legacy `let x = 0` reactivity or `export let prop`.
- Use `$lib` alias for imports from `src/lib/` (e.g. `import { db } from '$lib/db'`).
- Use Tailwind CSS for all styling. **Never write raw CSS** unless absolutely necessary.
- Use `class:` directive instead of `:class` bindings (e.g. `class:active={isActive}`).
- Never use `className` — Svelte uses `class`.

## Routing patterns

```svelte
<!-- +page.svelte: reactive page -->
<script lang="ts">
  import type { PageData } from './$types';
  let { data }: { data: PageData } = $props();
</script>

<!-- +page.ts: universal load (runs on both server and client) -->
export async function load({ fetch, params }) {
  const res = await fetch('/api/items');
  return { items: await res.json() };
}

<!-- +page.server.ts: server-only load (DB, secrets) -->
export async function load({ locals }) {
  return { user: locals.user };
}
```

## State management

- Use `$state()` for reactive local state — replaces `let`.
- Use `$derived()` for computed values — replaces `$: computed = ...`.
- Use `$effect()` for side effects — replaces `$: { sideEffect() }`.
- For shared state across components, create a **Svelte store** in `src/lib/stores/` using `writable()` or `$state` in a `.svelte.ts` file.

## Available packages (already installed)

- `tailwindcss` + `autoprefixer` + `postcss`
- `@sveltejs/kit` + `@sveltejs/adapter-node`

## Rules

- Never use `any` — type everything.
- Keep components focused. Extract sub-components when a file is long.
- Server routes (`+server.ts`) return `json(data)` from `@sveltejs/kit`.
- Never hardcode secrets — use `$env/static/private` for server-only secrets, `$env/static/public` for public.
- After editing a file, verify imports are correct.
