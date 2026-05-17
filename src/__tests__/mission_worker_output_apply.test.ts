import { describe, expect, it } from "vitest";

import {
  assertRelativeWorkerOutputPath,
  detectWorkerApplyConflicts,
  parseWorkerNameStatusOutput,
} from "@/ipc/utils/mission_worker_output_apply";

describe("mission worker output apply utilities", () => {
  it("parses git name-status output including renames", () => {
    expect(
      parseWorkerNameStatusOutput(
        [
          "M\tsrc/App.tsx",
          "A\tsrc/new.ts",
          "D\tsrc/old.ts",
          "R100\tsrc/a.ts\tsrc/b.ts",
        ].join("\n"),
      ),
    ).toEqual([
      { status: "M", path: "src/App.tsx" },
      { status: "A", path: "src/new.ts" },
      { status: "D", path: "src/old.ts" },
      { status: "R100", previousPath: "src/a.ts", path: "src/b.ts" },
    ]);
  });

  it("rejects unsafe worker output paths", () => {
    expect(() => assertRelativeWorkerOutputPath("src/App.tsx")).not.toThrow();
    expect(() => assertRelativeWorkerOutputPath("../secret.txt")).toThrow();
    expect(() => assertRelativeWorkerOutputPath("src/../secret.txt")).toThrow();
    expect(() => assertRelativeWorkerOutputPath("")).toThrow();
  });

  it("detects apply conflicts across accepted worker changes", () => {
    expect(
      detectWorkerApplyConflicts([
        {
          workerKey: "builder-ui",
          changes: [{ path: "src/components" }],
        },
        {
          workerKey: "builder-app",
          changes: [{ path: "src/components/App.tsx" }],
        },
        {
          workerKey: "builder-api",
          changes: [{ path: "src/server/api.ts" }],
        },
      ]),
    ).toEqual([
      {
        firstWorkerKey: "builder-ui",
        secondWorkerKey: "builder-app",
        overlappingFiles: ["src/components"],
      },
    ]);
  });
});
