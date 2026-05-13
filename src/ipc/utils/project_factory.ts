import { spawn } from "node:child_process";
import nodeFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export type GreenfieldScaffoldMethod = "starter_files" | "cli";

export const GREENFIELD_PROJECT_STACKS = [
  "vite-react-ts",
  "nextjs-ts",
  "node-express-ts",
  "electron-app",
  "expo",
  "blank",
] as const;

export type GreenfieldProjectStack = (typeof GREENFIELD_PROJECT_STACKS)[number];

export type GreenfieldPackageManager = "npm" | "pnpm" | "yarn" | "bun";

export interface ProjectFile {
  path: string;
  content: string;
}

export interface CreateGreenfieldProjectOptions {
  rootPath: string;
  projectName: string;
  stack: GreenfieldProjectStack;
  packageManager: GreenfieldPackageManager;
  scaffoldMethod?: GreenfieldScaffoldMethod;
  executeCli?: boolean;
  force?: boolean;
}

export interface ProjectVerificationCommands {
  install: string;
  dev: string | null;
  build: string | null;
  typecheck: string | null;
}

export interface CreateGreenfieldProjectResult {
  created: boolean;
  reason: string | null;
  stack: GreenfieldProjectStack;
  packageManager: GreenfieldPackageManager;
  scaffoldMethod: GreenfieldScaffoldMethod;
  scaffoldCommand: string | null;
  files: string[];
  nextSteps: string[];
  commands: ProjectVerificationCommands;
  verificationPlan: string[];
  output: string | null;
}

const IGNORED_EXISTING_ENTRIES = new Set([
  ".git",
  ".orianbuilder",
  ".DS_Store",
]);
const PACKAGE_MANAGER_VERSIONS: Record<GreenfieldPackageManager, string> = {
  npm: "10.8.0",
  pnpm: "9.0.0",
  yarn: "1.22.22",
  bun: "1.1.0",
};
const MAX_CLI_OUTPUT_CHARS = 16_000;
const CLI_SCAFFOLD_TIMEOUT_MS = 180_000;

function toPackageName(value: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "new-project";
}

function toAndroidPackageSegment(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "")
      .slice(0, 40) || "app"
  );
}

function runCommand(
  packageManager: GreenfieldPackageManager,
  script: string,
): string {
  if (packageManager === "pnpm") return `pnpm ${script}`;
  if (packageManager === "yarn") return `yarn ${script}`;
  if (packageManager === "bun") return `bun run ${script}`;
  return `npm run ${script}`;
}

function installCommand(packageManager: GreenfieldPackageManager): string {
  if (packageManager === "pnpm") return "pnpm install";
  if (packageManager === "yarn") return "yarn install";
  if (packageManager === "bun") return "bun install";
  return "npm install";
}

function packageManagerSpec(packageManager: GreenfieldPackageManager): string {
  return `${packageManager}@${PACKAGE_MANAGER_VERSIONS[packageManager]}`;
}

export function getProjectVerificationCommands(params: {
  stack: GreenfieldProjectStack;
  packageManager: GreenfieldPackageManager;
}): ProjectVerificationCommands {
  const hasBuild = params.stack !== "blank" && params.stack !== "expo";
  const hasTypecheck =
    params.stack === "vite-react-ts" ||
    params.stack === "nextjs-ts" ||
    params.stack === "node-express-ts" ||
    params.stack === "expo" ||
    params.stack === "electron-app";
  return {
    install: installCommand(params.packageManager),
    dev:
      params.stack === "blank"
        ? null
        : params.stack === "expo"
          ? runCommand(params.packageManager, "start")
          : params.stack === "electron-app"
            ? runCommand(params.packageManager, "preview")
            : runCommand(params.packageManager, "dev"),
    build: hasBuild ? runCommand(params.packageManager, "build") : null,
    typecheck: hasTypecheck
      ? runCommand(params.packageManager, "typecheck")
      : null,
  };
}

