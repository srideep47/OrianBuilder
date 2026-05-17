/**
 * Classified application errors for IPC/main-process code.
 * Use {@link OrianBuilderError} with a {@link OrianBuilderErrorKind} so telemetry can ignore
 * high-volume, non-actionable failures (see `shouldFilterTelemetryException`).
 */

export enum OrianBuilderErrorKind {
  Validation = "validation",
  NotFound = "not_found",
  Auth = "auth",
  Precondition = "precondition",
  Conflict = "conflict",
  UserCancelled = "user_cancelled",
  RateLimited = "rate_limited",
  /** Upstream failures; reported to PostHog by default unless you add finer metadata later. */
  External = "external",
  /** Bugs, invariant violations, unexpected failures — always reported. */
  Internal = "internal",
  /** Unclassified; treated as reportable until call sites are migrated. */
  Unknown = "unknown",
}

const TELEMETRY_FILTERED_KINDS: ReadonlySet<OrianBuilderErrorKind> = new Set([
  OrianBuilderErrorKind.Validation,
  OrianBuilderErrorKind.NotFound,
  OrianBuilderErrorKind.Auth,
  OrianBuilderErrorKind.Precondition,
  OrianBuilderErrorKind.Conflict,
  OrianBuilderErrorKind.UserCancelled,
  OrianBuilderErrorKind.RateLimited,
]);

/**
 * Returns true if this kind should not be sent to PostHog as an `$exception` event.
 */
export function isOrianBuilderErrorKindFilteredFromTelemetry(
  kind: OrianBuilderErrorKind,
): boolean {
  return TELEMETRY_FILTERED_KINDS.has(kind);
}

export class OrianBuilderError extends Error {
  readonly kind: OrianBuilderErrorKind;

  constructor(message: string, kind: OrianBuilderErrorKind) {
    super(message);
    this.name = "OrianBuilderError";
    this.kind = kind;
  }
}

export function isOrianBuilderError(
  error: unknown,
): error is OrianBuilderError {
  return error instanceof OrianBuilderError;
}
