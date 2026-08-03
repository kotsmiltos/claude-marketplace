// Unit tests for redact() (src/observability/redaction.ts). Pure — no I/O.
// Run after build: node --test dist/observability/redaction.test.js

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { redact } from "./redaction.js";

describe("redact — sensitive key detection", () => {
  test("redacts an exact sensitive key", () => {
    assert.deepEqual(redact({ password: "hunter2" }), { password: "***REDACTED***" });
  });

  test("is case-insensitive", () => {
    assert.deepEqual(redact({ Password: "x", API_KEY: "y" }), {
      Password: "***REDACTED***",
      API_KEY: "***REDACTED***",
    });
  });

  test("matches snake_case, kebab-case, and camelCase variants (edge case)", () => {
    assert.deepEqual(
      redact({ api_key: "a", "api-key": "b", apiKey: "c" }),
      { api_key: "***REDACTED***", "api-key": "***REDACTED***", apiKey: "***REDACTED***" },
    );
  });

  test("matches every documented sensitive key kind", () => {
    const input: Record<string, string> = {
      authorization: "Bearer x",
      token: "t",
      secret: "s",
      credential: "c",
      connection_string: "Server=...;Password=p",
    };
    const out = redact(input);
    for (const key of Object.keys(input)) {
      assert.equal(out[key], "***REDACTED***", `expected ${key} to be redacted`);
    }
  });

  test("substring match redacts a key merely containing a sensitive word (edge case, by design)", () => {
    // Documented behavior: substring match, not exact — "tokenized_count" contains "token".
    assert.deepEqual(redact({ tokenized_count: 3 }), { tokenized_count: "***REDACTED***" });
  });

  test("leaves non-sensitive keys untouched", () => {
    assert.deepEqual(redact({ step_name: "route", latency_ms: 12 }), {
      step_name: "route",
      latency_ms: 12,
    });
  });
});

describe("redact — nested structures", () => {
  test("recurses into nested objects", () => {
    assert.deepEqual(redact({ outer: { password: "x", ok: true } }), {
      outer: { password: "***REDACTED***", ok: true },
    });
  });

  test("recurses into arrays of objects", () => {
    assert.deepEqual(redact({ items: [{ token: "a" }, { token: "b" }] }), {
      items: [{ token: "***REDACTED***" }, { token: "***REDACTED***" }],
    });
  });

  test("leaves arrays of primitives untouched", () => {
    assert.deepEqual(redact({ tags: ["a", "b", 1] }), { tags: ["a", "b", 1] });
  });

  test("handles null and undefined values without throwing (edge case)", () => {
    assert.deepEqual(redact({ a: null, b: undefined, password: null }), {
      a: null,
      b: undefined,
      password: "***REDACTED***",
    });
  });

  test("handles an empty object (edge case)", () => {
    assert.deepEqual(redact({}), {});
  });
});

describe("redact — connection-string password= detection", () => {
  test("redacts a password= fragment inside an otherwise non-sensitive-keyed string", () => {
    const out = redact({ db_summary: "Server=x;Database=y;Password=hunter2;Encrypt=true" });
    // Matched case-insensitively, but the replacement text itself is lowercase.
    assert.equal(out.db_summary, "Server=x;Database=y;password=***REDACTED***;Encrypt=true");
  });

  test("is case-insensitive on the password= fragment (normalizes the key to lowercase)", () => {
    const out = redact({ note: "PASSWORD=abc" });
    assert.equal(out.note, "password=***REDACTED***");
  });

  test("redacts every password= occurrence in a string, including as a substring (edge case)", () => {
    // The pattern isn't anchored to a word boundary, so "OtherPassword=b"
    // also matches on its "Password=" suffix — both fragments get redacted.
    const out = redact({ note: "Password=a;OtherPassword=b" });
    assert.equal(out.note, "password=***REDACTED***;Otherpassword=***REDACTED***");
  });

  test("leaves a string with no password= fragment untouched", () => {
    const out = redact({ note: "no secrets here" });
    assert.equal(out.note, "no secrets here");
  });
});
