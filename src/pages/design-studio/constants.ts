// All static data for Design Studio — modes, fidelity, directions, prompts

// =============================================================================
// Modes
// =============================================================================
export type DesignMode = "prototype" | "deck" | "template" | "design-system";

export const MODES: Array<{
  id: DesignMode;
  label: string;
  icon: string;
  hint: string;
}> = [
  {
    id: "prototype",
    label: "Prototype",
    icon: "⬜",
    hint: "Single screen or flow",
  },
  { id: "deck", label: "Deck", icon: "📑", hint: "Multi-slide presentation" },
  {
    id: "template",
    label: "Template",
    icon: "📋",
    hint: "Fill a pre-built layout",
  },
  {
    id: "design-system",
    label: "Design Sys",
    icon: "🎨",
    hint: "Tokens & components doc",
  },
];

export const MODE_DIRECTIVES: Record<DesignMode, string> = {
  prototype:
    "You are generating a SINGLE-SCREEN prototype. Output one complete, self-contained HTML page.",
  deck: "You are generating a MULTI-SLIDE PRESENTATION. Structure each slide as a `<section class='slide'>`. Include a slide counter and keyboard arrow-key navigation (JS). Each slide should fill the viewport. Include a print-ready layout via @media print.",
  template:
    "You are filling a PRE-DESIGNED TEMPLATE. Maintain the exact layout, typography, and visual structure. Only replace placeholder content with real, high-quality copy and data.",
  "design-system":
    "You are generating a DESIGN SYSTEM DOCUMENTATION PAGE. Show: color tokens (swatches), typography scale, spacing scale, component examples (buttons, inputs, cards, badges), and brand guidelines. Make it scannable and reference-quality.",
};

// =============================================================================
// Fidelity
// =============================================================================
export type FidelityLevel = "wireframe" | "low-fi" | "high-fi" | "production";

export const FIDELITY_LEVELS: Array<{
  id: FidelityLevel;
  label: string;
  color: string;
  dot: string;
}> = [
  { id: "wireframe", label: "Wireframe", color: "#9ca3af", dot: "bg-gray-400" },
  { id: "low-fi", label: "Low-fi", color: "#f59e0b", dot: "bg-amber-400" },
  { id: "high-fi", label: "Hi-fi", color: "#3b82f6", dot: "bg-blue-500" },
  {
    id: "production",
    label: "Production",
    color: "#10b981",
    dot: "bg-emerald-500",
  },
];

export const FIDELITY_DIRECTIVES: Record<FidelityLevel, string> = {
  wireframe:
    "FIDELITY: WIREFRAME — greyscale only (#f5f5f5 bg, #e8e8e8 surfaces, #9ca3af muted, #374151 text). No real images — use grey aspect-ratio boxes. No decorative elements, no shadows, no gradients. Dashed borders to delineate regions. Use monospace or system-ui font. Small grey annotation labels are encouraged.",
  "low-fi":
    "FIDELITY: LOW-FIDELITY — flat colours only (no gradients, minimal shadows). Basic brand colours if a design system is active, otherwise use a simple 3-colour palette. No animations or micro-interactions. Focus on layout and structure over polish.",
  "high-fi":
    "FIDELITY: HIGH-FIDELITY — pixel-perfect execution. Apply all design system tokens fully. Rich micro-interactions, smooth CSS transitions, well-crafted shadows and gradients. Hover and focus states on every interactive element.",
  production:
    "FIDELITY: PRODUCTION-READY — WCAG 2.1 AA accessible. Proper semantic HTML5 elements. :focus-visible on all interactive elements. Responsive at 375px, 768px, and 1280px. Optimised rendering (will-change, prefers-reduced-motion). No placeholder copy or lorem ipsum.",
};

// =============================================================================
// Visual Directions
// =============================================================================
export type DirectionId =
  | "editorial-monocle"
  | "modern-minimal"
  | "warm-soft"
  | "tech-utility"
  | "brutalist";

export interface VisualDirection {
  id: DirectionId;
  name: string;
  description: string;
  bg: string;
  fg: string;
  accent: string;
  traits: string[];
  cssTokens: string;
  googleFonts?: string;
}

