import fs from "node:fs/promises";
import path from "node:path";

export type DetectedPackageManager =
  | "npm"
  | "pnpm"
  | "yarn"
  | "bun"
  | "unknown";

export type DetectedProjectFramework =
  | "nextjs"
  | "vite"
  | "react"
  | "vue"
  | "sveltekit"
  | "svelte"
  | "angular"
  | "astro"
  | "nuxt"
  | "remix"
  | "gatsby"
  | "electron"
  | "expo"
  | "react-native"
  | "node"
  | "unknown";

export type DetectedProjectKind =
  | "frontend"
  | "fullstack"
  | "backend"
  | "desktop"
  | "mobile"
  | "library"
  | "unknown";

export interface ProjectStackCommands {
  install: string | null;
  dev: string | null;
  start: string | null;
  build: string | null;
  test: string | null;
  lint: string | null;
  typecheck: string | null;
}

export interface ProjectStackDetection {
  rootPath: string;
  packageManager: DetectedPackageManager;
  framework: DetectedProjectFramework;
  kind: DetectedProjectKind;
  language: "typescript" | "javascript" | "mixed" | "unknown";
  scripts: Record<string, string>;
  dependencies: string[];
  devDependencies: string[];
  configFiles: string[];
  lockfiles: string[];
  commands: ProjectStackCommands;
  confidence: "high" | "medium" | "low";
  evidence: string[];
  warnings: string[];
}

interface PackageJson {
  packageManager?: unknown;
  scripts?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
}

const CONFIG_FILES = [
  "next.config.js",
  "next.config.mjs",
  "next.config.cjs",
  "next.config.ts",
  "vite.config.js",
  "vite.config.ts",
  "vite.config.mjs",
  "vite.config.mts",
  "electron.vite.config.js",
  "electron.vite.config.ts",
  "electron.vite.config.mjs",
  "electron.vite.config.mts",
  "astro.config.js",
  "astro.config.mjs",
  "astro.config.ts",
  "nuxt.config.js",
  "nuxt.config.ts",
  "svelte.config.js",
  "svelte.config.ts",
  "angular.json",
  "gatsby-config.js",
  "gatsby-config.ts",
  "remix.config.js",
  "remix.config.ts",
  "app.config.js",
  "app.config.ts",
  "expo.json",
  "tsconfig.json",
  "jsconfig.json",
  "tailwind.config.js",
  "tailwind.config.ts",
  "postcss.config.js",
  "postcss.config.cjs",
];

const LOCKFILES: Array<{ file: string; manager: DetectedPackageManager }> = [
  { file: "pnpm-lock.yaml", manager: "pnpm" },
  { file: "yarn.lock", manager: "yarn" },
  { file: "bun.lockb", manager: "bun" },
  { file: "bun.lock", manager: "bun" },
  { file: "package-lock.json", manager: "npm" },
  { file: "npm-shrinkwrap.json", manager: "npm" },
];

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readPackageJson(
  rootPath: string,
): Promise<{ packageJson: PackageJson | null; warning: string | null }> {
  const packageJsonPath = path.join(rootPath, "package.json");
  if (!(await exists(packageJsonPath))) {
    return { packageJson: null, warning: null };
  }

  try {
    const raw = await fs.readFile(packageJsonPath, "utf8");
    return { packageJson: JSON.parse(raw) as PackageJson, warning: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      packageJson: null,
      warning: `Could not parse package.json: ${message}`,
    };
  }
}

function asStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      result[key] = entry;
    }
  }
  return result;
}

function getPackageManagerFromPackageJson(
  packageJson: PackageJson | null,
): DetectedPackageManager | null {
  const value = packageJson?.packageManager;
  if (typeof value !== "string") {
    return null;
  }

  if (value.startsWith("pnpm@")) return "pnpm";
  if (value.startsWith("yarn@")) return "yarn";
  if (value.startsWith("bun@")) return "bun";
  if (value.startsWith("npm@")) return "npm";
  return null;
}

async function findPresentFiles(
  rootPath: string,
  files: string[],
): Promise<string[]> {
  const present: string[] = [];
  for (const file of files) {
    if (await exists(path.join(rootPath, file))) {
      present.push(file);
    }
  }
  return present;
}

function detectPackageManager(params: {
  packageJson: PackageJson | null;
  lockfiles: string[];
  evidence: string[];
}): DetectedPackageManager {
  const fromPackageJson = getPackageManagerFromPackageJson(params.packageJson);
  if (fromPackageJson) {
    params.evidence.push(`package.json packageManager uses ${fromPackageJson}`);
    return fromPackageJson;
  }

  for (const { file, manager } of LOCKFILES) {
    if (params.lockfiles.includes(file)) {
      params.evidence.push(`${file} indicates ${manager}`);
      return manager;
    }
  }

  return "npm";
}

