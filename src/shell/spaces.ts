import {
  BookMarked,
  Boxes,
  Cpu,
  Eye,
  FolderKanban,
  Gamepad2,
  Gauge,
  Images,
  LayoutTemplate,
  Layers3,
  Network,
  Newspaper,
  Orbit,
  Share2,
  Sparkles,
  Store,
  Terminal,
  type LucideIcon,
} from "lucide-react";

/**
 * The desktop information architecture.
 *
 * Before this, the shell offered sixteen flat destinations in three tiers of
 * visual weight, with four different media destinations, two library
 * destinations, two model destinations, and two that rendered the same page
 * (`/` and `/orion`, `/mediaai` and `/media-runtime`). Nothing told the user
 * which of them were the same kind of thing.
 *
 * Now there are five spaces plus Settings, mirroring OrionAndroid's
 * `ui/Destinations.kt` (Code · Models · Hub · Settings) widened for a desktop
 * window. A space is a place you go; a view is a way of looking at what's
 * already there. Every previous destination is a view inside exactly one space,
 * so nothing was lost and nothing is reachable from two places.
 *
 * Routes are unchanged — this is a presentational grouping over the existing
 * router, not a nested-route rewrite. That keeps deep links, e2e tests and the
 * tray/menu working while the shell reads as one product.
 */

export type SpaceId = "orion" | "build" | "game" | "create" | "engine" | "hub";

export interface SpaceView {
  /** Route path. Must exist in `src/router.ts`. */
  to: string;
  label: string;
  icon: LucideIcon;
  /** One line explaining the view — shown in the space header's switcher. */
  hint: string;
}

export interface Space {
  id: SpaceId;
  label: string;
  /** Where the nav rail sends you. Always the space's first view. */
  to: string;
  icon: LucideIcon;
  /** What the space is for. Shown as the page description on the landing view. */
  purpose: string;
  /** Empty for single-view spaces — the header then renders no switcher. */
  views: ReadonlyArray<SpaceView>;
  /**
   * Extra routes that belong to this space but get no switcher entry: detail
   * pages and tools reached from inside a view. Used only to resolve which nav
   * item is active.
   */
  alsoOwns?: ReadonlyArray<string>;
}

export const SPACES: ReadonlyArray<Space> = [
  {
    id: "orion",
    label: "Orion",
    to: "/",
    icon: Orbit,
    purpose:
      "One command surface. Describe the outcome and Orion picks the tools, models and executors.",
    views: [],
    // `/orion` was a near-duplicate of `/`; it now redirects here.
    alsoOwns: ["/onboarding"],
  },
  {
    id: "build",
    label: "Build",
    to: "/chat",
    icon: Terminal,
    purpose:
      "The development loop: conversation plus files, editor, preview, problems, source control and delivery in one workspace.",
    views: [
      {
        to: "/chat",
        label: "Workspace",
        icon: Terminal,
        hint: "Conversation and the tool dock",
      },
      {
        to: "/apps",
        label: "Projects",
        icon: FolderKanban,
        hint: "Everything you have built",
      },
      {
        to: "/templates",
        label: "Templates",
        icon: LayoutTemplate,
        hint: "Starting points for a new project",
      },
      {
        to: "/library",
        label: "Library",
        icon: BookMarked,
        hint: "Prompts, themes and generated media you own",
      },
    ],
    // Prompts and Themes are drill-downs from Library rather than switcher
    // entries of their own — Library already lists both, so promoting them
    // would put the same content in the switcher twice.
    alsoOwns: [
      "/app-details",
      "/design-studio",
      "/library/prompts",
      "/library/themes",
    ],
  },
  {
    id: "game",
    label: "Game",
    to: "/game",
    icon: Gamepad2,
    purpose:
      "A real Godot engine under both hands and agent control: scenes, live inspection, generated assets, animation and playable builds.",
    views: [],
  },
  {
    id: "create",
    label: "Create",
    to: "/mediaai",
    icon: Sparkles,
    purpose:
      "Image, video, audio, music and 3D generation on local models, with every result kept in its session.",
    views: [
      {
        to: "/mediaai",
        label: "Studio",
        icon: Sparkles,
        hint: "Compose and run a generation recipe",
      },
      {
        to: "/library/media-queue",
        label: "Queue",
        icon: Layers3,
        hint: "Jobs waiting, running and finished",
      },
      {
        to: "/library/media",
        label: "Gallery",
        icon: Images,
        hint: "Everything generated so far",
      },
      {
        to: "/threedassets",
        label: "3D",
        icon: Boxes,
        hint: "Meshes, textures and reconstruction",
      },
    ],
  },
  {
    id: "engine",
    label: "Engine",
    to: "/inference",
    icon: Cpu,
    purpose:
      "Local inference: what is resident, what it costs, and which models are installed or available.",
    views: [
      {
        to: "/inference",
        label: "Cockpit",
        icon: Gauge,
        hint: "Runtime, hardware and generation settings",
      },
      {
        to: "/models",
        label: "Installed",
        icon: Layers3,
        hint: "Models on this machine",
      },
      {
        to: "/marketplace",
        label: "Marketplace",
        icon: Store,
        hint: "Browse and download new models",
      },
    ],
  },
  {
    id: "hub",
    label: "Hub",
    to: "/network",
    icon: Network,
    purpose:
      "Trusted peers, shared work, and the background watch over long-running jobs.",
    views: [
      {
        to: "/network",
        label: "Peers",
        icon: Network,
        hint: "Identity, friends and shared compute",
      },
      {
        to: "/library/shared",
        label: "Shared",
        icon: Share2,
        hint: "Content peers have sent you",
      },
      {
        to: "/dailyaidigest",
        label: "Digest",
        icon: Newspaper,
        hint: "What changed while you were away",
      },
      {
        to: "/watchdog",
        label: "Watchdog",
        icon: Eye,
        hint: "Health of long-running work",
      },
    ],
  },
];

/**
 * Resolves the active space from a pathname. Longest-prefix wins so
 * `/library/media-queue` lands in Create rather than matching a shorter
 * `/library` prefix somewhere else.
 */
export function spaceForPath(pathname: string): Space | null {
  if (pathname === "/") return SPACES[0];

  let best: { space: Space; length: number } | null = null;
  for (const space of SPACES) {
    const candidates = [
      ...space.views.map((view) => view.to),
      ...(space.alsoOwns ?? []),
    ];
    for (const candidate of candidates) {
      if (candidate === "/") continue;
      if (pathname === candidate || pathname.startsWith(`${candidate}/`)) {
        if (!best || candidate.length > best.length) {
          best = { space, length: candidate.length };
        }
      }
    }
  }
  return best?.space ?? null;
}

/** Resolves the active view within a space, for the header switcher. */
export function viewForPath(space: Space, pathname: string): SpaceView | null {
  let best: SpaceView | null = null;
  for (const view of space.views) {
    if (pathname === view.to || pathname.startsWith(`${view.to}/`)) {
      if (!best || view.to.length > best.to.length) best = view;
    }
  }
  return best;
}