export const VISUAL_DIRECTIONS: VisualDirection[] = [
  {
    id: "editorial-monocle",
    name: "Editorial Monocle",
    description:
      "Typographic-first, high contrast black & white with one strong accent colour",
    bg: "#0a0a0a",
    fg: "#f5f5f5",
    accent: "#e63946",
    traits: ["High contrast", "Bold type", "Magazine"],
    googleFonts:
      "https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700;900&family=Neue+Haas+Grotesk:wght@400;500&display=swap",
    cssTokens: `--bg: #0a0a0a; --surface: #141414; --fg: #f5f5f5; --fg-2: #a8a8a8; --accent: #e63946; --accent-on: #ffffff; --border: rgba(255,255,255,0.08); --font-display: 'Playfair Display', Georgia, serif; --font-body: 'Neue Haas Grotesk', Helvetica, sans-serif;`,
  },
  {
    id: "modern-minimal",
    name: "Modern Minimal",
    description:
      "Clean whitespace, subtle greys, geometric precision with electric blue",
    bg: "#ffffff",
    fg: "#111111",
    accent: "#0066ff",
    traits: ["Clean", "Geometric", "Spacious"],
    googleFonts:
      "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap",
    cssTokens: `--bg: #ffffff; --surface: #f8f9fa; --fg: #111111; --fg-2: #6b7280; --accent: #0066ff; --accent-on: #ffffff; --border: #e5e7eb; --font-display: 'Inter', system-ui, sans-serif; --font-body: 'Inter', system-ui, sans-serif;`,
  },
  {
    id: "warm-soft",
    name: "Warm Soft",
    description: "Earthy tones, rounded shapes, approachable and human",
    bg: "#fef9f0",
    fg: "#2c1810",
    accent: "#e8845c",
    traits: ["Earthy", "Rounded", "Welcoming"],
    googleFonts:
      "https://fonts.googleapis.com/css2?family=Lora:wght@400;600;700&family=DM+Sans:wght@400;500&display=swap",
    cssTokens: `--bg: #fef9f0; --surface: #fdf3e7; --fg: #2c1810; --fg-2: #7c5341; --accent: #e8845c; --accent-on: #ffffff; --border: #e8d5c4; --font-display: 'Lora', Georgia, serif; --font-body: 'DM Sans', system-ui, sans-serif;`,
  },
  {
    id: "tech-utility",
    name: "Tech Utility",
    description:
      "Dense information, terminal-inspired, high contrast dark mode",
    bg: "#0d1117",
    fg: "#e6edf3",
    accent: "#79c0ff",
    traits: ["Dark", "Dense", "Technical"],
    googleFonts:
      "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Inter:wght@400;500&display=swap",
    cssTokens: `--bg: #0d1117; --surface: #161b22; --fg: #e6edf3; --fg-2: #8b949e; --accent: #79c0ff; --accent-on: #0d1117; --border: rgba(255,255,255,0.08); --font-display: 'JetBrains Mono', monospace; --font-body: 'Inter', system-ui, sans-serif;`,
  },
  {
    id: "brutalist",
    name: "Brutalist Experimental",
    description:
      "Raw, bold, unconventional — unexpected colours and layout breaks",
    bg: "#ffffff",
    fg: "#000000",
    accent: "#ff00cc",
    traits: ["Bold", "Unconventional", "Experimental"],
    googleFonts:
      "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&display=swap",
    cssTokens: `--bg: #ffffff; --surface: #f0f0f0; --fg: #000000; --fg-2: #333333; --accent: #ff00cc; --accent-2: #ffff00; --accent-on: #000000; --border: #000000; --font-display: 'Space Grotesk', 'Courier New', monospace; --font-body: 'Space Grotesk', 'Courier New', monospace;`,
  },
];

// =============================================================================
// Scenarios (for skill filter)
// =============================================================================
export const SCENARIOS = [
  { id: "all", label: "All" },
  { id: "design", label: "Design" },
  { id: "engineering", label: "Eng" },
  { id: "marketing", label: "Marketing" },
  { id: "product", label: "Product" },
  { id: "personal", label: "Personal" },
  { id: "operation", label: "Ops" },
] as const;

// =============================================================================
// Audience / Tone (Discovery Form)
// =============================================================================
export const AUDIENCES = [
  "General consumers",
  "Developers / engineers",
  "Business executives",
  "Designers / creatives",
  "Students",
  "Enterprises",
  "Startups",
];

export const TONES = [
  "Professional",
  "Playful",
  "Bold",
  "Minimal",
  "Luxury",
  "Friendly",
  "Technical",
];

// =============================================================================
// Prompt Gallery
// =============================================================================
export interface PromptTemplate {
  label: string;
  prompt: string;
}

export interface PromptCategory {
  category: string;
  icon: string;
  prompts: PromptTemplate[];
}

