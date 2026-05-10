import { describe, expect, it } from "vitest";
import {
  OrianBuilderError,
  OrianBuilderErrorKind,
} from "@/errors/orianbuilder_error";
import { shouldFilterTelemetryException } from "@/ipc/utils/telemetry";

describe("shouldFilterTelemetryException", () => {
  it("filters the known Supabase auth noise message", () => {
    expect(
      shouldFilterTelemetryException(
        new Error(
          "Supabase access token not found. Please authenticate first.",
        ),
      ),
    ).toBe(true);
  });

  it("filters RateLimitError 429s from retryWithRateLimit", () => {
    const error = new Error("Rate limited (429): Too Many Requests");
    error.name = "RateLimitError";

    expect(shouldFilterTelemetryException(error)).toBe(true);
  });

  it("does not filter non-429 RateLimitError variants", () => {
    const error = new Error("Rate limited (503): Service Unavailable");
    error.name = "RateLimitError";

    expect(shouldFilterTelemetryException(error)).toBe(false);
  });

  it("does not filter different Supabase auth failures", () => {
    expect(
      shouldFilterTelemetryException(
        new Error(
          "Supabase access token not found for organization acme. Please authenticate first.",
        ),
      ),
    ).toBe(false);
  });

  it("filters OrianBuilderError kinds that are non-actionable for telemetry", () => {
    expect(
      shouldFilterTelemetryException(
        new OrianBuilderError("bad input", OrianBuilderErrorKind.Validation),
      ),
    ).toBe(true);
    expect(
      shouldFilterTelemetryException(
        new OrianBuilderError("missing", OrianBuilderErrorKind.NotFound),
      ),
    ).toBe(true);
  });

  it("does not filter OrianBuilderError Internal, External, or Unknown", () => {
    expect(
      shouldFilterTelemetryException(
        new OrianBuilderError("bug", OrianBuilderErrorKind.Internal),
      ),
    ).toBe(false);
    expect(
      shouldFilterTelemetryException(
        new OrianBuilderError("upstream", OrianBuilderErrorKind.External),
      ),
    ).toBe(false);
    expect(
      shouldFilterTelemetryException(
        new OrianBuilderError("?", OrianBuilderErrorKind.Unknown),
      ),
    ).toBe(false);
  });
});
