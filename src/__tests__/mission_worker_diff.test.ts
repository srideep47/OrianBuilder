import { describe, expect, it } from "vitest";

import { parseWorkerUnifiedDiff } from "@/ipc/utils/mission_worker_diff";

describe("mission worker diff parsing", () => {
  it("splits unified diff output by file and counts changes", () => {
    const files = parseWorkerUnifiedDiff(`diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 const a = 1;
-const b = 2;
+const b = 3;
+const c = 4;
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -1 +1 @@
-old
+new`);

    expect(files).toMatchObject([
      {
        displayPath: "src/a.ts",
        additions: 2,
        deletions: 1,
      },
      {
        displayPath: "src/b.ts",
        additions: 1,
        deletions: 1,
      },
    ]);
  });

  it("returns no files for empty diff bodies", () => {
    expect(parseWorkerUnifiedDiff(null)).toEqual([]);
    expect(parseWorkerUnifiedDiff("")).toEqual([]);
  });
});
