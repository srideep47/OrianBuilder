/**
 * Liquid / Cosmos design tokens — the desktop counterpart of Android's
 * `core/design/Cosmos.kt` + `Liquid.kt`.
 *
 * Everything the redesign draws with is declared here or in `globals.css`.
 * Component files must not invent their own radii, paddings, control heights or
 * type sizes; import from this module (or use the primitives that consume it) so
 * both clients keep speaking the same visual language.
 */

/** Corner radii, matching Android's `Liquid.Corner*`. */
export const radius = {
  /** Page-level panels and docks. */
  lg: "rounded-[26px]",
  /** Cards, list containers, sheets. */
  md: "rounded-[20px]",
  /** Controls, inputs, small tiles. */
  sm: "rounded-[14px]",
  /** Buttons, chips, segmented controls, avatars. */
  pill: "rounded-full",
} as const;

/**
 * Page container widths. Only `PageShell` reads these — pages never set their
 * own `max-w-*`, which is what made the old layout drift page to page.
 */
export const pageWidth = {
  /** Reading-led pages: settings, single-column detail, onboarding. */
  prose: "max-w-[900px]",
  /** Standard content pages: command surface, forms with a side rail. */
  content: "max-w-[1100px]",
  /** Grid pages: app/model/media galleries. */
  wide: "max-w-[1440px]",
  /** Tool docks and split panes — fill the pane, no centring. */
  full: "max-w-none",
} as const;

/** Interactive control heights. Icon buttons are square at the same values. */
export const control = {
  compact: "h-7", // 28px — dense toolbars, inline chips
  base: "h-[34px]", // 34px — the default for buttons, inputs, selects
  prominent: "h-10", // 40px — primary page actions, composer send
} as const;

/**
 * Vertical rhythm. Sections are separated by `section`, related rows by `row`.
 * Anything outside this scale reads as a mistake at a glance.
 */
export const gap = {
  hair: "gap-1", // 4
  tight: "gap-2", // 8
  row: "gap-3", // 12
  base: "gap-4", // 16
  section: "gap-6", // 24
  major: "gap-8", // 32
} as const;

/**
 * Type scale. Tracking is baked in: negative above 20px so large headings don't
 * look loose, slightly positive below 12px so micro-labels stay legible.
 */
export const text = {
  micro: "text-[11px] leading-[1.35] tracking-[0.01em]",
  caption: "text-[12px] leading-[1.4]",
  body: "text-[13px] leading-[1.5]",
  bodyLg: "text-sm leading-[1.55]",
  title: "text-base font-semibold leading-[1.35] tracking-[-0.005em]",
  heading: "text-xl font-semibold leading-[1.25] tracking-[-0.012em]",
  display: "text-[28px] font-semibold leading-[1.15] tracking-[-0.02em]",
  mono: "font-mono text-[12px] leading-[1.45] tabular-nums",
} as const;

/** Foreground ramp — mirrors `Cosmos.Text/TextDim/TextMuted/TextFaint`. */
export const fg = {
  strong: "text-foreground",
  dim: "text-foreground/80",
  muted: "text-muted-foreground",
  faint: "text-muted-foreground/65",
} as const;

/** Motion. Matches the `--motion-*` / `--ease-macos` variables in globals.css. */
export const motion = {
  hover: "transition-colors duration-[120ms] ease-[var(--ease-macos-control)]",
  press:
    "transition-transform duration-[80ms] ease-[var(--ease-macos-control)]",
  panel:
    "transition-[width,height,opacity,transform] duration-[240ms] ease-[var(--ease-macos)]",
} as const;

/**
 * Semantic status colours, mapped onto the Cosmos accents so status never
 * introduces a hue that isn't already in the palette.
 */
export const status = {
  success: {
    text: "text-[var(--cosmos-green)]",
    bg: "bg-[color-mix(in_srgb,var(--cosmos-green)_14%,transparent)]",
    border: "border-[color-mix(in_srgb,var(--cosmos-green)_30%,transparent)]",
    dot: "bg-[var(--cosmos-green)]",
  },
  warning: {
    text: "text-[var(--cosmos-amber)]",
    bg: "bg-[color-mix(in_srgb,var(--cosmos-amber)_14%,transparent)]",
    border: "border-[color-mix(in_srgb,var(--cosmos-amber)_30%,transparent)]",
    dot: "bg-[var(--cosmos-amber)]",
  },
  danger: {
    text: "text-[var(--cosmos-red)]",
    bg: "bg-[color-mix(in_srgb,var(--cosmos-red)_14%,transparent)]",
    border: "border-[color-mix(in_srgb,var(--cosmos-red)_30%,transparent)]",
    dot: "bg-[var(--cosmos-red)]",
  },
  info: {
    text: "text-[var(--cosmos-blue)]",
    bg: "bg-[color-mix(in_srgb,var(--cosmos-blue)_14%,transparent)]",
    border: "border-[color-mix(in_srgb,var(--cosmos-blue)_30%,transparent)]",
    dot: "bg-[var(--cosmos-blue)]",
  },
  accent: {
    text: "text-primary",
    bg: "bg-primary/12",
    border: "border-primary/25",
    dot: "bg-primary",
  },
  neutral: {
    text: "text-muted-foreground",
    bg: "bg-muted/50",
    border: "border-border/70",
    dot: "bg-muted-foreground/60",
  },
} as const;

export type StatusTone = keyof typeof status;

/**
 * The material itself. `fill` is the lensing gradient (brighter at the top edge,
 * like light entering glass); `rim` is the specular 1px border. Kept as class
 * strings rather than a component so any element can opt in.
 */
export const material = {
  /** In-content glass: cards, list containers, inline panels. */
  fill: "bg-gradient-to-b from-white/[0.075] to-white/[0.025]",
  fillStrong: "bg-gradient-to-b from-white/[0.13] to-white/[0.05]",
  fillSelected: "bg-gradient-to-b from-primary/[0.22] to-primary/[0.07]",
  rim: "border border-white/[0.10]",
  rimStrong: "border border-white/[0.16]",
  rimSelected: "border border-primary/45",
  /** Backdrop blur for chrome that floats over scrolling content. */
  blur: "backdrop-blur-[24px] backdrop-saturate-[180%]",
  blurThick: "backdrop-blur-[40px] backdrop-saturate-[180%]",
  /** Inner top highlight — the "catch light" on the top edge. */
  sheen: "shadow-[inset_0_1px_0_rgba(255,255,255,0.09)]",
  /** Floating elevation. */
  lift: "shadow-[0_18px_60px_rgba(0,0,0,0.42)]",
  liftSm: "shadow-[0_10px_30px_rgba(0,0,0,0.28)]",
} as const;
