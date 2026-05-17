import { testSkipIfWindows } from "./helpers/test_helper";

testSkipIfWindows("orianbuilder tags handles nested < tags", async ({ po }) => {
  await po.setUp({ autoApprove: true });
  await po.importApp("minimal");
  await po.sendPrompt("tc=orianbuilder-write-angle");
  await po.snapshotAppFiles({ name: "angle-tags-handled" });
});