function commandForScript(
  manager: DetectedPackageManager,
  script: string,
): string {
  if (manager === "pnpm") return `pnpm ${script}`;
  if (manager === "yarn") return `yarn ${script}`;
  if (manager === "bun") return `bun run ${script}`;
  return `npm run ${script}`;
}

function installCommand(
  manager: DetectedPackageManager,
  framework?: DetectedProjectFramework,
): string {
  if (manager === "pnpm") return "pnpm install";
  if (manager === "yarn") return "yarn install";
  if (manager === "bun") return "bun install";
  if (framework === "expo") return "npm install --legacy-peer-deps";
  return "npm install";
}

function tscCommand(manager: DetectedPackageManager): string {
  if (manager === "pnpm") return "pnpm exec tsc --noEmit";
  if (manager === "yarn") return "yarn tsc --noEmit";
  if (manager === "bun") return "bunx tsc --noEmit";
  return "npx tsc --noEmit";
}

function findFirstScript(
  scripts: Record<string, string>,
  candidates: string[],
): string | null {
  return candidates.find((script) => scripts[script]) ?? null;
}

function buildCommands(params: {
  manager: DetectedPackageManager;
  framework: DetectedProjectFramework;
  scripts: Record<string, string>;
  language: ProjectStackDetection["language"];
  configFiles: string[];
}): ProjectStackCommands {
  const { manager, scripts } = params;
  const devScript = findFirstScript(
    scripts,
    params.framework === "expo"
      ? ["preview", "dev", "start", "serve"]
      : ["dev", "preview", "start", "serve"],
  );
  const startScript = findFirstScript(scripts, ["start", "dev", "serve"]);
  const buildScript = findFirstScript(scripts, ["build"]);
  const testScript = findFirstScript(scripts, ["test", "test:unit", "vitest"]);
  const lintScript = findFirstScript(scripts, ["lint", "lint:check"]);
  const typecheckScript = findFirstScript(scripts, [
    "typecheck",
    "type-check",
    "check-types",
    "ts",
    "tsc",
  ]);

  return {
    install: installCommand(manager, params.framework),
    dev: devScript ? commandForScript(manager, devScript) : null,
    start: startScript ? commandForScript(manager, startScript) : null,
    build: buildScript ? commandForScript(manager, buildScript) : null,
    test: testScript ? commandForScript(manager, testScript) : null,
    lint: lintScript ? commandForScript(manager, lintScript) : null,
    typecheck: typecheckScript
      ? commandForScript(manager, typecheckScript)
      : params.language === "typescript" ||
          params.language === "mixed" ||
          params.configFiles.includes("tsconfig.json")
        ? tscCommand(manager)
        : null,
  };
}

function detectFramework(params: {
  configFiles: string[];
  deps: Record<string, string>;
  evidence: string[];
}): DetectedProjectFramework {
  const { configFiles, deps, evidence } = params;
  const hasConfig = (file: string) => configFiles.includes(file);
  const hasDep = (name: string) => Boolean(deps[name]);

  if (configFiles.some((file) => file.startsWith("next.config."))) {
    evidence.push("Next.js config file found");
    return "nextjs";
  }
  if (hasDep("next")) {
    evidence.push("next dependency found");
    return "nextjs";
  }
  if (configFiles.some((file) => file.startsWith("nuxt.config."))) {
    evidence.push("Nuxt config file found");
    return "nuxt";
  }
  if (hasDep("nuxt")) {
    evidence.push("nuxt dependency found");
    return "nuxt";
  }
  if (configFiles.some((file) => file.startsWith("astro.config."))) {
    evidence.push("Astro config file found");
    return "astro";
  }
  if (hasDep("astro")) {
    evidence.push("astro dependency found");
    return "astro";
  }
  if (hasConfig("svelte.config.js") || hasConfig("svelte.config.ts")) {
    if (hasDep("@sveltejs/kit")) {
      evidence.push("SvelteKit dependency and config found");
      return "sveltekit";
    }
    evidence.push("Svelte config file found");
    return "svelte";
  }
  if (hasDep("@sveltejs/kit")) {
    evidence.push("@sveltejs/kit dependency found");
    return "sveltekit";
  }
  if (hasDep("svelte")) {
    evidence.push("svelte dependency found");
    return "svelte";
  }
  if (hasConfig("angular.json") || hasDep("@angular/core")) {
    evidence.push("Angular project signals found");
    return "angular";
  }
  if (configFiles.some((file) => file.startsWith("remix.config."))) {
    evidence.push("Remix config file found");
    return "remix";
  }
  if (
    hasDep("@remix-run/react") ||
    hasDep("@remix-run/node") ||
    hasDep("remix")
  ) {
    evidence.push("Remix dependency found");
    return "remix";
  }
  if (configFiles.some((file) => file.startsWith("gatsby-config."))) {
    evidence.push("Gatsby config file found");
    return "gatsby";
  }
  if (hasDep("gatsby")) {
    evidence.push("gatsby dependency found");
    return "gatsby";
  }
  if (hasConfig("expo.json") || hasDep("expo")) {
    evidence.push("Expo project signals found");
    return "expo";
  }
  if (hasDep("react-native")) {
    evidence.push("react-native dependency found");
    return "react-native";
  }
  if (
    configFiles.some((file) => file.startsWith("electron.vite.config.")) ||
    hasDep("electron") ||
    hasDep("electron-vite") ||
    hasDep("@electron-forge/cli") ||
    hasDep("electron-builder")
  ) {
    evidence.push("Electron project signals found");
    return "electron";
  }
  if (configFiles.some((file) => file.startsWith("vite.config."))) {
    evidence.push("Vite config file found");
    return "vite";
  }
  if (hasDep("vite")) {
    evidence.push("vite dependency found");
    return "vite";
  }
  if (hasDep("vue")) {
    evidence.push("vue dependency found");
    return "vue";
  }
  if (hasDep("react") || hasDep("react-dom")) {
    evidence.push("react dependency found");
    return "react";
  }
  if (hasDep("express") || hasDep("fastify") || hasDep("koa")) {
    evidence.push("Node server dependency found");
    return "node";
  }

  return "unknown";
}

