/**
 * Every surface the Stage can show.
 *
 * This replaces `src/shell/spaces.ts` as the app's information architecture,
 * with one structural difference that is the entire point: a *space* was a
 * place you navigated to, so you had to know where a thing lived before you
 * could use it. A *surface* is summoned — by Marta, or by the command palette,
 * which resolves through this same list. Nothing is reachable by knowing a
 * route.
 *
 * Params are declared as JSON Schema by hand rather than generated from the
 * routes' `validateSearch`, because those schemas live in the renderer and this
 * runs in main. The set is small and stable enough that a drift test
 * (`surfaces.test.ts`) checking route strings against `src/router.ts` is a
 * better guard than a build-time codegen step.
 *
 * `displays` is what lets a finished flow choose its own surface: a step that
 * produced a `mesh` artifact can be shown without Marta being told where 3D
 * assets live.
 */

import type { SurfaceNode } from "./types";

export const SURFACES: ReadonlyArray<SurfaceNode> = [
  {
    kind: "surface",
    id: "build.workspace",
    title: "Workspace",
    summary:
      "The development loop for one project: conversation, files, editor, preview, problems and source control.",
    route: "/chat",
    params: {
      type: "object",
      properties: {
        id: { type: "number", description: "Chat id to open." },
      },
      additionalProperties: false,
    },
    keywords: ["code", "editor", "develop", "chat", "build", "workspace"],
    displays: ["file_change", "diff", "problems", "terminal_output"],
  },
  {
    kind: "surface",
    id: "build.projects",
    title: "Projects",
    summary: "Every project in the workspace, with its status and recent work.",
    route: "/apps",
    keywords: ["apps", "projects", "my work", "portfolio"],
    displays: ["project_list"],
  },
  {
    kind: "surface",
    id: "build.project",
    title: "Project detail",
    summary:
      "One project's settings, integrations, database, deployment and screenshots.",
    route: "/app-details",
    params: {
      type: "object",
      properties: {
        appId: { type: "number", description: "Numeric project id." },
        provider: {
          type: "string",
          enum: ["neon", "supabase"],
          description: "Jump straight to a database provider's panel.",
        },
      },
      additionalProperties: false,
    },
    keywords: ["project settings", "integrations", "database", "deploy"],
  },
  {
    kind: "surface",
    id: "build.templates",
    title: "Templates",
    summary: "Starting points for a new project.",
    route: "/templates",
    keywords: ["templates", "scaffold", "boilerplate", "start from"],
  },
  {
    kind: "surface",
    id: "build.library",
    title: "Library",
    summary: "Prompts, themes and generated media you own.",
    route: "/library",
    keywords: ["library", "saved", "my stuff"],
  },
  {
    kind: "surface",
    id: "build.prompts",
    title: "Prompts",
    summary: "Saved prompts you can reuse across projects.",
    route: "/library/prompts",
    keywords: ["prompts", "snippets", "saved instructions"],
  },
  {
    kind: "surface",
    id: "build.themes",
    title: "Themes",
    summary: "Visual themes projects can be built against.",
    route: "/library/themes",
    keywords: ["themes", "styling", "look and feel"],
  },
  {
    kind: "surface",
    id: "build.design",
    title: "Design studio",
    summary: "Design-system-driven UI generation sessions.",
    route: "/design-studio",
    keywords: ["design", "ui", "mockup", "design system"],
    displays: ["design"],
  },

  {
    kind: "surface",
    id: "game.workbench",
    title: "Game workbench",
    summary:
      "A real Godot engine under hand and agent control: scenes, live inspection, generated assets, animation and playable builds.",
    route: "/game",
    keywords: ["godot", "game", "scene", "engine", "level"],
    displays: ["scene", "viewport", "game_build"],
  },

  {
    kind: "surface",
    id: "create.studio",
    title: "Media studio",
    summary:
      "Compose and run a generation recipe for image, video, audio, music or 3D.",
    route: "/mediaai",
    keywords: [
      "generate",
      "media",
      "image",
      "video",
      "audio",
      "music",
      "studio",
    ],
    displays: ["image", "video", "audio", "music"],
  },
  {
    kind: "surface",
    id: "create.queue",
    title: "Media queue",
    summary: "Generation jobs waiting, running and finished.",
    route: "/library/media-queue",
    keywords: ["queue", "jobs", "rendering", "progress"],
    displays: ["media_job"],
  },
  {
    kind: "surface",
    id: "create.gallery",
    title: "Gallery",
    summary: "Everything generated so far.",
    route: "/library/media",
    keywords: ["gallery", "images", "results", "outputs"],
    displays: ["image", "video", "audio"],
  },
  {
    kind: "surface",
    id: "create.threed",
    title: "3D assets",
    // The route really is `/3dassets`. `spaces.ts` pointed the old nav at
    // `/threedassets`, which matches no route and silently redirected home —
    // one of the reasons the IA is moving into a registry with a drift test.
    summary: "Meshes, textures and photo-to-3D reconstruction.",
    route: "/3dassets",
    keywords: ["3d", "mesh", "model", "glb", "gltf", "asset"],
    displays: ["mesh", "3d"],
  },

  {
    kind: "surface",
    id: "engine.cockpit",
    title: "Inference cockpit",
    summary:
      "Local inference: runtime, hardware, VRAM, throughput and generation settings.",
    route: "/inference",
    keywords: ["inference", "gpu", "vram", "model runtime", "performance"],
    displays: ["gpu_stats", "inference_stats"],
  },
  {
    kind: "surface",
    id: "engine.models",
    title: "Installed models",
    summary: "Models downloaded to this machine.",
    route: "/models",
    keywords: ["models", "installed", "local models", "weights"],
  },
  {
    kind: "surface",
    id: "engine.marketplace",
    title: "Model marketplace",
    summary: "Browse and download new models.",
    route: "/marketplace",
    keywords: ["download model", "huggingface", "browse models"],
  },

  {
    kind: "surface",
    id: "hub.peers",
    title: "Peers",
    summary: "Identity, trusted friends and shared compute.",
    route: "/network",
    keywords: ["network", "peers", "friends", "share compute", "p2p"],
  },
  {
    kind: "surface",
    id: "hub.shared",
    title: "Shared content",
    summary: "Content peers have sent you.",
    route: "/library/shared",
    keywords: ["shared", "received", "from peers"],
  },
  {
    kind: "surface",
    id: "hub.digest",
    title: "Daily digest",
    summary: "What changed in AI while you were away.",
    route: "/dailyaidigest",
    keywords: ["news", "digest", "what's new", "headlines"],
    displays: ["news"],
  },
  {
    kind: "surface",
    id: "hub.watchdog",
    title: "Watchdog",
    summary: "Health of long-running work, website and price tracking.",
    route: "/watchdog",
    keywords: ["watchdog", "monitoring", "tracking", "alerts"],
  },

  {
    kind: "surface",
    id: "app.settings",
    title: "Settings",
    summary:
      "Every app setting: providers, models, telemetry, storage, themes.",
    route: "/settings",
    keywords: ["settings", "preferences", "options", "configure"],
  },
] as const;

/** Surfaces keyed by id, for O(1) resolution when Marta names one. */
export const SURFACES_BY_ID: ReadonlyMap<string, SurfaceNode> = new Map(
  SURFACES.map((surface) => [surface.id, surface]),
);

/** Kept for the drift test: every route a surface claims to host. */
export const SURFACE_ROUTES: ReadonlyArray<string> = SURFACES.map(
  (s) => s.route,
);