export const PROMPT_GALLERY: PromptCategory[] = [
  {
    category: "Landing Pages",
    icon: "🚀",
    prompts: [
      {
        label: "SaaS Hero + Pricing",
        prompt:
          "Create a SaaS landing page for a project management tool — animated hero section, 3-column feature grid, comparison pricing table, and a bottom CTA.",
      },
      {
        label: "Startup Waitlist",
        prompt:
          "Design a startup landing page with a full-viewport hero, animated gradient background, email waitlist form, and social proof logos.",
      },
      {
        label: "Agency Portfolio",
        prompt:
          "Build an agency portfolio landing page with a dramatic hero, case study cards, client logos, services section, and a contact form.",
      },
      {
        label: "Product Launch",
        prompt:
          "Create a product launch page with a sticky countdown timer, feature reveal sections, testimonial carousel, and pre-order CTA.",
      },
      {
        label: "Mobile App Promo",
        prompt:
          "Design a mobile app promotional landing page with phone mockup hero, feature highlights, app store badges, and a screenshot gallery.",
      },
    ],
  },
  {
    category: "Dashboards",
    icon: "📊",
    prompts: [
      {
        label: "Analytics Dashboard",
        prompt:
          "Create an analytics dashboard with collapsible sidebar nav, 4 KPI cards with sparklines, a line chart for weekly trends, and a recent activity table.",
      },
      {
        label: "Admin Panel",
        prompt:
          "Build a dark-mode admin panel with sidebar, breadcrumbs, a data table with sorting/filtering, bulk action toolbar, and a modal for editing rows.",
      },
      {
        label: "Ecommerce Dashboard",
        prompt:
          "Design an ecommerce dashboard showing revenue, orders, top products table, sales-by-region map placeholder, and inventory alerts.",
      },
      {
        label: "Finance Overview",
        prompt:
          "Create a personal finance dashboard with net worth tracker, spending donut chart, transaction history list, and budget progress bars.",
      },
    ],
  },
  {
    category: "Auth & Onboarding",
    icon: "🔐",
    prompts: [
      {
        label: "Login + Sign Up",
        prompt:
          "Design a polished login and sign-up page with a split layout — branded left panel and form right. Include social OAuth buttons, remember me, and forgot password link.",
      },
      {
        label: "Multi-step Onboarding",
        prompt:
          "Build a 3-step onboarding flow with progress indicator — profile setup, preferences, and invite teammates. Include back/next navigation and skip option.",
      },
      {
        label: "Two-Factor Auth",
        prompt:
          "Create a 2FA verification screen with OTP digit inputs, countdown resend timer, and helpful instructional copy.",
      },
    ],
  },
  {
    category: "Marketing",
    icon: "📣",
    prompts: [
      {
        label: "Feature Announcement",
        prompt:
          "Design a feature announcement email template with header logo, hero banner, feature highlights in icon-grid, and a CTA button.",
      },
      {
        label: "Pricing Page",
        prompt:
          "Create a pricing page with a monthly/annual toggle, 3 tier cards (Free, Pro, Enterprise), feature comparison table, and FAQ accordion.",
      },
      {
        label: "Blog Article",
        prompt:
          "Build a clean long-form blog article page with sticky table of contents, author byline, progress bar, related posts, and social share buttons.",
      },
    ],
  },
  {
    category: "Mobile Apps",
    icon: "📱",
    prompts: [
      {
        label: "Social Feed App",
        prompt:
          "Design a mobile social feed app screen with top nav, story circles row, post cards with like/comment/share actions, and floating compose button.",
      },
      {
        label: "Fitness Tracker",
        prompt:
          "Create a fitness tracking app home screen showing today's goal ring, workout summary cards, quick-start workout buttons, and a weekly activity chart.",
      },
      {
        label: "E-commerce App",
        prompt:
          "Design a mobile ecommerce product detail screen with image gallery swiper, size selector, add-to-cart button, reviews section, and recommended products.",
      },
    ],
  },
  {
    category: "Documents",
    icon: "📄",
    prompts: [
      {
        label: "Modern Resume",
        prompt:
          "Create a one-page professional resume for a senior software engineer with header, skills tags, work timeline, education, and project highlights.",
      },
      {
        label: "Project Proposal",
        prompt:
          "Design a project proposal document with cover section, executive summary, scope table, timeline Gantt-style view, and budget breakdown.",
      },
      {
        label: "Data Report",
        prompt:
          "Build a quarterly data report page with executive KPI summary, trend charts, regional breakdown table, insights section, and appendix.",
      },
    ],
  },
];
