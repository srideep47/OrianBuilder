import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { detectProjectStack } from "@/ipc/utils/project_stack_detector";
import { createMissionArtifact } from "@/ipc/utils/mission_utils";
import {
  AgentContext,
  escapeXmlAttr,
  escapeXmlContent,
  ToolDefinition,
} from "./types";
import {
  ANDROID_STUDIO_JBR_DEFAULT,
  findUsableNdkVersion,
  resolveAndroidSdkRoot,
} from "./android_env";

const packageNativeArtifactSchema = z.object({
  target: z
    .enum(["auto", "android_apk", "electron_desktop"])
    .optional()
    .default("auto")
    .describe(
      "Native artifact to produce. Use android_apk for Android/Expo/Capacitor apps, electron_desktop for Electron desktop apps, or auto to infer from project files.",
    ),
  variant: z
    .enum(["debug", "release"])
    .optional()
    .default("debug")
    .describe(
      "Android build variant. Debug is unsigned and best for quick downloadable QA; release requires signing configuration.",
    ),
  initialize_capacitor_if_missing: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "For Android targets, initialize Capacitor and add the Android platform when the project is a web app without native Android files yet.",
    ),
  app_id: z
    .string()
    .optional()
    .describe(
      "Android application id to use if Capacitor needs to be initialized, for example com.example.myapp.",
    ),
  app_name: z
    .string()
    .optional()
    .describe(
      "Native app display name to use if Capacitor needs to be initialized.",
    ),
  create_download_site: z
    .boolean()
    .optional()
    .default(true)
    .describe(
      "Create a static download site in native-download-site/ and copy artifacts into it.",
    ),
  timeout_seconds: z
    .number()
    .min(30)
    .max(1800)
    .optional()
    .default(900)
    .describe("Maximum seconds allowed per packaging command."),
});

type PackageNativeArtifactArgs = z.infer<typeof packageNativeArtifactSchema>;

type CommandResult = {
  command: string;
  cwd: string;
  exitCode: number;
  output: string;
};

type NativeTarget = "android_apk" | "electron_desktop";

type Artifact = {
  path: string;
  sizeBytes: number;
};

type NativePackageResult = {
  artifacts: Artifact[];
  commands: CommandResult[];
  warning?: string;
};

const MAX_OUTPUT_CHARS = 18_000;
const ANDROID_SDK_MISSING_MESSAGE =
  "Android SDK not detected. Set ANDROID_HOME or install Android Studio, then retry. Alternatively, configure EAS cloud build (run `npx eas build:configure`).";

const SCAFFOLD_PLACEHOLDER_PATTERNS = [
  /⚠\s*PLACEHOLDER/i,
  /scaffold starter screen/i,
  /Replace app\/index\.tsx/i,
  /Edit app\/index\.tsx to build/i,
];

async function assertNotScaffoldPlaceholder(appPath: string): Promise<void> {
  const indexPath = path.join(appPath, "app", "index.tsx");
  let content: string;
  try {
    content = await fs.readFile(indexPath, "utf-8");
  } catch {
    return;
  }
  const matched = SCAFFOLD_PLACEHOLDER_PATTERNS.find((pattern) =>
    pattern.test(content),
  );
  if (matched) {
    throw new Error(
      "Refusing to package: app/index.tsx is still the unimplemented scaffold placeholder. " +
        "Write the requested content to app/index.tsx (use read_file then write_file or search_replace) " +
        "and re-run browser_qa_gate before calling package_native_artifact again.",
    );
  }
}

function truncateOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) return output;
  const half = Math.floor(MAX_OUTPUT_CHARS / 2);
  return `${output.slice(0, half)}\n\n... [native package output truncated] ...\n\n${output.slice(-half)}`;
}

function commandForPackageManager(packageManager: string, script: string) {
  if (packageManager === "pnpm") return `pnpm ${script}`;
  if (packageManager === "yarn") return `yarn ${script}`;
  if (packageManager === "bun") return `bun run ${script}`;
  return `npm run ${script}`;
}

function execForPackageManager(
  packageManager: string,
  binary: string,
  args: string,
) {
  if (packageManager === "pnpm") return `pnpm exec ${binary} ${args}`;
  if (packageManager === "yarn") return `yarn ${binary} ${args}`;
  if (packageManager === "bun") return `bunx ${binary} ${args}`;
  return `npx ${binary} ${args}`;
}