function detectKind(
  framework: DetectedProjectFramework,
  deps: Record<string, string>,
): DetectedProjectKind {
  if (framework === "expo" || framework === "react-native") return "mobile";
  if (framework === "electron") return "desktop";
  if (framework === "node") return "backend";
  if (
    framework === "nextjs" ||
    framework === "nuxt" ||
    framework === "remix" ||
    deps.express ||
    deps.fastify ||
    deps.koa
  ) {
    return "fullstack";
  }
  if (
    framework === "vite" ||
    framework === "react" ||
    framework === "vue" ||
    framework === "sveltekit" ||
    framework === "svelte" ||
    framework === "angular" ||
    framework === "astro" ||
    framework === "gatsby"
  ) {
    return "frontend";
  }
  if (deps.typescript || deps.tsup || deps.rollup || deps.unbuild) {
    return "library";
  }
  return "unknown";
}

function detectLanguage(params: {
  configFiles: string[];
  deps: Record<string, string>;
}): ProjectStackDetection["language"] {
  const hasTsConfig = params.configFiles.includes("tsconfig.json");
  const hasJsConfig = params.configFiles.includes("jsconfig.json");
  const hasTypescript = Boolean(params.deps.typescript);

  if ((hasTsConfig || hasTypescript) && hasJsConfig) return "mixed";
  if (hasTsConfig || hasTypescript) return "typescript";
  if (hasJsConfig) return "javascript";
  return "unknown";
}

function getConfidence(params: {
  framework: DetectedProjectFramework;
  packageJson: PackageJson | null;
  configFiles: string[];
}): ProjectStackDetection["confidence"] {
  if (params.framework !== "unknown" && params.configFiles.length > 0) {
    return "high";
  }
  if (params.framework !== "unknown" || params.packageJson) {
    return "medium";
  }
  return "low";
}

export async function detectProjectStack(
  rootPath: string,
): Promise<ProjectStackDetection> {
  const resolvedRoot = path.resolve(rootPath);
  const warnings: string[] = [];
  const evidence: string[] = [];
  const { packageJson, warning } = await readPackageJson(resolvedRoot);
  if (warning) warnings.push(warning);

  const scripts = asStringRecord(packageJson?.scripts);
  const dependencies = asStringRecord(packageJson?.dependencies);
  const devDependencies = asStringRecord(packageJson?.devDependencies);
  const deps = { ...dependencies, ...devDependencies };
  const configFiles = await findPresentFiles(resolvedRoot, CONFIG_FILES);
  const lockfiles = await findPresentFiles(
    resolvedRoot,
    LOCKFILES.map((entry) => entry.file),
  );
  const packageManager = detectPackageManager({
    packageJson,
    lockfiles,
    evidence,
  });
  const framework = detectFramework({ configFiles, deps, evidence });
  const kind = detectKind(framework, deps);
  const language = detectLanguage({ configFiles, deps });

  if (!packageJson) {
    warnings.push(
      "No package.json found; commands are inferred with low confidence.",
    );
  }
  if (framework === "unknown") {
    warnings.push("No known framework signals found.");
  }

  return {
    rootPath: resolvedRoot,
    packageManager,
    framework,
    kind,
    language,
    scripts,
    dependencies: Object.keys(dependencies).sort(),
    devDependencies: Object.keys(devDependencies).sort(),
    configFiles,
    lockfiles,
    commands: buildCommands({
      manager: packageManager,
      framework,
      scripts,
      language,
      configFiles,
    }),
    confidence: getConfidence({ framework, packageJson, configFiles }),
    evidence,
    warnings,
  };
}
