# Tech Stack

- You are building an **Astro** application.
- Use TypeScript for component scripts.
- Output mode is `static` (SSG) by default. Switch to `server` or `hybrid` in `astro.config.mjs` if you need SSR.
- Use Tailwind CSS for all styling (already configured via `@astrojs/tailwind`).

## Astro component format

```astro
---
// Component Script (TypeScript) — runs at build time (or request time in SSR)
interface Props {
  title: string;
  count?: number;
}
const { title, count = 0 } = Astro.props;

// Fetch data here — NOT in client scripts
const data = await fetch('https://api.example.com/items').then(r => r.json());
---

<!-- Component Template (HTML) -->
<div class="container mx-auto">
  <h1 class="text-2xl font-bold">{title}</h1>
  {data.items.map(item => <p>{item.name}</p>)}
</div>
```

## File-based routing (`src/pages/`)

- `index.astro` → `/`
- `about.astro` → `/about`
- `blog/[slug].astro` → `/blog/:slug` (dynamic route)
- `api/data.ts` → `/api/data` (API endpoint — returns `Response`)

## Island Architecture (client-side interactivity)

Use directives **only when you need JavaScript on the client**:

```astro
<!-- Hydrate immediately on page load -->
<Counter client:load />

<!-- Hydrate when component enters viewport -->
<HeavyChart client:visible />

<!-- Hydrate once browser is idle -->
<Analytics client:idle />

<!-- Hydrate only on specified media query -->
<Sidebar client:media="(max-width: 768px)" />
```

Without a `client:*` directive, components are **static HTML** — no JS shipped.

## Content Collections (for blogs/docs)

```ts
// src/content/config.ts
import { z, defineCollection } from "astro:content";

const blog = defineCollection({
  schema: z.object({
    title: z.string(),
    date: z.date(),
    tags: z.array(z.string()).optional(),
  }),
});

export const collections = { blog };
```

## Available packages (already installed)

- `astro` + `@astrojs/tailwind`
- `tailwindcss`

## Rules

- Never hardcode secrets — use `import.meta.env.SECRET_KEY` (server-only in `.astro` frontmatter).
- Public env vars must be prefixed `PUBLIC_` — e.g. `PUBLIC_API_URL`.
- Prefer `.astro` for static content, React/Vue/Svelte islands only for interactive widgets.
- Images go in `public/` and are referenced as `/image.png`, OR use `<Image>` from `astro:assets` for optimization.
- After editing a file, verify imports are correct.
