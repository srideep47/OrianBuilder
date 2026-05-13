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

  it("formats bare local agent protocol tags instead of showing raw XML", () => {
    render(
      <OrianBuilderMarkdownParser
        content={
          "Before <set_chat_summary>Hidden title</set_chat_summary><detect_project_stack></detect_project_stack> after"
        }
      />,
    );

    expect(screen.getByText("Before")).toBeTruthy();
    expect(screen.getByText("detect project stack")).toBeTruthy();
    expect(screen.queryByText(/set_chat_summary/)).toBeNull();
    expect(screen.queryByText("Hidden title")).toBeNull();
  });

  it("renders failed project checks as error cards", () => {
    const { asFragment } = render(
      <OrianBuilderMarkdownParser
        content={`<orianbuilder-project-check check="install" command="npm install --legacy-peer-deps" source="explicit" status="failed" exit-code="1" framework="expo" package-manager="npm">Install failed (exit 1)
Command: npm install --legacy-peer-deps

npm error code ETARGET
npm error notarget No matching version found for react@18.3.2.
npm error notarget In most cases you or one of your dependencies are requesting a package version that doesn't exist.
npm error A complete log of this run can be found in: C:\\Users\\sride\\AppData\\Local\\npm-cache\\_logs\\2026-05-12T11_42_49_197Z-debug-0.log</orianbuilder-project-check>`}
      />,
    );

    expect(screen.getByText("Project check failed")).toBeTruthy();
    expect(screen.getByText("expo")).toBeTruthy();
    expect(screen.getByText("npm install --legacy-peer-deps")).toBeTruthy();
    expect(screen.getByText("exit 1")).toBeTruthy();
    expect(screen.queryByText(/orianbuilder-project-check/)).toBeNull();
    expect(asFragment()).toMatchSnapshot();
  });

  it("degrades gracefully when failed project-check attributes are missing", () => {
    render(
      <OrianBuilderMarkdownParser
        content={
          '<orianbuilder-project-check status="failed">npm failed</orianbuilder-project-check>'
        }
      />,
    );

    expect(screen.getByText("Project check failed")).toBeTruthy();
    expect(screen.getByText("Project")).toBeTruthy();
    expect(screen.getByText("Unknown command")).toBeTruthy();
  });
});
