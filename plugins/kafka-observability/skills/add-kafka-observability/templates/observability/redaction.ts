// FILE: src/observability/redaction.ts
//
// Redacts sensitive fields before any observability payload is serialized.
// Pure, recursive, no dependency on the rest of the module — usable in
// isolation and unit-testable without a producer/broker.

const SENSITIVE_KEY_PATTERN =
  /(authorization|api[_-]?key|password|token|secret|credential|connection[_-]?string)/i;

const CONNECTION_STRING_PASSWORD_PATTERN = /password=[^;&\s]+/gi;

const REDACTED = "***REDACTED***";

function redactString(value: string): string {
  // .replace() is a no-op on a non-matching string, so this needs no separate
  // .test() guard — avoids relying on a shared /g regex's stateful lastIndex.
  return value.replace(CONNECTION_STRING_PASSWORD_PATTERN, `password=${REDACTED}`);
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") return redact(value as Record<string, unknown>);
  return value;
}

/** Recursively redacts sensitive keys (case-insensitive substring match) and
 *  `password=`-shaped connection-string fragments inside string values.
 *  Generic so callers keep their concrete type (e.g. `EventData`) instead of
 *  widening to `Record<string, unknown>` and casting back. */
export function redact<T extends Record<string, unknown>>(data: T): T {
  const out = {} as Record<string, unknown>;
  for (const [key, value] of Object.entries(data)) {
    out[key] = SENSITIVE_KEY_PATTERN.test(key) ? REDACTED : redactValue(value);
  }
  return out as T;
}
