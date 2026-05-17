import { describe, expect, it } from "vitest";

import {
  buildNpmEtargetRecoveryMessage,
  detectNpmEtargetError,
  selectNpmReplacementVersion,
} from "@/ipc/utils/npm_registry";

describe("npm registry helpers", () => {
  it("detects npm ETARGET failures for unscoped packages", () => {
    expect(
      detectNpmEtargetError(`npm error code ETARGET
npm error notarget No matching version found for react@18.3.2.`),
    ).toEqual({
      packageName: "react",
      requestedVersion: "18.3.2",
    });
  });

  it("detects npm ETARGET failures for scoped packages", () => {
    expect(
      detectNpmEtargetError(`npm ERR! code ETARGET
npm ERR! notarget No matching version found for @expo/vector-icons@14.1.1.`),
    ).toEqual({
      packageName: "@expo/vector-icons",
      requestedVersion: "14.1.1",
    });
  });

  it("selects the nearest stable version in the requested minor line", () => {
    expect(
      selectNpmReplacementVersion({
        requestedVersion: "18.3.2",
        latest: "19.1.0",
        stableVersions: ["18.2.0", "18.3.0", "18.3.1", "19.0.0", "19.1.0"],
      }),
    ).toBe("18.3.1");
  });

  it("builds a synthetic recovery prompt for the next agent step", () => {
    expect(
      buildNpmEtargetRecoveryMessage({
        packageName: "react",
        requestedVersion: "18.3.2",
        replacementVersion: "18.3.1",
        distTagLatest: "19.1.0",
      }),
    ).toBe(
      "Install failed because react@18.3.2 doesn't exist. Latest valid version is 18.3.1. npm dist-tag latest is 19.1.0. Update package.json and rerun. Don't retry the same version.",
    );
  });
});
