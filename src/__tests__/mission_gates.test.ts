import { describe, expect, it } from "vitest";

import { getPostCreateGateStatus } from "@/ipc/utils/mission_gates";

describe("mission post-create gates", () => {
  it("reports missing checks until every required gate passes", () => {
    const status = getPostCreateGateStatus([
      {
        eventType: "post_create_verification_required",
        metadata: {
          requiredChecks: ["install", "typecheck", "build", "runtime"],
        },
      },
      {
        eventType: "verification_install",
        metadata: { check: "install", status: "passed" },
      },
      {
        eventType: "verification_typecheck",
        metadata: { check: "typecheck", status: "passed" },
      },
      {
        eventType: "runtime_preview_checked",
        metadata: { gate: "runtime", status: "failed" },
      },
    ]);

    expect(status).toEqual({
      requiredChecks: ["install", "typecheck", "build", "runtime"],
      completedChecks: ["install", "typecheck"],
      missingChecks: ["build", "runtime"],
      failedChecks: ["runtime"],
      isRequired: true,
      isSatisfied: false,
    });
  });

  it("is satisfied when no post-create gate is required", () => {
    expect(getPostCreateGateStatus([])).toMatchObject({
      isRequired: false,
      isSatisfied: true,
      missingChecks: [],
    });
  });
});
