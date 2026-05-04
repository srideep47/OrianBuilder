import { windowsSign } from "./windowsSign";
import { removeUnsupportedWindowsSigningFiles } from "./src/lib/windows_signing";
import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { MakerDeb } from "@electron-forge/maker-deb";
import { MakerRpm } from "@electron-forge/maker-rpm";
import { MakerAppImage } from "./makers/MakerAppImage";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { FuseV1Options, FuseVersion } from "@electron/fuses";
import { AutoUnpackNativesPlugin } from "@electron-forge/plugin-auto-unpack-natives";

console.log("AZURE_CODE_SIGNING_DLIB", process.env.AZURE_CODE_SIGNING_DLIB);

// Based on https://github.com/electron/forge/blob/6b2d547a7216c30fde1e1fddd1118eee5d872945/packages/plugin/vite/src/VitePlugin.ts#L124
const ignore = (file: string) => {
  if (!file) return false;
  // `file` always starts with `/`
  // @see - https://github.com/electron/packager/blob/v18.1.3/src/copy-filter.ts#L89-L93
  if (file === "/node_modules") {
    return false;
  }
  if (file.startsWith("/drizzle")) {
    return false;
  }
  if (file.startsWith("/scaffold")) {
    return false;
  }

  if (file.startsWith("/worker") && !file.startsWith("/workers")) {
    return false;
  }
  if (file.startsWith("/node_modules/stacktrace-js")) {
    return false;
  }
  if (file.startsWith("/node_modules/stacktrace-js/dist")) {
    return false;
  }
  if (file.startsWith("/node_modules/html-to-image")) {
    return false;
  }
  if (file.startsWith("/node_modules/better-sqlite3")) {
    return false;
  }
  if (file.startsWith("/node_modules/node-pty")) {
    return true;
  }
  if (file.startsWith("/node_modules/playwright")) {
    return false;
  }
  if (file.startsWith("/node_modules/playwright-core")) {
    return false;
  }
  if (file.startsWith("/node_modules/chromium-bidi")) {
    return false;
  }
  if (file.startsWith("/node_modules/devtools-protocol")) {
    return false;
  }
  if (file.startsWith("/node_modules/mitt")) {
    return false;
  }
  if (file.startsWith("/node_modules/node-addon-api")) {
    return false;
  }
  if (file.startsWith("/node_modules/bindings")) {
    return false;
  }
  if (file.startsWith("/node_modules/file-uri-to-path")) {
    return false;
  }
  if (file.startsWith("/.vite")) {
    return false;
  }

  return true;
};

const isEndToEndTestBuild = process.env.E2E_TEST_BUILD === "true";
const isWindowsSigningEnabled = process.env.WINDOWS_SIGN === "true";

if (isWindowsSigningEnabled && !process.env.AZURE_CODE_SIGNING_DLIB) {
  throw new Error(
    "WINDOWS_SIGN is enabled but AZURE_CODE_SIGNING_DLIB is not set. " +
      "Ensure Azure Trusted Signing tools are installed.",
  );
}

const config: ForgeConfig = {
  packagerConfig: {
    windowsSign: isWindowsSigningEnabled ? windowsSign : undefined,
    afterCopy: isWindowsSigningEnabled
      ? [
          (buildPath, _electronVersion, platform, _arch, callback) => {
            if (platform !== "win32") {
              callback();
              return;
            }

            removeUnsupportedWindowsSigningFiles(buildPath).then(
              () => callback(),
              (error) => callback(error as Error),
            );
          },
        ]
      : undefined,
    protocols: [
      {
        name: "OrianBuilder",
        schemes: ["orianbuilder"],
      },
    ],
    icon: "./assets/icon/logo",

    osxSign: isEndToEndTestBuild
      ? undefined
      : ({
          identity: process.env.APPLE_TEAM_ID,
          // Surface the actual signing error instead of silently continuing
          // (@electron/packager defaults continueOnError to true, which masks failures)
          continueOnError: false,
          // Skip provisioning profile search (not needed for Developer ID distribution,
          // and the cwd scan crashes on broken symlinks like CLAUDE.md)
          preEmbedProvisioningProfile: false,
        } as Record<string, unknown>),
    osxNotarize: isEndToEndTestBuild
      ? undefined
      : {
          appleId: process.env.APPLE_ID!,
          appleIdPassword: process.env.APPLE_PASSWORD!,
          teamId: process.env.APPLE_TEAM_ID!,
        },
    asar: {
      unpackDir:
        "{node_modules/node-llama-cpp,node_modules/@node-llama-cpp,node_modules/playwright,node_modules/playwright-core,node_modules/chromium-bidi}",
    },
    ignore,
    extraResource: [
      "node_modules/dugite/git",
      "node_modules/@vscode",
      "native/tensorrt-runner/bin",
      "native/trt-llm-runner",
      "scripts/build-tensorrt-engine.ps1",
      "scripts/build-trt-llm-engine.ps1",
    ],
    // ignore: [/node_modules\/(?!(better-sqlite3|bindings|file-uri-to-path)\/)/],
  },
  rebuildConfig: {
    extraModules: ["better-sqlite3", "node-llama-cpp"],
    force: true,
  },
  makers: [
    new MakerSquirrel(
      // @ts-expect-error - incorrect types exported by MakerSquirrel
      isWindowsSigningEnabled
        ? {
            windowsSign,
            iconUrl:
              "https://raw.githubusercontent.com/srideep47/OrianBuilder/main/assets/icon/logo.ico",
            setupIcon: "./assets/icon/logo.ico",
          }
        : {
            iconUrl:
              "https://raw.githubusercontent.com/srideep47/OrianBuilder/main/assets/icon/logo.ico",
            setupIcon: "./assets/icon/logo.ico",
          },
    ),
    new MakerZIP({}, ["darwin"]),
    new MakerRpm({
      options: {
        icon: "./assets/icon/logo.png",
      },
    }),
    new MakerDeb({
      options: {
        mimeType: ["x-scheme-handler/orianbuilder"],
        icon: "./assets/icon/logo.png",
      },
    }),
    new MakerAppImage({
      icon: "./assets/icon/logo.png",
    }),
  ],
  publishers: [
    {
      name: "@electron-forge/publisher-github",
      config: {
        repository: {
          owner: "srideep47",
          name: "OrianBuilder",
        },
        draft: true,
        force: true,
        prerelease: true,
      },
    },
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
      // If you are familiar with Vite configuration, it will look really familiar.
      build: [
        {
          // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
          entry: "src/main.ts",
          config: "vite.main.config.mts",
          target: "main",
        },
        {
          entry: "src/preload.ts",
          config: "vite.preload.config.mts",
          target: "preload",
        },
        {
          entry: "workers/tsc/tsc_worker.ts",
          config: "vite.worker.config.mts",
          target: "main",
        },
      ],
      renderer: [
        {
          name: "main_window",
          config: "vite.renderer.config.mts",
        },
      ],
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: isEndToEndTestBuild,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
