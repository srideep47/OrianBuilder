/**
 * Watchdog that aborts a streaming LLM response when no chunks arrive within
 * a configurable timeout window. Local LLMs (llama.cpp, LM Studio, Ollama)
 * occasionally connect successfully then stall mid-response — without this
 * detector the whole turn hangs indefinitely.
 *
 * Pattern borrowed from bolt.diy's StreamRecoveryManager. Adapted for Dyad's
 * Vercel-AI-SDK streamText loop: call `pulse()` whenever a chunk arrives, and
 * the detector resets its timer; if the timer fires, it invokes `onStall` so
 * the caller can abort the AbortController and surface a clear error.
 */

/**
 * Synthetic error thrown when a streaming response stalls (no new chunks for
 * longer than the configured timeout). Recognized by
 * `shouldRetryTransientStreamError` so the outer retry loop kicks in.
 */
export class StreamStalledError extends Error {
  readonly elapsedMs: number;
  constructor(elapsedMs: number) {
    super(`Stream stalled for ${elapsedMs}ms with no new tokens.`);
    this.name = "StreamStalledError";
    this.elapsedMs = elapsedMs;
  }
}

export interface StreamStallDetectorOptions {
  /** Milliseconds without a chunk before the stream is considered stalled. */
  stallTimeoutMs: number;
  /** Called once when the stall timer fires. */
  onStall: (elapsedMs: number) => void;
}

export class StreamStallDetector {
  private timer: NodeJS.Timeout | null = null;
  private lastPulse = 0;
  private started = false;
  private fired = false;
  private readonly opts: StreamStallDetectorOptions;

  constructor(opts: StreamStallDetectorOptions) {
    this.opts = opts;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.fired = false;
    this.lastPulse = Date.now();
    this.arm();
  }

  pulse(): void {
    if (!this.started || this.fired) return;
    this.lastPulse = Date.now();
    this.arm();
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.started = false;
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (!this.started || this.fired) return;
      this.fired = true;
      const elapsed = Date.now() - this.lastPulse;
      this.opts.onStall(elapsed);
    }, this.opts.stallTimeoutMs);
  }
}
