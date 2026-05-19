import { describe, it, expect } from "vitest";
import { isPathLocked, normalizeLockPath } from "./chat_path_locks";

describe("normalizeLockPath", () => {
  it("converts backslashes to forward slashes", () => {
    expect(normalizeLockPath("src\\components\\Button.tsx")).toBe(
      "src/components/Button.tsx",
    );
  });

  it("strips leading ./", () => {
    expect(normalizeLockPath("./src/foo")).toBe("src/foo");
  });

  it("strips trailing slashes", () => {
    expect(normalizeLockPath("src/components/")).toBe("src/components");
  });

  it("collapses doubled slashes", () => {
    expect(normalizeLockPath("src//foo///bar")).toBe("src/foo/bar");
  });

  it("trims whitespace", () => {
    expect(normalizeLockPath("  src/foo  ")).toBe("src/foo");
  });
});

describe("isPathLocked", () => {
  it("returns false for empty/null locks", () => {
    expect(isPathLocked("src/foo.tsx", null)).toBe(false);
    expect(isPathLocked("src/foo.tsx", undefined)).toBe(false);
    expect(isPathLocked("src/foo.tsx", [])).toBe(false);
  });

  it("matches exact file locks", () => {
    expect(isPathLocked("src/App.tsx", ["src/App.tsx"])).toBe(true);
    expect(isPathLocked("src/other.tsx", ["src/App.tsx"])).toBe(false);
  });

  it("matches files inside locked folders", () => {
    expect(isPathLocked("src/components/Button.tsx", ["src/components"])).toBe(
      true,
    );
    expect(
      isPathLocked("src/components/nested/X.tsx", ["src/components"]),
    ).toBe(true);
  });

  it("does not match sibling folders with shared prefix", () => {
    // "src/comp" should NOT lock "src/components/Button.tsx"
    expect(isPathLocked("src/components/Button.tsx", ["src/comp"])).toBe(false);
  });

  it("normalizes both sides before comparing", () => {
    expect(isPathLocked("src\\App.tsx", ["./src/App.tsx"])).toBe(true);
    expect(
      isPathLocked("./src/components/Button.tsx", ["src\\components\\"]),
    ).toBe(true);
  });

  it("ignores empty/whitespace lock entries", () => {
    expect(isPathLocked("src/App.tsx", ["", "   ", "src/App.tsx"])).toBe(true);
    expect(isPathLocked("src/other.tsx", ["", "   "])).toBe(false);
  });
});
