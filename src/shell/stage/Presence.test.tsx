import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DelegationConversationPrompt } from "./Presence";

describe("Marta delegation prompt", () => {
  it("asks for voice or text instead of rendering a configuration form", () => {
    render(
      <DelegationConversationPrompt
        request={{
          requestId: "choice-1",
          appId: 125,
          goal: "Add an accessible color legend",
          readOnly: false,
          text: "Update the site",
        }}
      />,
    );

    expect(
      screen.getByLabelText(
        "Waiting for a spoken or typed coding model choice",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Voice or text")).toBeTruthy();
    expect(screen.getByText(/what are my options/i)).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
