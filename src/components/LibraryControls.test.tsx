import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { LibraryFilterTabs } from "@/components/LibraryFilterTabs";
import { LibrarySearchBar } from "@/components/LibrarySearchBar";

describe("Library controls", () => {
  it("renders filter options and forwards filter changes", () => {
    const onChange = vi.fn();

    render(<LibraryFilterTabs active="all" onChange={onChange} />);

    const allButton = screen.getByRole("button", { name: "All" });
    const themesButton = screen.getByRole("button", { name: "Themes" });

    expect(allButton.getAttribute("aria-pressed")).toBe("true");
    expect(themesButton.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(themesButton);

    expect(onChange).toHaveBeenCalledWith("themes");
  });

  it("uses the macOS-style search label and forwards text changes", () => {
    const onChange = vi.fn();

    render(<LibrarySearchBar value="" onChange={onChange} />);

    const input = screen.getByLabelText("Search library");
    expect(input.getAttribute("placeholder")).toBe("Search");

    fireEvent.change(input, { target: { value: "theme" } });

    expect(onChange).toHaveBeenCalledWith("theme");
  });
});