function installForPackageManager(packageManager: string, packages: string[]) {
  const joined = packages.join(" ");
  if (packageManager === "pnpm") return `pnpm add ${joined}`;
  if (packageManager === "yarn") return `yarn add ${joined}`;
  if (packageManager === "bun") return `bun add ${joined}`;
  return `npm install ${joined} --legacy-peer-deps`;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath: string): Promise<Record<string, any> | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf-8")) as Record<
      string,
      any
    >;
  } catch {
    return null;
  }
}

async function runCommand(input: {
  command: string;
  cwd: string;
  timeoutMs: number;
  ctx: AgentContext;
  env?: NodeJS.ProcessEnv;
}): Promise<CommandResult> {
  input.ctx.onXmlStream(
    `<orianbuilder-native-package status="running" command="${escapeXmlAttr(input.command)}">Running ${escapeXmlContent(input.command)}...`,
  );

  return await new Promise((resolve) => {
    let output = "";
    let completed = false;
    const child = spawn(input.command, [], {
      cwd: input.cwd,
      shell: true,
      stdio: "pipe",
      env: { ...process.env, ...input.env },
      windowsHide: true,
    });

    const append = (chunk: Buffer) => {
      output += chunk.toString();
    };

    const timer = setTimeout(() => {
      if (completed) return;
      completed = true;
      child.kill("SIGKILL");
      resolve({
        command: input.command,
        cwd: input.cwd,
        exitCode: 124,
        output: truncateOutput(`${output}\n[Timed out]`),
      });
    }, input.timeoutMs);

    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("close", (code) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      resolve({
        command: input.command,
        cwd: input.cwd,
        exitCode: code ?? 0,
        output: truncateOutput(output),
      });
    });
    child.on("error", (error) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      resolve({
        command: input.command,
        cwd: input.cwd,
        exitCode: 1,
        output: truncateOutput(`${output}\n[spawn error] ${error.message}`),
      });
    });
  });
}

function ensureSuccessful(result: CommandResult) {
  if (result.exitCode !== 0) {
    throw new Error(
      `Command failed with exit code ${result.exitCode}: ${result.command}\n\n${result.output}`,
    );
  }
}

function toJavaPropertiesPath(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
}

