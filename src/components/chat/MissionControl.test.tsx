import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Provider } from "jotai";
import { createStore } from "jotai/vanilla";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { selectedAppIdAtom } from "@/atoms/appAtoms";

const mocks = vi.hoisted(() => ({
  streamMessage: vi.fn(async () => {}),
  updateMissionStatus: vi.fn(async () => ({})),
}));

vi.mock("@/hooks/useSettings", () => ({
  useSettings: () => ({ settings: {} }),
}));

vi.mock("@/hooks/useStreamChat", () => ({
  useStreamChat: () => ({ streamMessage: mocks.streamMessage }),
}));

vi.mock("@/hooks/useMissions", () => ({
  useMissions: () => ({
    missions: [],
    mission: {
      id: 21,
      appId: 8,
      chatId: 7,
      title: "Build MediaForge Studio",
      goal: "Build the complete MediaForge Studio desktop app.",
      status: "cancelled",
      autonomyProfile: "trusted-workspace",
      createdAt: new Date("2026-07-20T00:00:00.000Z"),
      updatedAt: new Date("2026-07-20T00:00:00.000Z"),
      startedAt: new Date("2026-07-20T00:00:00.000Z"),
      completedAt: new Date("2026-07-20T00:01:00.000Z"),
    },
    events: [],
    tasks: [],
    runs: [],
    workers: [],
    checkpoints: [],
    artifacts: [],
    interrupts: [],
    memories: [],
    permissionRequests: [],
    createMission: vi.fn(),
    updateMissionStatus: mocks.updateMissionStatus,
    createMissionWorker: vi.fn(),
    dispatchMissionWorkers: vi.fn(),
    retryMissionWorker: vi.fn(),
    markStaleMissionWorkers: vi.fn(),
    prepareMissionWorkerWorkspace: vi.fn(),
    setMissionWorkerIntegrationStatus: vi.fn(),
    runReadyMissionWorkers: vi.fn(),
    applyAcceptedMissionWorkerOutputs: vi.fn(),
    cleanupAppliedMissionWorkerWorkspaces: vi.fn(),
    resolveMissionPermissionRequest: vi.fn(),
  }),
}));

import { MissionControl } from "./MissionControl";

describe("MissionControl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resumes a mission by submitting its saved goal to the local agent", async () => {
    const store = createStore();
    store.set(selectedAppIdAtom, 8);
    render(
      <Provider store={store}>
        <MissionControl chatId={7} />
      </Provider>,
    );

    expect(screen.getByText("Cancelled")).toBeTruthy();
    fireEvent.click(screen.getAllByTitle("Resume mission")[0]);

    await waitFor(() => {
      expect(mocks.updateMissionStatus).toHaveBeenCalledWith({
        missionId: 21,
        status: "queued",
      });
      expect(mocks.streamMessage).toHaveBeenCalledWith({
        prompt: "Build the complete MediaForge Studio desktop app.",
        chatId: 7,
        requestedChatMode: "local-agent",
        missionId: 21,
      });
    });
  });
});
