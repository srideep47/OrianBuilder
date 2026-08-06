import { afterEach, describe, expect, it, vi } from "vitest";

import { MicSession } from "./mic_session";

const originalMediaDevices = navigator.mediaDevices;

afterEach(() => {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: originalMediaDevices,
  });
});

function installGetUserMedia(getUserMedia: () => Promise<MediaStream>): void {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
}

describe("MicSession lifecycle", () => {
  it("stops a stream that arrives after the user already toggled off", async () => {
    let provideStream!: (stream: MediaStream) => void;
    const stop = vi.fn();
    const stream = {
      getTracks: () => [{ stop }],
      getAudioTracks: () => [{ stop }],
    } as unknown as MediaStream;
    installGetUserMedia(
      () => new Promise<MediaStream>((resolve) => (provideStream = resolve)),
    );
    const session = new MicSession({ onFrame: vi.fn(), onError: vi.fn() });

    const opening = session.open();
    await Promise.resolve();
    await session.close();
    provideStream(stream);

    await expect(opening).rejects.toMatchObject({ name: "AbortError" });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(session.isOpen).toBe(false);
    expect(session.getHealth().state).toBe("closed");
  });

  it("shares one permission request across duplicate opens and reports failure", async () => {
    const denied = new DOMException("Permission denied", "NotAllowedError");
    const getUserMedia = vi.fn(async () => {
      throw denied;
    });
    installGetUserMedia(getUserMedia);
    const session = new MicSession({ onFrame: vi.fn(), onError: vi.fn() });

    const first = session.open();
    const second = session.open();
    await expect(first).rejects.toBe(denied);
    await expect(second).rejects.toBe(denied);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(session.getHealth()).toMatchObject({
      state: "error",
      detail: "Permission denied",
    });
  });
});