function upsertJavaProperty(
  content: string,
  key: string,
  value: string,
): string {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${escapedKey}=.*$`, "m");
  if (pattern.test(content)) {
    return content.replace(pattern, line);
  }
  const prefix = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
  return `${content}${prefix}${line}\n`;
}

async function patchAndroidNdkVersion(
  appPath: string,
  ndkVersion: string,
): Promise<void> {
  const appBuildGradlePath = path.join(
    appPath,
    "android",
    "app",
    "build.gradle",
  );
  let content: string;
  try {
    content = await fs.readFile(appBuildGradlePath, "utf-8");
  } catch {
    return;
  }

  const replacement = `ndkVersion "${ndkVersion}"`;
  const updated = content
    .replace(/ndkVersion\s+rootProject\.ext\.ndkVersion/, replacement)
    .replace(/ndkVersion\s+["'][^"']+["']/, replacement);
  if (updated !== content) {
    await fs.writeFile(appBuildGradlePath, updated, "utf-8");
  }
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 40);
}

export async function ensureExpoAndroidPackage(
  appPath: string,
  appId: string,
): Promise<void> {
  const appJsonPath = path.join(appPath, "app.json");
  const appJson = await readJson(appJsonPath);
  if (appJson) {
    const expoConfig =
      typeof appJson.expo === "object" && appJson.expo !== null
        ? (appJson.expo as Record<string, any>)
        : appJson;
    const androidConfig =
      typeof expoConfig.android === "object" && expoConfig.android !== null
        ? (expoConfig.android as Record<string, any>)
        : {};
    if (androidConfig.package !== appId) {
      androidConfig.package = appId;
      expoConfig.android = androidConfig;
      await fs.writeFile(appJsonPath, `${JSON.stringify(appJson, null, 2)}\n`);
    }
    return;
  }

  const appConfigPath = path.join(appPath, "app.config.js");
  let content: string;
  try {
    content = await fs.readFile(appConfigPath, "utf-8");
  } catch {
    return;
  }

  const packageLiteral = JSON.stringify(appId);
  if (/\bpackage:\s*["'][^"']*["']/.test(content)) {
    content = content.replace(
      /\bpackage:\s*["'][^"']*["']/,
      `package: ${packageLiteral}`,
    );
  } else if (/\bandroid:\s*{/.test(content)) {
    content = content.replace(
      /(\bandroid:\s*{\s*)/,
      `$1\n      package: ${packageLiteral},`,
    );
  } else if (/\bexpo:\s*{/.test(content)) {
    content = content.replace(
      /(\bexpo:\s*{\s*)/,
      `$1\n    android: {\n      package: ${packageLiteral},\n    },`,
    );
  }

  await fs.writeFile(appConfigPath, content, "utf-8");
}

async function ensureAndroidLocalEnvironment(
  appPath: string,
  sdkRoot?: string | null,
) {
  const androidPath = path.join(appPath, "android");
  const localPropertiesPath = path.join(androidPath, "local.properties");
  const gradlePropertiesPath = path.join(androidPath, "gradle.properties");
  const resolvedSdkDir = sdkRoot ?? (await resolveAndroidSdkRoot());
  if (resolvedSdkDir) {
    const localProperties = (await exists(localPropertiesPath))
      ? await fs.readFile(localPropertiesPath, "utf-8")
      : "";
    const updatedLocalProperties = upsertJavaProperty(
      localProperties,
      "sdk.dir",
      toJavaPropertiesPath(resolvedSdkDir),
    );
    if (updatedLocalProperties !== localProperties) {
      await fs.writeFile(localPropertiesPath, updatedLocalProperties, "utf-8");
    }
    const ndkVersion = await findUsableNdkVersion(resolvedSdkDir);
    if (ndkVersion) {
      const gradleProperties = (await exists(gradlePropertiesPath))
        ? await fs.readFile(gradlePropertiesPath, "utf-8")
        : "";
      const updatedGradleProperties = upsertJavaProperty(
        upsertJavaProperty(gradleProperties, "android.ndkVersion", ndkVersion),
        "ndkVersion",
        ndkVersion,
      );
      if (updatedGradleProperties !== gradleProperties) {
        await fs.writeFile(
          gradlePropertiesPath,
          updatedGradleProperties,
          "utf-8",
        );
      }
      await patchAndroidNdkVersion(appPath, ndkVersion);
    }
  }

  if (await exists(ANDROID_STUDIO_JBR_DEFAULT)) {
    const current = (await exists(gradlePropertiesPath))
      ? await fs.readFile(gradlePropertiesPath, "utf-8")
      : "";
    if (!current.includes("org.gradle.java.home=")) {
      await fs.appendFile(
        gradlePropertiesPath,
        `${current.endsWith("\n") || current.length === 0 ? "" : "\n"}org.gradle.java.home=${toJavaPropertiesPath(ANDROID_STUDIO_JBR_DEFAULT)}\n`,
      );
    }
  }

  if (process.platform === "win32" && (await exists(gradlePropertiesPath))) {
    const current = await fs.readFile(gradlePropertiesPath, "utf-8");
    const updated = current.replace(
      /^newArchEnabled=true$/m,
      "newArchEnabled=false",
    );
    if (updated !== current) {
      await fs.writeFile(gradlePropertiesPath, updated, "utf-8");
    }
  }
}

async function findFiles(input: {
  root: string;
  extensions: Set<string>;
  maxDepth?: number;
}): Promise<Artifact[]> {
  const results: Artifact[] = [];
  const maxDepth = input.maxDepth ?? 8;

  async function walk(directory: string, depth: number) {
    if (depth > maxDepth) return;
    let entries: Array<{ name: string; isDirectory: () => boolean }>;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        await walk(fullPath, depth + 1);
      } else if (input.extensions.has(path.extname(entry.name))) {
        const stat = await fs.stat(fullPath);
        results.push({ path: fullPath, sizeBytes: stat.size });
      }
    }
  }

  await walk(input.root, 0);
  return results.sort((a, b) => b.sizeBytes - a.sizeBytes);
}

async function inferTarget(appPath: string): Promise<NativeTarget> {
  if (
    (await exists(path.join(appPath, "capacitor.config.ts"))) ||
    (await exists(path.join(appPath, "capacitor.config.js"))) ||
    (await exists(path.join(appPath, "android")))
  ) {
    return "android_apk";
  }
  const packageJson = await readJson(path.join(appPath, "package.json"));
  const deps = {
    ...packageJson?.dependencies,
    ...packageJson?.devDependencies,
  };
  if (
    deps.electron ||
    deps["@electron-forge/cli"] ||
    deps["electron-builder"]
  ) {
    return "electron_desktop";
  }
  return "android_apk";
}

async function packageAndroid(input: {
  args: PackageNativeArtifactArgs;
  ctx: AgentContext;
  timeoutMs: number;
}): Promise<NativePackageResult> {
  await assertNotScaffoldPlaceholder(input.ctx.appPath);

  const commands: CommandResult[] = [];
  const stack = await detectProjectStack(input.ctx.appPath);
  const packageJson = await readJson(
    path.join(input.ctx.appPath, "package.json"),
  );
  const packageManager = stack.packageManager || "npm";
  const appName =
    input.args.app_name ||
    (typeof packageJson?.name === "string" ? packageJson.name : "Android App");
  const appId =
    input.args.app_id ||
    `com.orianbuilder.${slug(appName) || `app${input.ctx.appId}`}`;

  const deps = {
    ...packageJson?.dependencies,
    ...packageJson?.devDependencies,
  };
  const hasCapacitor = await exists(
    path.join(input.ctx.appPath, "capacitor.config.ts"),
  );
  const hasAndroid = await exists(path.join(input.ctx.appPath, "android"));
  const hasAndroidGradle = await exists(
    path.join(
      input.ctx.appPath,
      "android",
      process.platform === "win32" ? "gradlew.bat" : "gradlew",
    ),
  );
  const isExpoProject = stack.framework === "expo" || Boolean(deps.expo);
  const isReactNativeProject =
    stack.framework === "react-native" || Boolean(deps["react-native"]);
  const androidSdkRoot = await resolveAndroidSdkRoot();

  if (!androidSdkRoot) {
    return {
      artifacts: [],
      commands,
      warning: ANDROID_SDK_MISSING_MESSAGE,
    };
  }

  if (isExpoProject) {
    await ensureExpoAndroidPackage(input.ctx.appPath, appId);

    if (!hasAndroid || !hasAndroidGradle) {
      const prebuild = await runCommand({
        command: execForPackageManager(
          packageManager,
          "expo",
          "prebuild --platform android --clean",
        ),
        cwd: input.ctx.appPath,
        timeoutMs: input.timeoutMs,
        ctx: input.ctx,
        env: {
          ANDROID_HOME: androidSdkRoot,
          ANDROID_SDK_ROOT: androidSdkRoot,
          CI: "1",
          EXPO_NO_TELEMETRY: "1",
        },
      });
      commands.push(prebuild);
      ensureSuccessful(prebuild);
    }

    await ensureAndroidLocalEnvironment(input.ctx.appPath, androidSdkRoot);
    const gradleCommand =
      process.platform === "win32"
        ? ".\\gradlew.bat assembleDebug"
        : "./gradlew assembleDebug";
    const gradle = await runCommand({
      command:
        input.args.variant === "release"
          ? gradleCommand.replace("assembleDebug", "assembleRelease")
          : gradleCommand,
      cwd: path.join(input.ctx.appPath, "android"),
      timeoutMs: input.timeoutMs,
      ctx: input.ctx,
      env: {
        ANDROID_HOME: androidSdkRoot,
        ANDROID_SDK_ROOT: androidSdkRoot,
        NODE_ENV: "production",
      },
    });
    commands.push(gradle);
    ensureSuccessful(gradle);

    const apkRoot = path.join(
      input.ctx.appPath,
      "android",
      "app",
      "build",
      "outputs",
      "apk",
    );
    const artifacts = await findFiles({
      root: apkRoot,
      extensions: new Set([".apk"]),
    });
    return { artifacts, commands };
  }

  if (isReactNativeProject && hasAndroid && !hasCapacitor) {
    await ensureAndroidLocalEnvironment(input.ctx.appPath, androidSdkRoot);
    const gradleCommand =
      process.platform === "win32"
        ? ".\\gradlew.bat assembleDebug"
        : "./gradlew assembleDebug";
    const gradle = await runCommand({
      command:
        input.args.variant === "release"
          ? gradleCommand.replace("assembleDebug", "assembleRelease")
          : gradleCommand,
      cwd: path.join(input.ctx.appPath, "android"),
      timeoutMs: input.timeoutMs,
      ctx: input.ctx,
      env: {
        ANDROID_HOME: androidSdkRoot,
        ANDROID_SDK_ROOT: androidSdkRoot,
      },
    });
    commands.push(gradle);
    ensureSuccessful(gradle);

    const apkRoot = path.join(
      input.ctx.appPath,
      "android",
      "app",
      "build",
      "outputs",
      "apk",
    );
    const artifacts = await findFiles({
      root: apkRoot,
      extensions: new Set([".apk"]),
    });
    return { artifacts, commands };
  }

  if (!hasCapacitor && input.args.initialize_capacitor_if_missing !== false) {
    const install = await runCommand({
      command: installForPackageManager(packageManager, [
        "@capacitor/core@7.4.4",
        "@capacitor/cli@7.4.4",
        "@capacitor/android@7.4.4",
      ]),
      cwd: input.ctx.appPath,
      timeoutMs: input.timeoutMs,
      ctx: input.ctx,
    });
    commands.push(install);
    ensureSuccessful(install);

    const init = await runCommand({
      command: `npx cap init ${JSON.stringify(appName)} ${JSON.stringify(appId)} --web-dir=dist`,
      cwd: input.ctx.appPath,
      timeoutMs: input.timeoutMs,
      ctx: input.ctx,
    });
    commands.push(init);
    ensureSuccessful(init);
  }

  const buildCommand =
    stack.commands.build || commandForPackageManager(packageManager, "build");
  const build = await runCommand({
    command: buildCommand,
    cwd: input.ctx.appPath,
    timeoutMs: input.timeoutMs,
    ctx: input.ctx,
  });
  commands.push(build);
  ensureSuccessful(build);

  if (!hasAndroid && input.args.initialize_capacitor_if_missing !== false) {
    const addAndroid = await runCommand({
      command: "npx cap add android",
      cwd: input.ctx.appPath,
      timeoutMs: input.timeoutMs,
      ctx: input.ctx,
    });
    commands.push(addAndroid);
    ensureSuccessful(addAndroid);
  }

  const sync = await runCommand({
    command: "npx cap sync android",
    cwd: input.ctx.appPath,
    timeoutMs: input.timeoutMs,
    ctx: input.ctx,
  });
  commands.push(sync);
  ensureSuccessful(sync);

  await ensureAndroidLocalEnvironment(input.ctx.appPath, androidSdkRoot);
  const gradleCommand =
    process.platform === "win32"
      ? ".\\gradlew.bat assembleDebug"
      : "./gradlew assembleDebug";
  const gradle = await runCommand({
    command:
      input.args.variant === "release"
        ? gradleCommand.replace("assembleDebug", "assembleRelease")
        : gradleCommand,
    cwd: path.join(input.ctx.appPath, "android"),
    timeoutMs: input.timeoutMs,
    ctx: input.ctx,
    env: {
      ANDROID_HOME: androidSdkRoot,
      ANDROID_SDK_ROOT: androidSdkRoot,
    },
  });
  commands.push(gradle);
  ensureSuccessful(gradle);

  const apkRoot = path.join(
    input.ctx.appPath,
    "android",
    "app",
    "build",
    "outputs",
    "apk",
  );
  const artifacts = await findFiles({
    root: apkRoot,
    extensions: new Set([".apk"]),
  });
  return { artifacts, commands };
}

async function packageElectron(input: {
  ctx: AgentContext;
  timeoutMs: number;
}): Promise<NativePackageResult> {
  const packageJson = await readJson(
    path.join(input.ctx.appPath, "package.json"),
  );
  const scripts = packageJson?.scripts ?? {};
  const stack = await detectProjectStack(input.ctx.appPath);
  const packageManager = stack.packageManager || "npm";
  const scriptName =
    (typeof scripts.make === "string" && "make") ||
    (typeof scripts.package === "string" && "package") ||
    (typeof scripts.dist === "string" && "dist") ||
    (typeof scripts["build:electron"] === "string" && "build:electron") ||
    (typeof scripts.build === "string" && "build");

  if (!scriptName) {
    throw new Error(
      "No Electron packaging script found. Add a package/make/dist/build script first.",
    );
  }

  const command = commandForPackageManager(packageManager, scriptName);
  const result = await runCommand({
    command,
    cwd: input.ctx.appPath,
    timeoutMs: input.timeoutMs,
    ctx: input.ctx,
  });
  ensureSuccessful(result);

  const artifactRoots = ["out", "release", "dist", "dist_electron"].map((dir) =>
    path.join(input.ctx.appPath, dir),
  );
  const artifactLists = await Promise.all(
    artifactRoots.map((root) =>
      findFiles({
        root,
        extensions: new Set([
          ".exe",
          ".msi",
          ".dmg",
          ".zip",
          ".AppImage",
          ".deb",
          ".rpm",
        ]),
      }),
    ),
  );

  return {
    artifacts: artifactLists.flat(),
    commands: [result],
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function createDownloadSite(input: {
  appPath: string;
  target: NativeTarget;
  artifacts: Artifact[];
}): Promise<string> {
  const sitePath = path.join(input.appPath, "native-download-site");
  const downloadsPath = path.join(sitePath, "downloads");
  await fs.rm(sitePath, { recursive: true, force: true });
  await fs.mkdir(downloadsPath, { recursive: true });

  const links: Array<{ name: string; relativePath: string; size: string }> = [];
  for (const artifact of input.artifacts) {
    const fileName = path.basename(artifact.path);
    const targetPath = path.join(downloadsPath, fileName);
    await fs.copyFile(artifact.path, targetPath);
    links.push({
      name: fileName,
      relativePath: `downloads/${fileName}`,
      size: formatBytes(artifact.sizeBytes),
    });
  }

  const platformLabel =
    input.target === "android_apk" ? "Android APK" : "Desktop app";
  const primary = links[0];
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(platformLabel)} Download</title>
    <style>
      :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f4f7fb; color: #151923; }
      main { width: min(92vw, 680px); padding: 32px; background: #fff; border: 1px solid #d8e0eb; border-radius: 8px; box-shadow: 0 24px 70px rgba(31, 41, 55, .12); }
      h1 { margin: 0 0 10px; font-size: clamp(2rem, 5vw, 3rem); letter-spacing: 0; }
      p { margin: 0 0 24px; color: #5d6878; line-height: 1.6; }
      a.primary { display: inline-flex; align-items: center; justify-content: center; min-height: 48px; padding: 0 20px; border-radius: 8px; background: #111827; color: white; text-decoration: none; font-weight: 700; }
      ul { margin: 24px 0 0; padding: 0; list-style: none; display: grid; gap: 10px; }
      li { display: flex; justify-content: space-between; gap: 16px; padding: 12px 0; border-top: 1px solid #e5eaf1; }
      li a { color: #1d4ed8; font-weight: 650; text-decoration: none; }
      .size { color: #6b7280; white-space: nowrap; }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(platformLabel)}</h1>
      <p>Download the latest generated build artifact.</p>
      ${
        primary
          ? `<a class="primary" href="${escapeHtml(primary.relativePath)}" download>Download ${escapeHtml(primary.name)}</a>`
          : ""
      }
      <ul>
        ${links
          .map(
            (link) =>
              `<li><a href="${escapeHtml(link.relativePath)}" download>${escapeHtml(link.name)}</a><span class="size">${escapeHtml(link.size)}</span></li>`,
          )
          .join("\n        ")}
      </ul>
    </main>
  </body>
</html>
`;

  await fs.writeFile(path.join(sitePath, "index.html"), html, "utf-8");
  await fs.writeFile(
    path.join(sitePath, "package.json"),
    JSON.stringify(
      {
        private: true,
        scripts: {
          deploy: "vercel deploy --prod",
        },
      },
      null,
      2,
    ) + "\n",
    "utf-8",
  );
  await fs.writeFile(
    path.join(sitePath, "vercel.json"),
    JSON.stringify({ cleanUrls: true }, null, 2) + "\n",
    "utf-8",
  );
  return sitePath;
}

