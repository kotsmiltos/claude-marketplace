// FILE: src/agent-step/run/value-equal.ts
//
// Deep VALUE equality over canonicalized JSON shapes. Two consumers, both
// safety-relevant, both requiring the same rule (reference identity must
// never count):
//   - the confirmation gate's propose→execute params match
//     (interaction/confirmation.ts),
//   - the `invalidatesOnChange` change detection (run/execution.ts) — an
//     executor writing a fresh-but-value-equal object is NOT a change.

/** Deep recursive copy that sorts every object's keys, making
 *  `JSON.stringify` order-stable so two payloads with the same field values
 *  but different insertion order compare equal. */
function canonicalize(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(canonicalize);
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  // Null prototype: on a plain `{}`, `out["__proto__"] = x` would SET THE
  // PROTOTYPE instead of defining an own property, silently dropping an own
  // `__proto__` key from the canonical form — two payloads differing only in
  // that key would compare equal.
  const out: Record<string, unknown> = Object.create(null);
  for (const k of keys) out[k] = canonicalize(obj[k]);
  return out;
}

export function valueEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
}