export function getCliScaffoldCommand(params: {
  stack: GreenfieldProjectStack;
  packageManager: GreenfieldPackageManager;
}): string | null {
  if (params.stack === "vite-react-ts") {
    if (params.packageManager === "pnpm") {
      return "pnpm create vite . --template react-ts";
    }
    if (params.packageManager === "yarn") {
      return "yarn create vite . --template react-ts";
    }
    if (params.packageManager === "bun") {
      return "bun create vite . --template react-ts";
    }
    return "npm create vite@latest . -- --template react-ts";
  }

  if (params.stack === "nextjs-ts") {
    const packageManagerFlag = {
      npm: "--use-npm",
      pnpm: "--use-pnpm",
      yarn: "--use-yarn",
      bun: "--use-bun",
    }[params.packageManager];
    const baseCommand = {
      npm: "npx create-next-app@latest",
      pnpm: "pnpm create next-app",
      yarn: "yarn create next-app",
      bun: "bunx create-next-app@latest",
    }[params.packageManager];
    return `${baseCommand} . --typescript --eslint --app --no-src-dir --no-tailwind --import-alias "@/*" ${packageManagerFlag}`;
  }

  return null;
}

function getLocalScaffoldDir(stack: GreenfieldProjectStack): string | null {
  if (stack !== "expo" && stack !== "electron-app") {
    return null;
  }
  const candidates = [
    path.join(process.cwd(), "scaffolds", stack),
    path.join(__dirname, "..", "..", "..", "scaffolds", stack),
    path.join(__dirname, "..", "..", "scaffolds", stack),
  ];
  return (
    candidates.find((candidate) => nodeFs.existsSync(candidate)) ??
    candidates[0]
  );
}

function getVerificationPlan(commands: ProjectVerificationCommands): string[] {
  return [
    `Run ${commands.install}`,
    commands.typecheck ? `Run ${commands.typecheck}` : null,
    commands.build ? `Run ${commands.build}` : null,
    commands.dev
      ? "Run start_dev_server, then inspect console output and visual artifacts."
      : null,
  ].filter((step): step is string => Boolean(step));
}

function truncateOutput(output: string): string {
  if (output.length <= MAX_CLI_OUTPUT_CHARS) return output;
  const half = Math.floor(MAX_CLI_OUTPUT_CHARS / 2);
  return `${output.slice(0, half)}\n\n... [output truncated] ...\n\n${output.slice(-half)}`;
}

async function runCliScaffold(params: {
  command: string;
  cwd: string;
}): Promise<{ exitCode: number; output: string }> {
  return await new Promise((resolve) => {
    let output = "";
    const child = spawn(params.command, [], {
      cwd: params.cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({
        exitCode: 124,
        output: truncateOutput(`${output}\n[Timed out after 180 seconds]`),
      });
    }, CLI_SCAFFOLD_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        exitCode: 1,
        output: truncateOutput(`${output}\n[Spawn error: ${error.message}]`),
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 0, output: truncateOutput(output) });
    });
  });
}

async function listCreatedFiles(rootPath: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(directory: string) {
    if (files.length >= 200) return;
    let entries: Array<{ name: string; isDirectory: () => boolean }>;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (files.length >= 200) return;
      if (
        entry.name === "node_modules" ||
        entry.name === ".git" ||
        entry.name === ".next" ||
        entry.name === "dist"
      ) {
        continue;
      }
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else {
        files.push(path.relative(rootPath, fullPath).replace(/\\/g, "/"));
      }
    }
  }

  await walk(rootPath);
  return files.sort();
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function aiRules(stack: GreenfieldProjectStack): string {
  return `# AI_RULES

## Project Stack

- Stack: ${stack}
- Keep changes small and verify after each feature.
- Prefer existing scripts from package.json over guessed commands.
- Run the app before claiming UI work is complete.
- For UI work, check console output, capture desktop and mobile screenshots, and inspect accessibility.
- Do not add dependencies unless the implementation clearly needs them.
`;
}

function baseGitignore(): string {
  return `node_modules
dist
build
.next
.env
.env.local
coverage
`;
}

const LOCAL_SCAFFOLD_GITIGNORE_ENTRIES = [
  "node_modules/",
  ".orianbuilder/",
  "dist/",
  "build/",
  ".env",
  ".env.local",
  "coverage/",
];

