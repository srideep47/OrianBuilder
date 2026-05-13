import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StreamStallDetector, StreamStalledError } from "./stall_detector";

describe("StreamStallDetector", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires onStall after timeout with no pulses", () => {
    const onStall = vi.fn();
    const d = new StreamStallDetector({ stallTimeoutMs: 1000, onStall });
    d.start();

    vi.advanceTimersByTime(1000);

    expect(onStall).toHaveBeenCalledTimes(1);
    expect(onStall.mock.calls[0][0]).toBeGreaterThanOrEqual(1000);
  });

  it("does not fire when pulses arrive within the window", () => {
    const onStall = vi.fn();
    const d = new StreamStallDetector({ stallTimeoutMs: 1000, onStall });
    d.start();

    vi.advanceTimersByTime(500);
    d.pulse();
    vi.advanceTimersByTime(500);
    d.pulse();
    vi.advanceTimersByTime(500);

    expect(onStall).not.toHaveBeenCalled();
  });

  it("fires once even with multiple stalls", () => {
    const onStall = vi.fn();
    const d = new StreamStallDetector({ stallTimeoutMs: 1000, onStall });
    d.start();

    vi.advanceTimersByTime(2000);
    vi.advanceTimersByTime(2000);

    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it("stop() cancels the timer", () => {
    const onStall = vi.fn();
    const d = new StreamStallDetector({ stallTimeoutMs: 1000, onStall });
    d.start();
    d.stop();

    vi.advanceTimersByTime(2000);

    expect(onStall).not.toHaveBeenCalled();
  });

  it("pulse() after stop() is a no-op", () => {
    const onStall = vi.fn();
    const d = new StreamStallDetector({ stallTimeoutMs: 1000, onStall });
    d.start();
    d.stop();
    d.pulse();

    vi.advanceTimersByTime(2000);

    expect(onStall).not.toHaveBeenCalled();
  });
});

describe("StreamStalledError", () => {
  it("has name StreamStalledError and elapsedMs", () => {
    const err = new StreamStalledError(45_000);
    expect(err.name).toBe("StreamStalledError");
    expect(err.elapsedMs).toBe(45_000);
    expect(err.message).toContain("45000");
    expect(err).toBeInstanceOf(Error);
  });
});
