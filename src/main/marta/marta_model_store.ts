/**
 * The persistent home for Marta's downloaded weights.
 *
 * Electron's `userData` is a browser profile. Development, the packaged app,
 * and Playwright can each legitimately have a different one, but a multi-GB
 * GGUF must not be re-downloaded just because the shell changed profiles. This
 * tiny pointer lives in `appData`, which is shared by those profiles, while
 * conversation history and settings remain in `userData` as they should.
 */

import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import log from "electron-log";

const logger = log.scope("marta-model-store");
const POINTER_FILENAME = "orianbuilder-marta-model-store.json";
const MODEL_ROOT_ENV = "ORIANBUILDER_MARTA_MODELS_DIR";

interface MartaModelStorePointer {
  /** Absolute directory containing the `marta/` tier directories. */
  modelsDir: string;
}

/** The pointer is outside `userData` so it survives switching Electron profiles. */
export function getMartaModelStorePointerPath(): string {
  return path.join(app.getPath("appData"), POINTER_FILENAME);
}

function normaliseAbsolute(dir: string): string | null {
  if (!path.isAbsolute(dir)) return null;
  return path.normalize(dir);
}

function readStorePointer(): string | null {
  try {
    const raw = fs
      .readFileSync(getMartaModelStorePointerPath(), "utf8")
      .replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw) as Partial<MartaModelStorePointer>;
    return typeof parsed.modelsDir === "string"
      ? normaliseAbsolute(parsed.modelsDir)
      : null;
  } catch {
    return null;
  }
}

function writeStorePointer(modelsDir: string): void {
  try {
    fs.mkdirSync(path.dirname(getMartaModelStorePointerPath()), {
      recursive: true,
    });
    const payload: MartaModelStorePointer = { modelsDir };
    fs.writeFileSync(
      getMartaModelStorePointerPath(),
      JSON.stringify(payload, null, 2),
    );
  } catch (error) {
    // A read-only roaming profile must not stop the current profile from using
    // its own model. It simply will not be remembered for the next profile.
    logger.warn("Could not persist Marta's shared model store:", error);
  }
}

function containsMartaModel(modelsDir: string): boolean {
  try {
    for (const tier of fs.readdirSync(path.join(modelsDir, "marta"))) {
      const tierDir = path.join(modelsDir, "marta", tier);
      if (!fs.statSync(tierDir).isDirectory()) continue;
      if (
        fs
          .readdirSync(tierDir)
          .some(
            (file) =>
              file.toLowerCase().endsWith(".gguf") &&
              !file.toLowerCase().startsWith("mmproj"),
          )
      ) {
        return true;
      }
    }
  } catch {
    // Missing directories are expected on a new installation.
  }
  return false;
}

function hasExplicitUserDataDir(): boolean {
  return process.argv.some(
    (arg) => arg === "--user-data-dir" || arg.startsWith("--user-data-dir="),
  );
}

/**
 * The shared models root. An explicit environment variable wins for CI and
 * portable developer setups; otherwise the first profile that has a Marta
 * model promotes its existing `userData/models` directory to the shared home.
 */
export function getMartaModelsRoot(): string {
  const fromEnv = process.env[MODEL_ROOT_ENV];
  if (fromEnv) {
    const resolved = normaliseAbsolute(fromEnv);
    if (resolved) {
      // An environment override is an intentional developer/portable setup;
      // remember it so the next ordinary launch does not need the variable.
      writeStorePointer(resolved);
      return resolved;
    }
    logger.warn(`${MODEL_ROOT_ENV} must be an absolute path; ignoring it.`);
  }

  const configured = readStorePointer();
  if (configured) return configured;

  // Compatibility and bootstrap: existing installs already keep Marta under
  // userData/models. Once a normal profile can see that model, remember its
  // root so a dev profile opened tomorrow resolves exactly the same weights.
  // Playwright deliberately passes a throwaway `--user-data-dir`; never let a
  // staged test model become the user's persistent model-store setting.
  const profileModels = path.join(app.getPath("userData"), "models");
  if (containsMartaModel(profileModels) && !hasExplicitUserDataDir()) {
    writeStorePointer(profileModels);
  }
  return profileModels;
}
