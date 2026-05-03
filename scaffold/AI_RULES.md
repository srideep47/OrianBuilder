# Tech Stack

- You are building a React application.
- Use TypeScript.
- Use React Router. KEEP the routes in `src/App.tsx`
- Always put source code in the `src/` folder.
- Put pages into `src/pages/`, components into `src/components/`
- The main page (default page) is `src/pages/Index.tsx`
- UPDATE the main page to include new components — otherwise the user cannot see them.
- ALWAYS prefer the shadcn/ui library for UI components.
- Use Tailwind CSS for all styling. Never write raw CSS unless absolutely necessary.

## Available packages (already installed — do NOT install again)

- `shadcn/ui` — full component library (Button, Card, Dialog, Input, Table, etc.)
- All Radix UI primitives
- `lucide-react` — icons
- `react-hook-form` + `zod` — forms and validation
- `@tanstack/react-query` — server state / data fetching
- `recharts` — charts and graphs
- `date-fns` — date utilities

## Rules

- Never use `any` — always type properly.
- Prefer named exports over default exports for components.
- Keep components small and focused. Extract sub-components when a file exceeds ~150 lines.
- Always handle loading and error states in data-fetching components.
- Images go in `public/` and are referenced as `/image.png`.
- Never hardcode secrets or API keys in source files — use environment variables.
- When adding a new page, register its route in `src/App.tsx`.
- After editing a file, check that imports are correct and nothing is left unused.
