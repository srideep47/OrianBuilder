import { describe, expect, it } from "vitest";

import {
  deriveVisualExpectations,
  pageContainsText,
  summariseInspection,
} from "./visual_verifier";

describe("deriveVisualExpectations", () => {
  it("takes quoted text as the strongest possible claim", () => {
    expect(
      deriveVisualExpectations(
        'Change the homepage heading to "Rainbow Hello" please',
      ),
    ).toEqual([{ text: "Rainbow Hello", reason: "quoted in the request" }]);
  });

  it("handles curly quotes, which is what a dictated request produces", () => {
    expect(
      deriveVisualExpectations("Add a footer that says “Built with Orion”"),
    ).toEqual([
      { text: "Built with Orion", reason: "quoted in the request" },
      // The "says X" pattern also fires; the duplicate is de-duplicated by text.
    ]);
  });

  it("reads an unquoted 'says' clause", () => {
    const expectations = deriveVisualExpectations(
      "Add a banner that says Welcome back",
    );
    expect(expectations).toHaveLength(1);
    expect(expectations[0].text).toBe("Welcome back");
  });

  it("asserts nothing for a request with no checkable text", () => {
    // "Make it prettier" has no verifiable claim. Inventing one would fail work
    // that actually succeeded, which is worse than admitting the limit.
    expect(deriveVisualExpectations("Make the dashboard look nicer")).toEqual(
      [],
    );
    expect(deriveVisualExpectations("Redesign the landing page")).toEqual([]);
  });

  it("ignores words too generic to prove anything", () => {
    expect(deriveVisualExpectations('Update the "page"')).toEqual([]);
  });

  it("rejects text too long to be a visible label", () => {
    const long = "x".repeat(200);
    expect(deriveVisualExpectations(`Show "${long}"`)).toEqual([]);
  });

  it("does not repeat the same expectation twice", () => {
    const expectations = deriveVisualExpectations(
      'The header says "Orion" and the footer says "Orion"',
    );
    expect(expectations).toHaveLength(1);
  });
});

describe("pageContainsText", () => {
  it("matches regardless of case and whitespace", () => {
    expect(pageContainsText("  RAINBOW\n  HELLO  ", "rainbow hello")).toBe(
      true,
    );
  });

  it("does not match absent text", () => {
    expect(pageContainsText("Welcome to Orion", "rainbow hello")).toBe(false);
  });
});

describe("summariseInspection", () => {
  const base = {
    url: "http://localhost:5173",
    title: "Orion App",
    textSample: "Rainbow Hello — welcome to the site",
    elementCount: 412,
    screenshotPath: "C:/evidence/route.png",
    matched: [] as Array<{ text: string; reason: string; found: boolean }>,
    pageErrors: [] as string[],
  };

  it("passes when every expectation is on the page", () => {
    const result = summariseInspection({
      ...base,
      matched: [
        { text: "Rainbow Hello", reason: "quoted in the request", found: true },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("Rainbow Hello");
  });

  it("fails and explains when the change is not on the live route", () => {
    const result = summariseInspection({
      ...base,
      textSample: "Welcome to the site",
      matched: [
        {
          text: "Rainbow Hello",
          reason: "quoted in the request",
          found: false,
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("Rainbow Hello");
    expect(result.detail).toContain("the running app never loads");
  });

  it("fails on a page error before judging content", () => {
    // An app that threw during render can still contain the expected string in a
    // stale DOM. The error is the more important fact.
    const result = summariseInspection({
      ...base,
      pageErrors: ["Uncaught TypeError: cannot read properties of undefined"],
      matched: [{ text: "Rainbow Hello", reason: "quoted", found: true }],
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("Uncaught TypeError");
  });

  it("fails an empty root rather than calling it a pass", () => {
    const result = summariseInspection({ ...base, textSample: "   " });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("no meaningful content");
  });

  it("passes render-health only, and says so, when nothing is assertable", () => {
    const result = summariseInspection({ ...base, matched: [] });
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("no checkable text");
    expect(result.detail).toContain("412 elements");
  });

  it("treats a spinner as unrendered", () => {
    expect(summariseInspection({ ...base, textSample: "Loading" }).ok).toBe(
      false,
    );
  });
});