const EXPO_GITIGNORE_ENTRIES = [
  ".expo/",
  ".expo-shared/",
  "android/",
  "ios/",
  "web-build/",
  "native-download-site/",
  "expo-env.d.ts",
  "nativewind-env.d.ts",
];

async function mergeGitignoreEntries(
  rootPath: string,
  entries: string[],
): Promise<void> {
  const gitignorePath = path.join(rootPath, ".gitignore");
  let current = "";
  try {
    current = await fs.readFile(gitignorePath, "utf8");
  } catch {
    current = "";
  }

  const existing = new Set(
    current
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  );
  const missing = entries.filter((entry) => !existing.has(entry));
  if (missing.length === 0) return;

  const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  await fs.writeFile(
    gitignorePath,
    `${current}${prefix}${missing.join("\n")}\n`,
    "utf8",
  );
}

async function rewriteExpoAppConfigForProject(
  rootPath: string,
  projectName: string,
): Promise<void> {
  const configPath = path.join(rootPath, "app.config.js");
  let content: string;
  try {
    content = await fs.readFile(configPath, "utf8");
  } catch {
    return;
  }

  const appName = JSON.stringify(projectName);
  const slugName = JSON.stringify(toPackageName(projectName));
  const androidPackage = JSON.stringify(
    `com.orianbuilder.${toAndroidPackageSegment(projectName)}`,
  );

  content = content
    .replace(/\bname:\s*["'][^"']*["']/, `name: ${appName}`)
    .replace(/\bslug:\s*["'][^"']*["']/, `slug: ${slugName}`);

  if (/\bpackage:\s*["'][^"']*["']/.test(content)) {
    content = content.replace(
      /\bpackage:\s*["'][^"']*["']/,
      `package: ${androidPackage}`,
    );
  } else if (/\bandroid:\s*{/.test(content)) {
    content = content.replace(
      /(\bandroid:\s*{\s*)/,
      `$1\n      package: ${androidPackage},`,
    );
  }

  await fs.writeFile(configPath, content, "utf8");
}

function viteReactTsFiles(
  projectName: string,
  packageManager: GreenfieldPackageManager,
): ProjectFile[] {
  return [
    {
      path: "package.json",
      content: json({
        name: toPackageName(projectName),
        private: true,
        version: "0.1.0",
        type: "module",
        packageManager: packageManagerSpec(packageManager),
        scripts: {
          dev: "vite",
          build: "tsc -b && vite build",
          preview: "vite preview",
          typecheck: "tsc -b --noEmit",
        },
        dependencies: {
          "@vitejs/plugin-react": "^4.3.4",
          vite: "^5.4.17",
          typescript: "^5.8.3",
          react: "^19.0.0",
          "react-dom": "^19.0.0",
        },
        devDependencies: {
          "@types/react": "^19.0.10",
          "@types/react-dom": "^19.0.4",
        },
      }),
    },
    {
      path: "index.html",
      content: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${projectName}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
    },
    {
      path: "src/main.tsx",
      content: `import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
`,
    },
    {
      path: "src/App.tsx",
      content: `export default function App() {
  return (
    <main className="app-shell">
      <section className="panel">
        <p className="eyebrow">Ready to build</p>
        <h1>${projectName}</h1>
        <p>
          This project is initialized with React, TypeScript, and Vite. Replace
          this screen with the product workflow the user asked for.
        </p>
      </section>
    </main>
  );
}
`,
    },
    {
      path: "src/styles.css",
      content: `* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family:
    Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
    sans-serif;
  color: #16181d;
  background: #f5f7fb;
}

.app-shell {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 32px;
}

.panel {
  width: min(100%, 720px);
  padding: 32px;
  border: 1px solid #d9e1ec;
  border-radius: 8px;
  background: #ffffff;
}

.eyebrow {
  margin: 0 0 12px;
  color: #46618c;
  font-size: 0.78rem;
  font-weight: 700;
  letter-spacing: 0;
  text-transform: uppercase;
}

h1 {
  margin: 0 0 16px;
  font-size: clamp(2rem, 4vw, 3.25rem);
  letter-spacing: 0;
}

p {
  max-width: 62ch;
  line-height: 1.6;
}
`,
    },
    {
      path: "tsconfig.json",
      content: json({
        compilerOptions: {
          target: "ES2020",
          useDefineForClassFields: true,
          lib: ["ES2020", "DOM", "DOM.Iterable"],
          allowJs: false,
          skipLibCheck: true,
          esModuleInterop: true,
          allowSyntheticDefaultImports: true,
          strict: true,
          forceConsistentCasingInFileNames: true,
          module: "ESNext",
          moduleResolution: "Node",
          resolveJsonModule: true,
          isolatedModules: true,
          noEmit: true,
          jsx: "react-jsx",
        },
        include: ["src"],
        references: [],
      }),
    },
    {
      path: "vite.config.ts",
      content: `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
});
`,
    },
    { path: ".gitignore", content: baseGitignore() },
    { path: "AI_RULES.md", content: aiRules("vite-react-ts") },
  ];
}

function nextTsFiles(
  projectName: string,
  packageManager: GreenfieldPackageManager,
): ProjectFile[] {
  return [
    {
      path: "package.json",
      content: json({
        name: toPackageName(projectName),
        private: true,
        version: "0.1.0",
        packageManager: packageManagerSpec(packageManager),
        scripts: {
          dev: "next dev",
          build: "next build",
          start: "next start",
          typecheck: "tsc --noEmit",
        },
        dependencies: {
          next: "^15.0.0",
          react: "^19.0.0",
          "react-dom": "^19.0.0",
        },
        devDependencies: {
          typescript: "^5.8.3",
          "@types/node": "^22.14.0",
          "@types/react": "^19.0.10",
          "@types/react-dom": "^19.0.4",
        },
      }),
    },
    {
      path: "app/layout.tsx",
      content: `import "./globals.css";

export const metadata = {
  title: "${projectName}",
  description: "Built with Orian Builder",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`,
    },
    {
      path: "app/page.tsx",
      content: `export default function Home() {
  return (
    <main className="app-shell">
      <section className="panel">
        <p className="eyebrow">Ready to build</p>
        <h1>${projectName}</h1>
        <p>
          This project is initialized with Next.js and TypeScript. Replace this
          screen with the product workflow the user asked for.
        </p>
      </section>
    </main>
  );
}
`,
    },
    {
      path: "app/globals.css",
      content: `* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family:
    Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
    sans-serif;
  color: #16181d;
  background: #f5f7fb;
}

.app-shell {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 32px;
}

.panel {
  width: min(100%, 720px);
  padding: 32px;
  border: 1px solid #d9e1ec;
  border-radius: 8px;
  background: #ffffff;
}

.eyebrow {
  margin: 0 0 12px;
  color: #46618c;
  font-size: 0.78rem;
  font-weight: 700;
  letter-spacing: 0;
  text-transform: uppercase;
}

h1 {
  margin: 0 0 16px;
  font-size: clamp(2rem, 4vw, 3.25rem);
  letter-spacing: 0;
}

p {
  max-width: 62ch;
  line-height: 1.6;
}
`,
    },
    {
      path: "tsconfig.json",
      content: json({
        compilerOptions: {
          target: "ES2017",
          lib: ["dom", "dom.iterable", "esnext"],
          allowJs: true,
          skipLibCheck: true,
          strict: true,
          noEmit: true,
          esModuleInterop: true,
          module: "esnext",
          moduleResolution: "bundler",
          resolveJsonModule: true,
          isolatedModules: true,
          jsx: "preserve",
          incremental: true,
        },
        include: [
          "next-env.d.ts",
          "**/*.ts",
          "**/*.tsx",
          ".next/types/**/*.ts",
        ],
        exclude: ["node_modules"],
      }),
    },
    { path: "next.config.ts", content: `export default {};\n` },
    { path: ".gitignore", content: baseGitignore() },
    { path: "AI_RULES.md", content: aiRules("nextjs-ts") },
  ];
}

function nodeExpressTsFiles(
  projectName: string,
  packageManager: GreenfieldPackageManager,
): ProjectFile[] {
  return [
    {
      path: "package.json",
      content: json({
        name: toPackageName(projectName),
        private: true,
        version: "0.1.0",
        type: "module",
        packageManager: packageManagerSpec(packageManager),
        scripts: {
          dev: "tsx watch src/server.ts",
          start: "node dist/server.js",
          build: "tsc",
          typecheck: "tsc --noEmit",
        },
        dependencies: {
          express: "^4.19.2",
          cors: "^2.8.5",
        },
        devDependencies: {
          "@types/cors": "^2.8.17",
          "@types/express": "^4.17.21",
          "@types/node": "^22.14.0",
          tsx: "^4.19.2",
          typescript: "^5.8.3",
        },
      }),
    },
    {
      path: "src/server.ts",
      content: `import cors from "cors";
import express from "express";

const app = express();
const port = Number(process.env.PORT ?? 3000);

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "${toPackageName(projectName)}" });
});

app.listen(port, () => {
  console.log(\`Server listening on http://localhost:\${port}\`);
});
`,
    },
    {
      path: "tsconfig.json",
      content: json({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          outDir: "dist",
          rootDir: "src",
          strict: true,
          esModuleInterop: true,
          skipLibCheck: true,
          forceConsistentCasingInFileNames: true,
        },
        include: ["src"],
      }),
    },
    { path: ".env.example", content: "PORT=3000\n" },
    { path: ".gitignore", content: baseGitignore() },
    { path: "AI_RULES.md", content: aiRules("node-express-ts") },
  ];
}

function blankFiles(
  projectName: string,
  packageManager: GreenfieldPackageManager,
): ProjectFile[] {
  return [
    {
      path: "package.json",
      content: json({
        name: toPackageName(projectName),
        private: true,
        version: "0.1.0",
        packageManager: packageManagerSpec(packageManager),
        scripts: {},
      }),
    },
    { path: "AI_RULES.md", content: aiRules("blank") },
    { path: ".gitignore", content: baseGitignore() },
  ];
}

async function copyLocalScaffoldProject(params: {
  stack: GreenfieldProjectStack;
  rootPath: string;
  projectName: string;
  packageManager: GreenfieldPackageManager;
}) {
  const scaffoldDir = getLocalScaffoldDir(params.stack);
  if (!scaffoldDir) return false;

  await fs.cp(scaffoldDir, params.rootPath, {
    recursive: true,
    filter: (source) => path.basename(source) !== "node_modules",
  });

  const packageJsonPath = path.join(params.rootPath, "package.json");
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
  packageJson.name = toPackageName(params.projectName);
  packageJson.packageManager = packageManagerSpec(params.packageManager);
  await fs.writeFile(packageJsonPath, json(packageJson), "utf8");
  await mergeGitignoreEntries(params.rootPath, [
    ...LOCAL_SCAFFOLD_GITIGNORE_ENTRIES,
    ...(params.stack === "expo" ? EXPO_GITIGNORE_ENTRIES : []),
  ]);
  if (params.stack === "expo") {
    await rewriteExpoAppConfigForProject(params.rootPath, params.projectName);
  }
  return true;
}

export function getGreenfieldProjectFiles(
  stack: GreenfieldProjectStack,
  projectName: string,
  packageManager: GreenfieldPackageManager,
): ProjectFile[] {
  if (stack === "vite-react-ts") {
    return viteReactTsFiles(projectName, packageManager);
  }
  if (stack === "nextjs-ts") return nextTsFiles(projectName, packageManager);
  if (stack === "node-express-ts") {
    return nodeExpressTsFiles(projectName, packageManager);
  }
  return blankFiles(projectName, packageManager);
}

async function listBlockingEntries(rootPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(rootPath);
    return entries.filter((entry) => !IGNORED_EXISTING_ENTRIES.has(entry));
  } catch {
    return [];
  }
}

