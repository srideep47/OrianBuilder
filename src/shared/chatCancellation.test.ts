import { describe, expect, it } from "vitest";
import { appendCancelledResponseNotice } from "./chatCancellation";

describe("appendCancelledResponseNotice", () => {
  it("stops an in-progress status indicator when its response is cancelled", () => {
    const content =
      '<orianbuilder-status title="Generating image" state="in-progress">Working locally.</orianbuilder-status>';

    expect(appendCancelledResponseNotice(content)).toBe(
      '<orianbuilder-status title="Generating image" state="aborted">Working locally.</orianbuilder-status>\n\n[Response cancelled by user]',
    );
  });
});
