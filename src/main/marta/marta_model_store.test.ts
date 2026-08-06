import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electronApp = { getPath: vi.fn<(name: string) => string>() };

vi.mock("electron", () => ({ app: electronApp }));

let root: string;
let appData: string;
let firstProfile: string;
let secondProfile: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "orian-marta-store-"));
  appData = path.join(root, "app-data");
  firstProfile = path.join(root, "packaged-profile");
  secondProfile = path.join(root, "dev-profile");
  fs.mkdirSync(appData, { recursive: true });
  electronApp.getPath.mockImplementation((name) =>
    name === "appData" ? appData : firstProfile,
  );
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("Marta shared model store", () => {
  it("adopts an existing profile model and reuses it from another profile", async () => {
    const modelDir = path.join(firstProfile, "models", "marta", "2b");
    fs.mkdirSync(modelDir, { recursive: true });
    fs.writeFileSync(path.join(modelDir, "Marta-2B.gguf"), "test model");

    const store = await import("./marta_model_store");
    expect(store.getMartaModelsRoot()).toBe(path.join(firstProfile, "models"));

    electronApp.getPath.mockImplementation((name) =>
      name === "appData" ? appData : secondProfile,
    );
    expect(store.getMartaModelsRoot()).toBe(path.join(firstProfile, "models"));
    expect(fs.existsSync(store.getMartaModelStorePointerPath())).toBe(true);
  });

  it("lets an explicit models root override the persisted store", async () => {
    const configured = path.join(root, "portable-models");
    vi.stubEnv("ORIANBUILDER_MARTA_MODELS_DIR", configured);

    const store = await import("./marta_model_store");
    expect(store.getMartaModelsRoot()).toBe(configured);
    expect(fs.existsSync(store.getMartaModelStorePointerPath())).toBe(true);
  });
});
