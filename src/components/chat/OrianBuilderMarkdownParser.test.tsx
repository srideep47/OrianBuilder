import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OrianBuilderMarkdownParser } from "./OrianBuilderMarkdownParser";

vi.mock("../preview_panel/FileEditor", () => ({
  FileEditor: () => null,
}));

describe("OrianBuilderMarkdownParser orianbuilder-status", () => {
  afterEach(() => {
    cleanup();
  });

  it("honors explicit aborted state on closed status tags", () => {
    render(
      <OrianBuilderMarkdownParser
        content={
          '<orianbuilder-status title="Supabase functions failed" state="aborted">\n0 succeeded\n1 failed\n</orianbuilder-status>'
        }
      />,
    );

    const statusCard = screen.getByRole("button");

    expect(screen.getByText("Supabase functions failed")).toBeTruthy();
    expect(statusCard.className).toContain("border-l-red-500");
  });
});
