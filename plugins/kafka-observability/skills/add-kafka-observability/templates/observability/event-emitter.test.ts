// Unit tests for RunEventEmitter / runToEventData (src/observability/event-emitter.ts)
// with a fake producer — no Kafka client involved.
// Run after build: node --test dist/observability/event-emitter.test.js

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Run } from "@langchain/core/tracers/base";
import { RunEventEmitter, runToEventData } from "./event-emitter.js";
import type { EventProducer } from "./event-producer.js";
import type { ObservabilityEvent } from "./schemas.js";

class FakeProducer implements EventProducer {
  readonly produced: Array<{ topic: string; key: string; value: Buffer }> = [];
  produce(topic: string, key: string, value: Buffer): void {
    this.produced.push({ topic, key, value });
  }
}

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "run-1",
    name: "agent",
    run_type: "chain",
    trace_id: "trace-1",
    inputs: { question: "hello" },
    start_time: 1754179200000,
    execution_order: 1,
    child_runs: [],
    child_execution_order: 1,
    events: [],
    ...overrides,
  } as unknown as Run;
}

function lastEvent(producer: FakeProducer): ObservabilityEvent {
  const last = producer.produced[producer.produced.length - 1];
  return JSON.parse(last.value.toString("utf-8")) as ObservabilityEvent;
}

describe("runToEventData", () => {
  test("request direction carries inputs + serialized, no outputs/status", () => {
    const data = runToEventData(makeRun({ serialized: { lc: 1 } as never }), "request");
    assert.equal(data.direction, "request");
    assert.deepEqual(data.inputs, { question: "hello" });
    assert.deepEqual(data.serialized, { lc: 1 });
    assert.equal(data.outputs, undefined);
    assert.equal(data.status, undefined);
  });

  test("response direction carries outputs, success status, and latency", () => {
    const run = makeRun({ outputs: { content: "ok" } as never, end_time: 1754179201500 });
    const data = runToEventData(run, "response");
    assert.equal(data.direction, "response");
    assert.deepEqual(data.outputs, { content: "ok" });
    assert.equal(data.status, "success");
    assert.equal(data.latency_ms, 1500);
    assert.equal(data.end_time, new Date(1754179201500).toISOString());
  });

  test("a run with an error becomes status=error and keeps the error string", () => {
    const data = runToEventData(makeRun({ error: "boom", end_time: 1754179201000 }), "response");
    assert.equal(data.status, "error");
    assert.equal(data.error, "boom");
  });

  test("streaming new_token events survive but their chunk kwarg is stripped (edge case)", () => {
    const run = makeRun({
      events: [
        { name: "start", time: "t0" },
        { name: "new_token", time: "t1", kwargs: { token: "x", chunk: { big: "object" } } },
      ],
    });
    const data = runToEventData(run, "response");
    assert.deepEqual(data.events, [
      { name: "start", time: "t0" },
      { name: "new_token", time: "t1", kwargs: { token: "x" } },
    ]);
  });

  test("metadata is projected from run.extra.metadata", () => {
    const run = makeRun({ extra: { metadata: { thread_id: "t-9", langgraph_node: "agent" } } as never });
    const data = runToEventData(run, "request");
    assert.deepEqual(data.metadata, { thread_id: "t-9", langgraph_node: "agent" });
  });

  test("unserializable inputs degrade to a marker instead of throwing (edge case)", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const data = runToEventData(makeRun({ inputs: circular as never }), "request");
    assert.ok(
      typeof (data.inputs as Record<string, unknown>).__unserializable === "string",
      "expected an __unserializable marker",
    );
  });
});

describe("RunEventEmitter", () => {
  test("produces a schema-valid envelope keyed by the event's own id (NOT thread_id)", () => {
    const producer = new FakeProducer();
    const emitter = new RunEventEmitter(producer, "test_app", "observability-events");
    emitter.emitRun("thread-1", makeRun(), "request");

    assert.equal(producer.produced.length, 1);
    const { topic, key } = producer.produced[0];
    const event = lastEvent(producer);
    assert.equal(topic, "observability-events");
    assert.equal(key, event.id, "Kafka key must be the event id (the ES sink upserts by key)");
    assert.notEqual(key, "thread-1");
    assert.equal(event.thread_id, "thread-1");
    assert.equal(event.application_name, "test_app");
    assert.equal(event.data.run_id, "run-1");
  });

  test("redacts sensitive keys inside inputs before producing", () => {
    const producer = new FakeProducer();
    const emitter = new RunEventEmitter(producer, "test_app", "t");
    const run = makeRun({
      inputs: { api_key: "sk-secret", note: "password=hunter2;host=db" } as never,
    });
    emitter.emitRun("thread-1", run, "request");
    const inputs = lastEvent(producer).data.inputs as Record<string, unknown>;
    assert.equal(inputs.api_key, "***REDACTED***");
    assert.equal(inputs.note, "password=***REDACTED***;host=db");
  });

  test("an event over 512 KB is replaced by a truncation marker (edge case)", () => {
    const producer = new FakeProducer();
    const emitter = new RunEventEmitter(producer, "test_app", "t");
    const run = makeRun({ inputs: { blob: "x".repeat(600 * 1024) } as never });
    emitter.emitRun("thread-1", run, "request");

    const event = lastEvent(producer) as unknown as {
      id: string;
      thread_id: string;
      data: { type: string; original_bytes: number; sha256: string };
    };
    assert.equal(event.data.type, "truncated");
    assert.ok(event.data.original_bytes > 512 * 1024);
    assert.equal(event.data.sha256.length, 64);
    assert.equal(event.thread_id, "thread-1", "envelope correlation survives truncation");
    assert.ok(producer.produced[0].value.length < 4096, "truncated payload is small");
  });
});
