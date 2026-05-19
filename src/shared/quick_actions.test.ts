import { describe, it, expect } from "vitest";
import { parseQuickActions } from "./quick_actions";

describe("parseQuickActions", () => {
  it("returns empty array when no tags present", () => {
    expect(parseQuickActions("plain text")).toEqual([]);
    expect(parseQuickActions("")).toEqual([]);
  });

  it("parses a single self-closing tag", () => {
    const text =
      '<orianbuilder-quick-action label="Run tests" prompt="Run the test suite."/>';
    expect(parseQuickActions(text)).toEqual([
      { label: "Run tests", prompt: "Run the test suite." },
    ]);
  });

  it("parses paired open/close tags", () => {
    const text =
      '<orianbuilder-quick-action label="Deploy" prompt="Deploy now."></orianbuilder-quick-action>';
    expect(parseQuickActions(text)).toEqual([
      { label: "Deploy", prompt: "Deploy now." },
    ]);
  });

  it("parses multiple actions up to 3", () => {
    const text = `
      <orianbuilder-quick-action label="A" prompt="do a"/>
      <orianbuilder-quick-action label="B" prompt="do b"/>
      <orianbuilder-quick-action label="C" prompt="do c"/>
      <orianbuilder-quick-action label="D" prompt="do d"/>
    `;
    const out = parseQuickActions(text);
    expect(out).toHaveLength(3);
    expect(out.map((a) => a.label)).toEqual(["A", "B", "C"]);
  });

  it("decodes XML-escaped attributes", () => {
    const text =
      '<orianbuilder-quick-action label="A &amp; B" prompt="say &quot;hi&quot;"/>';
    expect(parseQuickActions(text)).toEqual([
      { label: "A & B", prompt: 'say "hi"' },
    ]);
  });

  it("truncates labels longer than 24 chars", () => {
    const longLabel = "a".repeat(40);
    const text = `<orianbuilder-quick-action label="${longLabel}" prompt="x"/>`;
    expect(parseQuickActions(text)[0].label).toHaveLength(24);
  });

  it("skips tags missing label or prompt", () => {
    const text = `
      <orianbuilder-quick-action label=""/>
      <orianbuilder-quick-action prompt="no label"/>
      <orianbuilder-quick-action label="ok" prompt="ok"/>
    `;
    expect(parseQuickActions(text)).toEqual([{ label: "ok", prompt: "ok" }]);
  });
});
