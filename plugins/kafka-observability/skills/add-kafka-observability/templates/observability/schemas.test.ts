// Unit tests for the run-event zod schemas (src/observability/schemas.ts).
// Run after build: node --test dist/observability/schemas.test.js

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ObservabilityEventSchema, RunEventDataSchema } from "./schemas.js";

function validData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "run",
    direction: "request",
    run_id: "run-1",
    run_type: "chain",
    name: "agent",
    inputs: { messages: [] },
    start_time: "2026-08-03T00:00:00.000Z",
    ...overrides,
  };
}

function validEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "evt-1",
    thread_id: "thread-1",
    application_name: "test_app",
    timestamp: "2026-08-03T00:00:00.000Z",
    data: validData(),
    ...overrides,
  };
}

describe("RunEventDataSchema", () => {
  test("accepts a minimal request event", () => {
    assert.doesNotThrow(() => RunEventDataSchema.parse(validData()));
  });

  test("accepts a full response event with outputs, status, latency", () => {
    const data = validData({
      direction: "response",
      outputs: { content: "ok" },
      status: "success",
      end_time: "2026-08-03T00:00:01.000Z",
      latency_ms: 1000,
      events: [{ name: "new_token", time: "2026-08-03T00:00:00.500Z", kwargs: { token: "x" } }],
      trace_id: "trace-1",
      parent_run_id: "run-0",
      dotted_order: "20260803T000000000001Zrun-0.20260803T000000000002Zrun-1",
      metadata: { thread_id: "thread-1", langgraph_node: "agent" },
      tags: ["graph"],
    });
    assert.doesNotThrow(() => RunEventDataSchema.parse(data));
  });

  test("rejects a bad direction (edge case)", () => {
    assert.throws(() => RunEventDataSchema.parse(validData({ direction: "sideways" })));
  });

  test("rejects a missing run_id (edge case)", () => {
    const data = validData();
    delete data.run_id;
    assert.throws(() => RunEventDataSchema.parse(data));
  });

  test("rejects an empty run_type (edge case)", () => {
    assert.throws(() => RunEventDataSchema.parse(validData({ run_type: "" })));
  });
});

describe("ObservabilityEventSchema", () => {
  test("accepts a complete envelope", () => {
    assert.doesNotThrow(() => ObservabilityEventSchema.parse(validEvent()));
  });

  test("rejects an empty thread_id (edge case — envelope correlation is mandatory)", () => {
    assert.throws(() => ObservabilityEventSchema.parse(validEvent({ thread_id: "" })));
  });

  test("rejects an empty application_name (edge case)", () => {
    assert.throws(() => ObservabilityEventSchema.parse(validEvent({ application_name: "" })));
  });
});
