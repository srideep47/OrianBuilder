export interface Template {
  id: string;
  title: string;
  description: string;
  imageUrl: string;
  githubUrl?: string;
  isOfficial: boolean;
  isExperimental?: boolean;
  requiresNeon?: boolean;
}

// API Template interface from the external API
export interface ApiTemplate {
  githubOrg: string;
  githubRepo: string;
  title: string;
  description: string;
  imageUrl: string;
}

export const DEFAULT_TEMPLATE_ID = "react";
export const DEFAULT_TEMPLATE = {
  id: "react",
  title: "React.js Template",
  description: "Uses React.js, Vite, Shadcn, Tailwind and TypeScript.",
  imageUrl:
    "https://github.com/user-attachments/assets/5b700eab-b28c-498e-96de-8649b14c16d9",
  isOfficial: true,
};

const PORTAL_MINI_STORE_ID = "portal-mini-store";
export const NEON_TEMPLATE_IDS = new Set<string>([PORTAL_MINI_STORE_ID]);

export const localTemplatesData: Template[] = [
  DEFAULT_TEMPLATE,
  {
    id: "next",
    title: "Next.js Template",
    description: "Uses Next.js, React.js, Shadcn, Tailwind and TypeScript.",
    imageUrl:
      "https://github.com/user-attachments/assets/96258e4f-abce-4910-a62a-a9dff77965f2",
    githubUrl: "https://github.com/dyad-sh/nextjs-template",
    isOfficial: true,
  },
  {
    id: PORTAL_MINI_STORE_ID,
    title: "Portal: Mini Store Template",
    description: "Uses Neon DB, Payload CMS, Next.js",
    imageUrl:
      "https://github.com/user-attachments/assets/ed86f322-40bf-4fd5-81dc-3b1d8a16e12b",
    githubUrl: "https://github.com/dyad-sh/portal-mini-store-template",
    isOfficial: true,
    isExperimental: true,
    requiresNeon: true,
  },
  // Community templates (offline fallbacks — also served live via the Dyad API)
  {
    id: "sparkie-dev/dyad-react-router-7-fs-routes-template",
    title: "React Router 7 + Full Stack",
    description:
      "React 19 + React Router 7 with file-based routes, Express 5, Prisma ORM, shadcn/ui and TanStack Query. True full-stack with a built-in backend.",
    imageUrl:
      "https://github.com/user-attachments/assets/6715b328-540f-4bd0-96fa-a0a78e73497c",
    githubUrl:
      "https://github.com/sparkie-dev/dyad-react-router-7-fs-routes-template",
    isOfficial: false,
  },
  {
    id: "stgreenb/docker-dyad-template",
    title: "Docker / Next.js / Lowdb",
    description:
      "Next.js + shadcn/ui + Lowdb JSON database with Dockerized deployment and automated GHCR GitHub Actions container builds.",
    imageUrl:
      "https://github.com/user-attachments/assets/ba9656e3-b9c4-4032-a138-f6d4a83cd84d",
    githubUrl: "https://github.com/stgreenb/docker-dyad-template",
    isOfficial: false,
  },
  {
    id: "k1lgor/dyad-vue-template",
    title: "Vue 3",
    description:
      "Vue 3 + Pinia + Reka UI + Vee-Validate + Supabase + TanStack Table. Production-ready Vue starter with TypeScript, Vite, and Tailwind CSS.",
    imageUrl:
      "https://github.com/user-attachments/assets/173a3551-ad10-4778-925f-6e2604570116",
    githubUrl: "https://github.com/k1lgor/dyad-vue-template",
    isOfficial: false,
  },
  {
    id: "jeff-kazzee/dyad-template-angular",
    title: "Angular",
    description:
      "Angular 17 with standalone components, RxJS, and TypeScript. Clean minimal starter for Angular apps.",
    imageUrl:
      "https://github.com/user-attachments/assets/9f8a86e9-2625-4cdf-9e47-c3b0d615cf4d",
    githubUrl: "https://github.com/jeff-kazzee/dyad-template-angular",
    isOfficial: false,
  },
  {
    id: "tonedice/dyad-chrome-extension-template",
    title: "Chrome Extension",
    description:
      "Manifest V3 Chrome Extension starter. Note: Dyad live preview does not work for extensions — load unpacked in Chrome to test.",
    imageUrl:
      "https://github.com/user-attachments/assets/dcf38eff-8772-458f-9ac9-07374c57c25e",
    githubUrl: "https://github.com/tonedice/dyad-chrome-extension-template",
    isOfficial: false,
    isExperimental: true,
  },
  {
    id: "shaaraa/dyad-react-native-expo-template",
    title: "React Native (Expo) + Web",
    description:
      "Expo SDK 53 + expo-router v5 starter that runs on iOS, Android, and the browser via react-native-web.",
    imageUrl:
      "https://github.com/user-attachments/assets/d6b58360-ef17-4614-8083-6abef1a00877",
    githubUrl: "https://github.com/shaaraa/dyad-react-native-expo-template",
    isOfficial: false,
    isExperimental: true,
  },
  // Official OrianBuilder templates
  {
    id: "sveltekit",
    title: "SvelteKit",
    description:
      "SvelteKit with TypeScript, Tailwind CSS, and file-based routing. Lightweight, fast, and ergonomic.",
    imageUrl:
      "https://github.com/user-attachments/assets/5b700eab-b28c-498e-96de-8649b14c16d9",
    isOfficial: true,
    isExperimental: false,
  },
  {
    id: "astro",
    title: "Astro",
    description:
      "Astro with TypeScript and Tailwind CSS. Perfect for content-heavy sites, blogs, and marketing pages with island architecture.",
    imageUrl:
      "https://github.com/user-attachments/assets/5b700eab-b28c-498e-96de-8649b14c16d9",
    isOfficial: true,
    isExperimental: false,
  },
  {
    id: "sqlite-express",
    title: "SQLite + Express + React",
    description:
      "Full-stack: Express API + better-sqlite3 (synchronous, offline-first) + React frontend. Fully self-contained, no external database required.",
    imageUrl:
      "https://github.com/user-attachments/assets/5b700eab-b28c-498e-96de-8649b14c16d9",
    isOfficial: true,
    isExperimental: false,
  },
  {
    id: "remix",
    title: "Remix",
    description:
      "Remix with TypeScript, Tailwind CSS, and Shadcn UI. Full-stack React with nested routing, loaders, and actions.",
    imageUrl:
      "https://github.com/user-attachments/assets/96258e4f-abce-4910-a62a-a9dff77965f2",
    isOfficial: true,
    isExperimental: false,
  },
  {
    id: "electron-app",
    title: "Electron Desktop App",
    description:
      "Build a desktop app: Electron + Vite + React + TypeScript. Separate main/renderer processes with contextBridge and preload scripts.",
    imageUrl:
      "https://github.com/user-attachments/assets/5b700eab-b28c-498e-96de-8649b14c16d9",
    isOfficial: true,
    isExperimental: true,
  },
  {
    id: "expo",
    title: "Expo (React Native)",
    description:
      "React Native app with Expo Router, TypeScript, and NativeWind. Runs on iOS, Android, and web. Scan the QR code with Expo Go to preview on your device.",
    imageUrl:
      "https://github.com/user-attachments/assets/5b700eab-b28c-498e-96de-8649b14c16d9",
    isOfficial: true,
    isExperimental: true,
  },
];
