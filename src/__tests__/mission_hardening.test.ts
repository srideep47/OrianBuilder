import { describe, expect, it } from "vitest";

import {
  redactSensitiveText,
  sanitizeMissionMetadata,
  sanitizeMissionText,
} from "@/ipc/utils/mission_hardening";

describe("mission hardening", () => {
  it("redacts common secrets from mission text", () => {
    const text = [
      "Authorization: Bearer abc.def.ghi",
      "api_key=sk-123456789012345678901234",
      "password=hunter2",
      "token=pat_123456789012345678901234",
    ].join("\n");

    const redacted = redactSensitiveText(text);

    expect(redacted).toContain("Authorization: [REDACTED]");
    expect(redacted).toContain("api_key=[REDACTED]");
    expect(redacted).toContain("password=[REDACTED]");
    expect(redacted).toContain("token=[REDACTED]");
    expect(redacted).not.toContain("hunter2");
  });

  it("caps oversized mission artifact bodies", () => {
    const sanitized = sanitizeMissionText(
      "x".repeat(140 * 1024),
      "artifact_body",
    );

    expect(sanitized).toContain("[truncated");
    expect(Buffer.byteLength(sanitized ?? "", "utf8")).toBeLessThan(132 * 1024);
  });

  it("redacts sensitive metadata keys and bounds large metadata", () => {
    const metadata = sanitizeMissionMetadata({
      token: "raw-token",
      nested: {
        authorization: "Bearer secret",
        normal: "safe",
      },
      huge: "x".repeat(50 * 1024),
    });

    expect(metadata).toMatchObject({
      token: "[REDACTED]",
      nested: {
        authorization: "[REDACTED]",
        normal: "safe",
      },
    });
    expect(JSON.stringify(metadata)).not.toContain("raw-token");
    expect(Buffer.byteLength(JSON.stringify(metadata), "utf8")).toBeLessThan(
      36 * 1024,
    );
  });
});