export const packageNativeArtifactTool: ToolDefinition<PackageNativeArtifactArgs> =
  {
    name: "package_native_artifact",
    description: `Build native distribution artifacts for the current app and optionally create a static download site.

Use this after implementation, project checks, and browser QA pass when the user asks for an Android APK, desktop installer, native app build, or downloadable hosted artifact.

Android flow:
- Expo projects run Expo prebuild, then Gradle, and collect APK files.
- Web projects use Capacitor when allowed, then run the web build, sync Android assets, run Gradle, and collect APK files.
- If Android SDK/JDK paths are available locally, writes project-local Gradle config so the build can complete. If the Android SDK is missing, reports the setup action instead of running Gradle.

Electron flow:
- Runs the existing package/make/dist/build script and collects common installer/archive outputs.

After this tool creates native-download-site/, use deploy_preview with provider custom_command or another supported provider to host that folder, for example a Vercel CLI deployment from native-download-site.`,
    inputSchema: packageNativeArtifactSchema,
    defaultConsent: "ask",
    modifiesState: true,

    getConsentPreview: (args) =>
      `Package native artifact: ${args.target ?? "auto"}${args.create_download_site === false ? "" : " and create download site"}`,

    buildXml: (args, isComplete) => {
      if (isComplete) return undefined;
      return `<orianbuilder-native-package target="${escapeXmlAttr(args.target ?? "auto")}" status="running">Packaging native artifact...`;
    },

    execute: async (args, ctx) => {
      const timeoutMs = (args.timeout_seconds ?? 900) * 1000;
      const target =
        args.target === "auto" || !args.target
          ? await inferTarget(ctx.appPath)
          : args.target;

      if (target === "android_apk") {
        // Reject when the Expo project was scaffolded but app/index.tsx was
        // never written this turn — this is the most common skip-the-impl bug.
        const indexKey = "app/index.tsx";
        const indexExistsPromise = fs
          .access(path.join(ctx.appPath, indexKey))
          .then(() => true)
          .catch(() => false);
        const indexExists = await indexExistsPromise;
        if (
          indexExists &&
          ctx.runState.createdProjectThisTurn &&
          !ctx.runState.filesWrittenSinceCreateProject.has(indexKey)
        ) {
          ctx.appendUserMessage([
            {
              type: "text",
              text:
                "[gate] You called package_native_artifact without ever writing app/index.tsx after create_project. " +
                "Your VERY NEXT tool call MUST be read_file({path: 'app/index.tsx'}). " +
                "Then write the actual UI content with write_file. Then call browser_qa_gate. " +
                "Only after QA reports status=passed can you call package_native_artifact.",
            },
          ]);
          throw new Error(
            "Refusing to package: app/index.tsx was never written since create_project. " +
              "Required sequence: read_file('app/index.tsx') → write_file (real UI) → browser_qa_gate (status=passed) → package_native_artifact.",
          );
        }

        if (ctx.runState.lastBrowserQaStatus === null) {
          ctx.appendUserMessage([
            {
              type: "text",
              text:
                "[gate] You called package_native_artifact before running browser_qa_gate. " +
                "Run browser_qa_gate first and verify status=passed before packaging.",
            },
          ]);
          throw new Error(
            "Refusing to package: browser_qa_gate has not been run since the last edit. " +
              "Implement the requested content in app/index.tsx, then call browser_qa_gate and verify status=passed before calling package_native_artifact.",
          );
        }
        if (ctx.runState.lastBrowserQaStatus === "failed") {
          const placeholderHint = ctx.runState.lastBrowserQaPlaceholderDetected
            ? " The previous QA reported the unimplemented scaffold placeholder is still showing — write the requested content to app/index.tsx first."
            : "";
          ctx.appendUserMessage([
            {
              type: "text",
              text:
                "[gate] Last browser_qa_gate failed." +
                placeholderHint +
                " Fix the issues, then re-run browser_qa_gate. Do not call package_native_artifact until QA passes.",
            },
          ]);
          throw new Error(
            "Refusing to package: the most recent browser_qa_gate failed." +
              placeholderHint +
              " Fix the issues, re-run browser_qa_gate until status=passed, then call package_native_artifact again.",
          );
        }
      }

      ctx.emitProgress?.({
        id: "package_native",
        label:
          target === "android_apk"
            ? "Building Android APK"
            : "Building desktop installer",
        status: "in-progress",
      });

      let result;
      try {
        result =
          target === "android_apk"
            ? await packageAndroid({ args, ctx, timeoutMs })
            : await packageElectron({ ctx, timeoutMs });
      } catch (err) {
        ctx.emitProgress?.({
          id: "package_native",
          label: "Native packaging failed",
          status: "failed",
        });
        throw err;
      }
      ctx.emitProgress?.({
        id: "package_native",
        label: result.warning
          ? "Native packaging finished with warnings"
          : "Native artifact built",
        status: result.warning ? "failed" : "completed",
      });

      if (result.warning) {
        const commandLines =
          result.commands.length > 0
            ? result.commands.map(
                (command) =>
                  `- ${command.command} [exit ${command.exitCode}]${command.output.trim() ? `\n${command.output.trim().slice(-1200)}` : ""}`,
              )
            : ["- (no packaging commands were run)"];
        const summary = [
          `Native package target: ${target}`,
          "",
          result.warning,
          "",
          "Commands:",
          ...commandLines,
        ].join("\n");

        ctx.onWarningMessage?.(result.warning);
        ctx.onXmlComplete(
          `<orianbuilder-native-package target="${escapeXmlAttr(target)}" status="warning" artifact-count="0" download-site="" error="${escapeXmlAttr(result.warning)}">${escapeXmlContent(summary)}</orianbuilder-native-package>`,
        );
        return summary;
      }

      if (result.artifacts.length === 0) {
        throw new Error(`No native artifacts were found for ${target}.`);
      }

      const downloadSitePath =
        args.create_download_site === false
          ? null
          : await createDownloadSite({
              appPath: ctx.appPath,
              target,
              artifacts: result.artifacts,
            });

      await Promise.all(
        result.artifacts.map((artifact) =>
          createMissionArtifact({
            missionId: ctx.missionId,
            runId: ctx.missionRunId,
            artifactType: "runtime",
            title:
              target === "android_apk"
                ? "Android APK"
                : "Native desktop artifact",
            uri: path.relative(ctx.appPath, artifact.path).replace(/\\/g, "/"),
            body: `${path.basename(artifact.path)} (${formatBytes(artifact.sizeBytes)})`,
            mimeType:
              target === "android_apk"
                ? "application/vnd.android.package-archive"
                : "application/octet-stream",
            metadata: {
              source: "package_native_artifact",
              target,
              sizeBytes: artifact.sizeBytes,
            },
          }),
        ),
      );
      if (downloadSitePath) {
        await createMissionArtifact({
          missionId: ctx.missionId,
          runId: ctx.missionRunId,
          artifactType: "runtime",
          title: "Native download site",
          uri: path.relative(ctx.appPath, downloadSitePath).replace(/\\/g, "/"),
          body: "Static download page generated for native artifacts.",
          mimeType: "text/html",
          metadata: {
            source: "package_native_artifact",
            target,
          },
        });
      }

      const artifactLines = result.artifacts.map(
        (artifact) =>
          `- ${path.relative(ctx.appPath, artifact.path).replace(/\\/g, "/")} (${formatBytes(artifact.sizeBytes)})`,
      );
      const commandLines = result.commands.map(
        (command) =>
          `- ${command.command} [exit ${command.exitCode}]${command.output.trim() ? `\n${command.output.trim().slice(-1200)}` : ""}`,
      );
      const deployHint = downloadSitePath
        ? `\n\nDownload site: ${path.relative(ctx.appPath, downloadSitePath).replace(/\\/g, "/")}\nDeploy with: npx vercel deploy native-download-site --prod`
        : "";
      const summary = [
        `Native package target: ${target}`,
        "",
        "Artifacts:",
        ...artifactLines,
        deployHint,
        "",
        "Commands:",
        ...commandLines,
      ].join("\n");

      ctx.onXmlComplete(
        `<orianbuilder-native-package target="${escapeXmlAttr(target)}" status="passed" artifact-count="${result.artifacts.length}" download-site="${escapeXmlAttr(downloadSitePath ? path.relative(ctx.appPath, downloadSitePath).replace(/\\/g, "/") : "")}">${escapeXmlContent(summary)}</orianbuilder-native-package>`,
      );

      if (downloadSitePath) {
        ctx.appendUserMessage([
          {
            type: "text",
            text: 'Native packaging succeeded and native-download-site/ exists, but the user\'s request still requires a download page URL. Continue by calling deploy_preview with provider="custom_command", target="production", and deploy_directory="native-download-site". Omit custom_command so OrianBuilder serves the static download page locally when no external provider is linked. Do not finish until deploy_preview returns a URL.',
          },
        ]);
      }

      return summary;
    },
  };
