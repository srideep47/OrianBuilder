import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useEmbeddedModelStatus } from "@/hooks/useEmbeddedModelStatus";

const { getStatusMock, statusListeners } = vi.hoisted(() => ({
  getStatusMock: vi.fn(),
  statusListeners: new Set<(payload: unknown) => void>(),
}));

vi.mock("@/ipc/types", () => ({
  ipc: {
    embeddedModel: {
      getStatus: getStatusMock,
    },
    events: {
      embeddedModel: {
        onStatusChanged: (listener: (payload: unknown) => void) => {
          statusListeners.add(listener);
          return () => statusListeners.delete(listener);
        },
      },
    },
  },
}));

function makeStatus(modelName: string | null) {
  return {
    running: true,
    modelLoaded: Boolean(modelName),
    modelPath: modelName ? `D:/models/${modelName}` : null,
    modelName,
    isLoading: false,
    isInferring: false,
    backend: modelName ? "llama-cpp" : "none",
    tensorRtRunnerAvailable: false,
    tensorRtRuntimeAvailable: false,
    tensorRtRuntimePath: null,
    tensorRtEngineDir: null,
    tensorRtEngineFormat: null,
    gpuLayers: 0,
    totalLayers: 0,
    cpuLayers: 0,
    actualContextSize: 0,
    chatWrapperLabel: null,
  };
}

function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  function Wrapper({ children }: PropsWithChildren) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  }

  return { Wrapper };
}

describe("useEmbeddedModelStatus", () => {
  beforeEach(() => {
    statusListeners.clear();
    getStatusMock.mockReset();
  });

  it("invalidates and refetches when the embedded status event fires", async () => {
    getStatusMock
      .mockResolvedValueOnce(makeStatus("Qwen3.6-35B.gguf"))
      .mockResolvedValueOnce(makeStatus("Qwen3.6-27B.gguf"));

    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useEmbeddedModelStatus(), {
      wrapper: Wrapper,
    });

    await waitFor(() =>
      expect(result.current.data?.modelName).toBe("Qwen3.6-35B.gguf"),
    );

    for (const listener of statusListeners) {
      listener(makeStatus("Qwen3.6-27B.gguf"));
    }

    await waitFor(() =>
      expect(result.current.data?.modelName).toBe("Qwen3.6-27B.gguf"),
    );
    expect(getStatusMock).toHaveBeenCalledTimes(2);
  });
});
