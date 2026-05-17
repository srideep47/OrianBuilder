const DEFAULT_TEXT_LIMIT_BYTES = 64 * 1024;
const ARTIFACT_BODY_LIMIT_BYTES = 128 * 1024;
const METADATA_LIMIT_BYTES = 32 * 1024;
const METADATA_STRING_LIMIT_BYTES = 8 * 1024;
const SUMMARY_LIMIT_CHARS = 300;
const MAX_METADATA_DEPTH = 6;
const MAX_METADATA_ARRAY_ITEMS = 50;
const MAX_METADATA_OBJECT_KEYS = 80;

const SENSITIVE_KEY_PATTERN =
  /(api[_-]?key|authorization|bearer|cookie|credential|password|secret|token)/i;

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/(authorization\s*[:=]\s*)bearer\s+[a-z0-9._~+/=-]+/gi, "$1[REDACTED]"],
  [/(api[_-]?key\s*[:=]\s*)["']?[^"',\s}]+/gi, "$1[REDACTED]"],
  [/(password\s*[:=]\s*)["']?[^"',\s}]+/gi, "$1[REDACTED]"],
  [/(secret\s*[:=]\s*)["']?[^"',\s}]+/gi, "$1[REDACTED]"],
  [/(token\s*[:=]\s*)["']?[^"',\s}]+/gi, "$1[REDACTED]"],
  [/(cookie\s*[:=]\s*)["']?[^"',\r\n}]+/gi, "$1[REDACTED]"],
  [/\bsk-[a-z0-9_-]{20,}\b/gi, "[REDACTED_API_KEY]"],
  [/\b[a-z0-9_]*pat_[a-z0-9_-]{20,}\b/gi, "[REDACTED_TOKEN]"],
];

export type MissionTextKind = "summary" | "body" | "artifact_body";

export function sanitizeMissionText(
  value: string | null | undefined,
  kind: MissionTextKind = "body",
) {
  if (value == null) {
    return value ?? null;
  }

  const redacted = redactSensitiveText(value);
  if (kind === "summary") {
    return truncateChars(redacted, SUMMARY_LIMIT_CHARS);
  }

  return truncateBytes(
    redacted,
    kind === "artifact_body"
      ? ARTIFACT_BODY_LIMIT_BYTES
      : DEFAULT_TEXT_LIMIT_BYTES,
  );
}

export function sanitizeMissionMetadata(
  metadata: Record<string, unknown> | null | undefined,
) {
  if (!metadata) {
    return null;
  }

  const sanitized = sanitizeMetadataValue(metadata, 0);
  if (!isRecord(sanitized)) {
    return {
      value: sanitized,
    };
  }

  const json = safeStringify(sanitized);
  if (byteLength(json) <= METADATA_LIMIT_BYTES) {
    return sanitized;
  }

  return {
    truncated: true,
    originalBytes: byteLength(json),
    preview: truncateBytes(json, METADATA_LIMIT_BYTES),
  };
}

export function redactSensitiveText(value: string) {
  return SECRET_PATTERNS.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    value,
  );
}

function sanitizeMetadataValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") {
    return truncateBytes(
      redactSensitiveText(value),
      METADATA_STRING_LIMIT_BYTES,
    );
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value == null
  ) {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_METADATA_ARRAY_ITEMS)
      .map((item) => sanitizeMetadataValue(item, depth + 1));
    if (value.length > MAX_METADATA_ARRAY_ITEMS) {
      items.push(
        `[${value.length - MAX_METADATA_ARRAY_ITEMS} items truncated]`,
      );
    }
    return items;
  }
  if (!isRecord(value)) {
    return String(value);
  }
  if (depth >= MAX_METADATA_DEPTH) {
    return "[metadata depth limit reached]";
  }

  const entries = Object.entries(value);
  const result: Record<string, unknown> = {};
  for (const [key, entryValue] of entries.slice(0, MAX_METADATA_OBJECT_KEYS)) {
    result[key] = SENSITIVE_KEY_PATTERN.test(key)
      ? "[REDACTED]"
      : sanitizeMetadataValue(entryValue, depth + 1);
  }
  if (entries.length > MAX_METADATA_OBJECT_KEYS) {
    result.truncatedKeys = entries.length - MAX_METADATA_OBJECT_KEYS;
  }
  return result;
}

function truncateChars(value: string, limit: number) {
  if (value.length <= limit) {
    return value;
  }
  return `${value.slice(0, limit)}...[truncated ${value.length - limit} chars]`;
}

function truncateBytes(value: string, limitBytes: number) {
  if (byteLength(value) <= limitBytes) {
    return value;
  }

  let end = Math.min(value.length, limitBytes);
  while (end > 0 && byteLength(value.slice(0, end)) > limitBytes) {
    end = Math.floor(end * 0.9);
  }
  const omittedBytes = byteLength(value.slice(end));
  return `${value.slice(0, end)}\n...[truncated ${omittedBytes} bytes]`;
}

function safeStringify(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify(String(value));
  }
}

function byteLength(value: string) {
  return Buffer.byteLength(value, "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
