import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { test } from "./helpers/test_helper";

async function invoke<T>(page: Page, channel: string, input?: unknown) {
  return page.evaluate(
    async (params: { channel: string; input?: unknown }) =>
      (window as any).electron.ipcRenderer.invoke(params.channel, params.input),
    { channel, input } satisfies { channel: string; input?: unknown },
  ) as Promise<T>;
}

async function getLatestAppId(po: { page: Page }) {
  let latestAppId: number | null = null;
  await expect(async () => {
    const response = await invoke<{ apps: Array<{ id: number }> }>(
      po.page,
      "list-apps",
    );
    const app = response.apps.at(-1);
    expect(app).toBeTruthy();
    latestAppId = app!.id;
  }).toPass();
  return latestAppId!;
}

async function createMission(po: { page: Page }, appId: number) {
  const chat = await invoke<{ chatId: number }>(po.page, "create-chat", {
    appId,
    initialChatMode: "build",
  });
  const mission = await invoke<{ id: number; status: string }>(
    po.page,
    "mission:create",
    {
      appId,
      chatId: chat.chatId,
      title: "E2E hardening mission",
      goal: "Verify Phase 8 mission hardening.",
      autonomyProfile: "supervised",
    },
  );
  await invoke(po.page, "mission:update-status", {
    missionId: mission.id,
    status: "running",
  });
  return { missionId: mission.id, chatId: chat.chatId };
}

test("mission hardening - gates block completion until waived", async ({
  po,
}) => {
  await po.setUp();
  await po.importApp("minimal");
  const appId = await getLatestAppId(po);
  const { missionId } = await createMission(po, appId);

  await invoke(po.page, "mission:add-event", {
    missionId,
    eventType: "post_create_verification_required",
    summary: "Post-create verification required",
    metadata: {
      gate: "post_create_verification",
      requiredChecks: ["typecheck", "build"],
    },
  });
  await invoke(po.page, "mission:add-event", {
    missionId,
    eventType: "browser_qa_gate_failed",
    summary: "Browser QA runtime gate failed",
    metadata: {
      gate: "runtime",
      status: "failed",
      previewUrl: "http://localhost:5173",
    },
  });

  await expect(
    invoke(po.page, "mission:update-status", {
      missionId,
      status: "completed",
    }),
  ).rejects.toThrow(/Cannot complete mission/);

  await invoke(po.page, "mission:update-status", {
    missionId,
    status: "completed",
    waiveIncompleteGates: true,
    waiverReason: "E2E validates explicit waiver behavior.",
  });

  const events = await invoke<
    Array<{ eventType: string; metadata: Record<string, unknown> | null }>
  >(po.page, "mission:list-events", { missionId });
  expect(
    events.some((event) => event.eventType === "browser_qa_gate_failed"),
  ).toBe(true);
  expect(
    events.some(
      (event) => event.eventType === "post_create_verification_waived",
    ),
  ).toBe(true);
});

test("mission hardening - permission requests approve and deny", async ({
  po,
}) => {
  await po.setUp();
  await po.importApp("minimal");
  const appId = await getLatestAppId(po);
  const { missionId } = await createMission(po, appId);

  const approveRequest = await invoke<{ id: number }>(
    po.page,
    "mission:create-permission-request",
    {
      missionId,
      action: "Run project checks",
      risk: "medium",
      reason: "Validate permission approval from Mission Control.",
    },
  );
  const denyRequest = await invoke<{ id: number }>(
    po.page,
    "mission:create-permission-request",
    {
      missionId,
      action: "Deploy preview",
      risk: "high",
      reason: "Validate permission denial from Mission Control.",
    },
  );

  await invoke(po.page, "mission:resolve-permission-request", {
    requestId: approveRequest.id,
    status: "approved",
  });
  await invoke(po.page, "mission:resolve-permission-request", {
    requestId: denyRequest.id,
    status: "denied",
  });

  const requests = await invoke<Array<{ action: string; status: string }>>(
    po.page,
    "mission:list-permission-requests",
    { missionId },
  );
  expect(requests).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        action: "Run project checks",
        status: "approved",
      }),
      expect.objectContaining({
        action: "Deploy preview",
        status: "denied",
      }),
    ]),
  );
});

test("mission hardening - worker dispatch report and review flow", async ({
  po,
}) => {
  await po.setUp();
  await po.importApp("minimal");
  const appId = await getLatestAppId(po);
  const { missionId } = await createMission(po, appId);

  const planner = await invoke<{ id: number }>(
    po.page,
    "mission:create-worker",
    {
      missionId,
      workerKey: "planner",
      role: "planner",
      title: "Plan work",
      goal: "Split the mission.",
    },
  );
  const builder = await invoke<{ id: number }>(
    po.page,
    "mission:create-worker",
    {
      missionId,
      workerKey: "builder-ui",
      role: "builder",
      title: "Build UI",
      goal: "Implement UI changes.",
      dependsOn: ["planner"],
    },
  );

  await invoke(po.page, "mission:dispatch-workers", {
    missionId,
    status: "ready",
  });
  await invoke(po.page, "mission:update-worker-status", {
    workerId: planner.id,
    status: "completed",
  });
  await invoke(po.page, "mission:dispatch-workers", {
    missionId,
    status: "ready",
  });
  await invoke(po.page, "mission:submit-worker-report", {
    workerId: builder.id,
    complete: true,
    report: {
      summary: "Implemented UI slice.",
      changedFiles: ["src/App.tsx"],
      validation: "npm test",
      artifacts: ["preview.png"],
    },
  });
  await invoke(po.page, "mission:set-worker-integration-status", {
    workerId: builder.id,
    status: "applied",
    reason: "Accepted by E2E review.",
  });

  const workers = await invoke<
    Array<{ workerKey: string; status: string; metadata: Record<string, any> }>
  >(po.page, "mission:list-workers", { missionId });
  expect(workers).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        workerKey: "planner",
        status: "completed",
      }),
      expect.objectContaining({
        workerKey: "builder-ui",
        status: "completed",
        metadata: expect.objectContaining({
          integrationStatus: "applied",
          report: expect.objectContaining({
            summary: "Implemented UI slice.",
          }),
        }),
      }),
    ]),
  );
});
