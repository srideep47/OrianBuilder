import { localTemplatesData, DEFAULT_TEMPLATE_ID } from "@/shared/templates";

interface TemplateRule {
  templateId: string;
  keywords: RegExp[];
}

// Order matters — more specific rules first
const RULES: TemplateRule[] = [
  // Desktop app
  {
    templateId: "electron-app",
    keywords: [
      /\belectron\s*app\b/i,
      /\bdesktop\s*app\b/i,
      /\bnative\s*desktop\b/i,
      /\belectron[\s-]?vite\b/i,
    ],
  },
  // Chrome extension
  {
    templateId: "tonedice/dyad-chrome-extension-template",
    keywords: [/chrome\s*extension/i, /browser\s*extension/i, /manifest\s*v3/i],
  },
  // Mobile (official Expo scaffold — listed before community template so it takes priority)
  {
    templateId: "expo",
    keywords: [
      /react\s*native/i,
      /\bexpo\s*(?:sdk|router|app|go)?\b/i,
      /mobile\s*app/i,
      /\bios\s+&\s+android\b/i,
      /cross[- ]platform\s*mobile/i,
    ],
  },
  // SvelteKit
  {
    templateId: "sveltekit",
    keywords: [/\bsvelte\s*kit\b/i, /\bsveltekit\b/i, /\bsvelte\b/i],
  },
  // Astro
  {
    templateId: "astro",
    keywords: [
      /\bastro\b/i,
      /\bstatic\s*site\b/i,
      /\bcontent\s*site\b/i,
      /\bblog\s*site\b/i,
      /\bdocs?\s*site\b/i,
      /\bmarketing\s*(?:page|site)\b/i,
      /\bisland\s*architecture\b/i,
    ],
  },
  // Remix
  {
    templateId: "remix",
    keywords: [/\bremix\b/i, /\bnested\s*route/i],
  },
  // Angular
  {
    templateId: "jeff-kazzee/dyad-template-angular",
    keywords: [/\bangular\b/i],
  },
  // Vue
  {
    templateId: "k1lgor/dyad-vue-template",
    keywords: [/\bvue\b/i, /\bpinia\b/i, /\bnuxt\b/i],
  },
  // Docker
  {
    templateId: "stgreenb/docker-dyad-template",
    keywords: [
      /\bdocker\b/i,
      /\bcontainer(ize|ized|ization)?\b/i,
      /\blowdb\b/i,
    ],
  },
  // SQLite full-stack
  {
    templateId: "sqlite-express",
    keywords: [
      /\bsqlite\b/i,
      /\bbetter[\s-]sqlite\b/i,
      /\boffline[\s-]?first\b/i,
      /\bembedded\s*db\b/i,
      /\blocal\s*database\b/i,
    ],
  },
  // React Router 7 / Full-stack with Prisma
  {
    templateId: "sparkie-dev/dyad-react-router-7-fs-routes-template",
    keywords: [
      /\bprisma\b/i,
      /\bfull[\s-]?stack\b/i,
      /react\s*router\s*7/i,
      /\brest\s*api\b/i,
      /\bgraphql\b/i,
      /with\s+(?:a\s+)?(?:database|db|backend|server)/i,
      /(?:database|db|backend|server)\s+(?:and|with|using)/i,
    ],
  },
  // Next.js
  {
    templateId: "next",
    keywords: [
      /\bnext\.?js\b/i,
      /\bserver[\s-]?side\s*render/i,
      /\bssr\b/i,
      /\bapp\s*router\b/i,
    ],
  },
];

// Returns the id of the best-matching template, or the current default if no
// keywords match. Only picks community templates that are actually in the local
// list so we never return a stale id.
export function autoSelectTemplate(prompt: string): string {
  const knownIds = new Set(localTemplatesData.map((t) => t.id));

  for (const rule of RULES) {
    if (!knownIds.has(rule.templateId)) continue;
    if (rule.keywords.some((re) => re.test(prompt))) {
      return rule.templateId;
    }
  }

  return DEFAULT_TEMPLATE_ID;
}
