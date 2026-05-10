# OrianBuilder · React + Electron

Desktop app shell that mirrors the OrianBuilder design 1:1.

## Stack

| Layer                | Tech                                      |
| -------------------- | ----------------------------------------- |
| Framework            | React 18 + TypeScript                     |
| App shell            | Electron 33                               |
| Routing              | TanStack Router (memory history)          |
| State                | Jotai atoms (with `atomWithStorage`)      |
| Server state         | TanStack Query                            |
| Styling              | Tailwind CSS v4 (`@theme` + custom CSS)   |
| UI primitives        | Base UI (`@base-ui-components/react`)     |
| Build tool           | Vite 6                                    |
| Database             | Drizzle ORM + better-sqlite3              |

## Getting Started

```bash
npm install
npm run electron:dev      # Vite + Electron together
# or
npm run dev               # Vite only (browser preview at :5173)
```

Build packaged desktop app:

```bash
npm run electron:build
```

## Project Structure

```
electron/             Electron main + preload (TS, compiled to dist-electron/)
src/
├── main.tsx          React entry — wires Jotai · Query · Router providers
├── router.tsx        TanStack Router route tree
├── styles/
│   └── globals.css   Tailwind v4 @theme + the full design system (animations,
│                     glass primitives, page-specific styles preserved 1:1)
├── lib/
│   ├── atoms.ts      Jotai atoms (engine, settings, marketplace, library…)
│   ├── query.ts      TanStack Query client
│   └── db/schema.ts  Drizzle SQLite schema (conversations, models, library)
├── components/
│   ├── shell/        RootLayout · Cosmos (animated star canvas) · Sidebar · Topbar
│   └── ui/           Button · Badge · Input · Switch · Slider · Tabs · Panel
└── routes/           Page components — one per sidebar destination
    ├── AppsPage.tsx          orbital launch pad
    ├── ChatPage.tsx          nebula console
    ├── EnginePage.tsx        cockpit / telemetry
    ├── ModelsPage.tsx        constellation grid
    ├── MarketplacePage.tsx   discover + downloads pane
    ├── MediaPage.tsx         generation studio
    ├── SettingsPage.tsx      schematic settings
    ├── LibraryPage.tsx       archive shell
    └── HubPage.tsx           launch templates
```

## Design Notes

- **Animated cosmos** — `Cosmos.tsx` runs a 240-star parallax canvas with twinkle
  + drift, plus DOM-animated nebula gradient, drifting grid overlay, and two
  shooting stars firing every 3–10 s.
- **Glass system** — three blur tiers (`.glass`, `.glass-deep`, `.glass-soft`)
  applied across every page for consistency.
- **Frameless window** — `BrowserWindow` is frameless on Windows/Linux; the
  custom topbar is `-webkit-app-region: drag` so the user can move the window.
  macOS keeps native traffic-light controls (`titleBarStyle: 'hiddenInset'`).
- **Persistent settings** — Jotai's `atomWithStorage` writes to `localStorage`,
  so theme / VRAM budget / language survive reloads.
- **Database** — Drizzle schema covers conversations, messages, downloaded
  models, and library items. Run `npm run db:generate` then `db:migrate`.

## Routes

| Path           | Page                |
| -------------- | ------------------- |
| `/apps`        | Setup / launch pad  |
| `/chat`        | Conversations       |
| `/engine`      | Inference engine    |
| `/models`      | Models library      |
| `/marketplace` | Hugging Face browse |
| `/media`       | Media AI studio     |
| `/settings`    | App settings        |
| `/library`     | Themes & prompts    |
| `/hub`         | Template picker     |