export async function createGreenfieldProject(
  options: CreateGreenfieldProjectOptions,
): Promise<CreateGreenfieldProjectResult> {
  const rootPath = path.resolve(options.rootPath);
  await fs.mkdir(rootPath, { recursive: true });

  const blockingEntries = await listBlockingEntries(rootPath);
  if (blockingEntries.length > 0 && !options.force) {
    const commands = getProjectVerificationCommands({
      stack: options.stack,
      packageManager: options.packageManager,
    });
    return {
      created: false,
      reason: `Project directory is not empty: ${blockingEntries.slice(0, 12).join(", ")}`,
      stack: options.stack,
      packageManager: options.packageManager,
      scaffoldMethod: options.scaffoldMethod ?? "starter_files",
      scaffoldCommand: null,
      files: [],
      nextSteps: [],
      commands,
      verificationPlan: [],
      output: null,
    };
  }

  const scaffoldMethod = options.scaffoldMethod ?? "starter_files";
  const scaffoldCommand =
    scaffoldMethod === "cli"
      ? getCliScaffoldCommand({
          stack: options.stack,
          packageManager: options.packageManager,
        })
      : null;
  const commands = getProjectVerificationCommands({
    stack: options.stack,
    packageManager: options.packageManager,
  });

  if (scaffoldMethod === "cli" && !scaffoldCommand) {
    return {
      created: false,
      reason: `No non-interactive CLI scaffold recipe is available for ${options.stack}.`,
      stack: options.stack,
      packageManager: options.packageManager,
      scaffoldMethod,
      scaffoldCommand,
      files: [],
      nextSteps: scaffoldCommand
        ? [scaffoldCommand, ...getVerificationPlan(commands)]
        : [],
      commands,
      verificationPlan: getVerificationPlan(commands),
      output: null,
    };
  }

  if (scaffoldMethod === "cli" && scaffoldCommand) {
    if (options.executeCli === false) {
      return {
        created: false,
        reason: "CLI scaffold execution was skipped.",
        stack: options.stack,
        packageManager: options.packageManager,
        scaffoldMethod,
        scaffoldCommand,
        files: [],
        nextSteps: [scaffoldCommand, ...getVerificationPlan(commands)],
        commands,
        verificationPlan: getVerificationPlan(commands),
        output: null,
      };
    }

    const cliResult = await runCliScaffold({
      command: scaffoldCommand,
      cwd: rootPath,
    });
    if (cliResult.exitCode !== 0) {
      return {
        created: false,
        reason: `CLI scaffold command failed with exit code ${cliResult.exitCode}.`,
        stack: options.stack,
        packageManager: options.packageManager,
        scaffoldMethod,
        scaffoldCommand,
        files: await listCreatedFiles(rootPath),
        nextSteps: [scaffoldCommand, ...getVerificationPlan(commands)],
        commands,
        verificationPlan: getVerificationPlan(commands),
        output: cliResult.output,
      };
    }

    const aiRulesPath = path.join(rootPath, "AI_RULES.md");
    try {
      await fs.writeFile(aiRulesPath, aiRules(options.stack), {
        encoding: "utf8",
        flag: "wx",
      });
    } catch {
      // Existing project rules from the scaffold should remain untouched.
    }

    const files = await listCreatedFiles(rootPath);
    return {
      created: true,
      reason: null,
      stack: options.stack,
      packageManager: options.packageManager,
      scaffoldMethod,
      scaffoldCommand,
      files,
      nextSteps: getVerificationPlan(commands),
      commands,
      verificationPlan: getVerificationPlan(commands),
      output: cliResult.output,
    };
  }

  if (
    await copyLocalScaffoldProject({
      stack: options.stack,
      rootPath,
      projectName: options.projectName,
      packageManager: options.packageManager,
    })
  ) {
    const files = await listCreatedFiles(rootPath);
    return {
      created: true,
      reason: null,
      stack: options.stack,
      packageManager: options.packageManager,
      scaffoldMethod,
      scaffoldCommand,
      files,
      nextSteps: getVerificationPlan(commands),
      commands,
      verificationPlan: getVerificationPlan(commands),
      output: null,
    };
  }

  const files = getGreenfieldProjectFiles(
    options.stack,
    options.projectName,
    options.packageManager,
  );
  for (const file of files) {
    const fullPath = path.join(rootPath, file.path);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(
      fullPath,
      file.content,
      options.force
        ? "utf8"
        : {
            encoding: "utf8",
            flag: "wx",
          },
    );
  }

  return {
    created: true,
    reason: null,
    stack: options.stack,
    packageManager: options.packageManager,
    scaffoldMethod,
    scaffoldCommand,
    files: files.map((file) => file.path),
    nextSteps: getVerificationPlan(commands),
    commands,
    verificationPlan: getVerificationPlan(commands),
    output: null,
  };
}
