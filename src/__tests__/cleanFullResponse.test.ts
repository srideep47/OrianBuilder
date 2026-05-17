import { cleanFullResponse } from "@/ipc/utils/cleanFullResponse";
import { describe, it, expect } from "vitest";

describe("cleanFullResponse", () => {
  it("should replace < characters in orianbuilder-write attributes", () => {
    const input = `<orianbuilder-write path="src/file.tsx" description="Testing <a> tags.">content</orianbuilder-write>`;
    const expected = `<orianbuilder-write path="src/file.tsx" description="Testing ＜a＞ tags.">content</orianbuilder-write>`;

    const result = cleanFullResponse(input);
    expect(result).toBe(expected);
  });

  it("should replace < characters in multiple attributes", () => {
    const input = `<orianbuilder-write path="src/<component>.tsx" description="Testing <div> tags.">content</orianbuilder-write>`;
    const expected = `<orianbuilder-write path="src/＜component＞.tsx" description="Testing ＜div＞ tags.">content</orianbuilder-write>`;

    const result = cleanFullResponse(input);
    expect(result).toBe(expected);
  });

  it("should handle multiple nested HTML tags in a single attribute", () => {
    const input = `<orianbuilder-write path="src/file.tsx" description="Testing <div> and <span> and <a> tags.">content</orianbuilder-write>`;
    const expected = `<orianbuilder-write path="src/file.tsx" description="Testing ＜div＞ and ＜span＞ and ＜a＞ tags.">content</orianbuilder-write>`;

    const result = cleanFullResponse(input);
    expect(result).toBe(expected);
  });

  it("should handle complex example with mixed content", () => {
    const input = `
      BEFORE TAG
  <orianbuilder-write path="src/pages/locations/neighborhoods/louisville/Highlands.tsx" description="Updating Highlands neighborhood page to use <a> tags.">
import React from 'react';
</orianbuilder-write>
AFTER TAG
    `;

    const expected = `
      BEFORE TAG
  <orianbuilder-write path="src/pages/locations/neighborhoods/louisville/Highlands.tsx" description="Updating Highlands neighborhood page to use ＜a＞ tags.">
import React from 'react';
</orianbuilder-write>
AFTER TAG
    `;

    const result = cleanFullResponse(input);
    expect(result).toBe(expected);
  });

  it("should handle other orianbuilder tag types", () => {
    const input = `<orianbuilder-rename from="src/<old>.tsx" to="src/<new>.tsx"></orianbuilder-rename>`;
    const expected = `<orianbuilder-rename from="src/＜old＞.tsx" to="src/＜new＞.tsx"></orianbuilder-rename>`;

    const result = cleanFullResponse(input);
    expect(result).toBe(expected);
  });

  it("should handle orianbuilder-delete tags", () => {
    const input = `<orianbuilder-delete path="src/<component>.tsx"></orianbuilder-delete>`;
    const expected = `<orianbuilder-delete path="src/＜component＞.tsx"></orianbuilder-delete>`;

    const result = cleanFullResponse(input);
    expect(result).toBe(expected);
  });

  it("should not affect content outside orianbuilder tags", () => {
    const input = `Some text with <regular> HTML tags. <orianbuilder-write path="test.tsx" description="With <nested> tags.">content</orianbuilder-write> More <html> here.`;
    const expected = `Some text with <regular> HTML tags. <orianbuilder-write path="test.tsx" description="With ＜nested＞ tags.">content</orianbuilder-write> More <html> here.`;

    const result = cleanFullResponse(input);
    expect(result).toBe(expected);
  });

  it("should handle empty attributes", () => {
    const input = `<orianbuilder-write path="src/file.tsx">content</orianbuilder-write>`;
    const expected = `<orianbuilder-write path="src/file.tsx">content</orianbuilder-write>`;

    const result = cleanFullResponse(input);
    expect(result).toBe(expected);
  });

  it("should handle attributes without < characters", () => {
    const input = `<orianbuilder-write path="src/file.tsx" description="Normal description">content</orianbuilder-write>`;
    const expected = `<orianbuilder-write path="src/file.tsx" description="Normal description">content</orianbuilder-write>`;

    const result = cleanFullResponse(input);
    expect(result).toBe(expected);
  });
});
