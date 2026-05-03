# Tech Stack

- You are building a **Remix** application.
- Use TypeScript throughout.
- Use Tailwind CSS for all styling (already configured).
- Routes live in `app/routes/` using **file-based routing**.

## File-based Routing Conventions

| File                              | URL                           |
| --------------------------------- | ----------------------------- |
| `app/routes/_index.tsx`           | `/`                           |
| `app/routes/about.tsx`            | `/about`                      |
| `app/routes/blog._index.tsx`      | `/blog`                       |
| `app/routes/blog.$slug.tsx`       | `/blog/:slug`                 |
| `app/routes/dashboard.tsx`        | `/dashboard` (layout route)   |
| `app/routes/dashboard._index.tsx` | `/dashboard/` (child)         |
| `app/routes/api.items.ts`         | `/api/items` (resource route) |

## Core Pattern: loader + action + Form

```tsx
// Every route can export:
// loader  — server-side data fetch (GET)
// action  — server-side mutation handler (POST/PUT/DELETE)
// default — React component

import { json, redirect } from "@remix-run/node";
import type {
  LoaderFunctionArgs,
  ActionFunctionArgs,
  MetaFunction,
} from "@remix-run/node";
import {
  useLoaderData,
  Form,
  useNavigation,
  useActionData,
} from "@remix-run/react";

export const meta: MetaFunction = () => [{ title: "My Page" }];

export async function loader({ params, request }: LoaderFunctionArgs) {
  // Runs on the server every request.
  // Throw redirect() for redirects, throw json(data, { status: 404 }) for errors.
  const data = await db.query("SELECT * FROM items");
  return json({ items: data });
}

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const name = formData.get("name") as string;
  if (!name) return json({ error: "Name is required" }, { status: 400 });
  await db.create({ name });
  return redirect("/items");
}

export default function MyRoute() {
  const { items } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  return (
    <div>
      <Form method="post">
        <input name="name" />
        {actionData?.error && (
          <p className="text-red-500">{actionData.error}</p>
        )}
        <button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Saving…" : "Save"}
        </button>
      </Form>
      {items.map((item) => (
        <p key={item.id}>{item.name}</p>
      ))}
    </div>
  );
}
```

## Key Rules

- **Use `Form` not `<form>`** — Remix's `Form` handles progressive enhancement (works without JS).
- **No `useEffect` for data fetching** — use `loader` instead.
- **No `useState` for server data** — use `useLoaderData`.
- **`action` handles all mutations** — POST, PUT, PATCH, DELETE all go through `action`.
- **`redirect()`** from `@remix-run/node` for navigating after mutation (Post/Redirect/Get pattern).
- **`defer()` + `<Await>`** for streaming slow data without blocking the page.

## Error Handling

```tsx
// Per-route error boundary
export function ErrorBoundary() {
  const error = useRouteError();
  return (
    <div>Error: {isRouteErrorResponse(error) ? error.data : String(error)}</div>
  );
}
```

## Available packages (already installed)

- `@remix-run/node`, `@remix-run/react`, `@remix-run/serve`
- `tailwindcss`, `vite`, `vite-tsconfig-paths`

## Rules

- Use `~/*` alias for imports from `app/` (e.g. `import { db } from '~/lib/db'`).
- Never hardcode secrets — use `process.env.SECRET` in loaders/actions.
- Always type loader/action returns with `typeof loader` / `typeof action`.
- After adding a new route file, its URL is automatic — no need to register it.
