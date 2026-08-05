// FILE: src/observability/env.ts
//
// Self-contained fail-fast env helpers for the observability library. The
// library is vendored into many projects, so it must not depend on any
// project-level env module. No fallbacks for required vars — throws
// immediately, per the team's no-config-fallback rule.

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.length === 0) {
    throw new Error(`${name} environment variable is required.`);
  }
  return value;
}

export function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

export function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.length === 0) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${name} must be an integer. Got: "${raw}"`);
  }
  return parsed;
}

/** STRICT equality with the string "true" — deliberately NOT case-insensitive.
 *  The global callback hook (`registerConfigureHook` in index.ts) compares the
 *  env var strictly against "true"; this gate must agree with it exactly, or a
 *  value like "TRUE" would initialize the producer without ever attaching the
 *  tracer (or vice versa). */
export function boolEnv(name: string): boolean {
  return process.env[name] === "true";
}
