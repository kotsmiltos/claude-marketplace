// FILE: src/observability/backend-trace.test.ts
//
// Pure unit tests (no Kafka broker — the producer is a test double) for
// backend-trace.ts. The point of that module is that stdout is NOT a durable
// sink, so these assertions are about what actually reaches the KAFKA payload:
//   1. it is COMPLETE   — run name, tags, backend metadata, attempt number,
//                         thread_id, and a parent link placing the call under
//                         the node that issued it;
//   2. it is SPLIT      — the caller receives the REAL result while only the
//                         `logged` view reaches the emitted payload (this
//                         library's redaction is credential-only, so the
//                         {result, logged} split is the PII boundary);
//   3. it is HONEST     — a throw propagates to the caller AND is recorded on
//                         the run, and a retried call shows up as one run per
//                         attempt.
// The real RunEventEmitter is used (not a stub) so redaction, zod validation
// and serialization are all exercised on the true path.

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { RunnableLambda } from "@langchain/core/runnables";

import { RunEventEmitter } from "./event-emitter.js";
import { KafkaRunTracer } from "./run-tracer.js";
import type { ObservabilityEvent } from "./schemas.js";
import type { EventProducer } from "./event-producer.js";
import { traceBackendCall, withAttemptContext, currentAttempt } from "./backend-trace.js";

const THREAD_ID = "thread-backend-trace-1";

// A response SHAPED like a real backend body: the sensitive value sits under a
// generic key no credential net can know about. The test masks it into the
// `logged` view exactly as a project's domain redaction would — and then
// asserts the real value never reaches the emitted bytes.
const REAL_RESPONSE = {
  payload: { accounts: [{ number: "5310123456786083", cardType: "Debit" }] },
};
const MASKED_RESPONSE = {
  payload: { accounts: [{ number: "***", cardType: "Debit" }] },
};

class CapturingProducer implements EventProducer {
  readonly payloads: Buffer[] = [];
  produce(_topic: string, _key: string, value: Buffer): void {
    this.payloads.push(value);
  }
  events(): ObservabilityEvent[] {
    return this.payloads.map((b) => JSON.parse(b.toString("utf-8")) as ObservabilityEvent);
  }
  /** The payload-bearing fields of every emitted event, as one string — the
   *  surface a leak test must scan. Deliberately EXCLUDES the structural
   *  fields (`dotted_order`, timestamps, ids), whose LangChain-generated
   *  values legitimately contain long digit runs. */
  raw(): string {
    return this.events()
      .map((e) =>
        JSON.stringify({
          name: e.data.name,
          metadata: e.data.metadata,
          inputs: e.data.inputs,
          outputs: e.data.outputs,
          error: e.data.error,
        }),
      )
      .join("\n");
  }
}

let producer: CapturingProducer;
let tracer: KafkaRunTracer;

/** Invoke `fn` as if it were running inside a LangGraph node: a parent run
 *  that carries the tracer and the thread_id, with AsyncLocalStorage set up so
 *  the HTTP run nests underneath — the same inheritance production relies on.
 *  The parent deliberately returns a CONSTANT, never the traced call's result,
 *  so the scaffolding itself cannot be what leaks a real value. */
async function insideNode<T>(fn: () => Promise<T>): Promise<T> {
  let out!: T;
  await RunnableLambda.from(async () => {
    out = await fn();
    return "node-done";
  })
    .withConfig({ runName: "agent_node" })
    .invoke({}, { callbacks: [tracer], metadata: { thread_id: THREAD_ID } });
  return out;
}

/** The emitted events for the HTTP child run only. */
function httpEvents(endpoint: string): ObservabilityEvent[] {
  return producer.events().filter((e) => e.data.name === `http:${endpoint}`);
}

function cardsCall(): Promise<typeof REAL_RESPONSE> {
  return traceBackendCall(
    {
      endpoint: "position/GetCardsByCustomer",
      baseUrl: "https://backend.example/api",
      envelope: "default",
      input: { payload: { customerCode: "***7890" } },
    },
    async () => ({
      result: REAL_RESPONSE,
      logged: { status: 200, latency_ms: 12, response: MASKED_RESPONSE },
    }),
  );
}

beforeEach(() => {
  // Determinism: callbacks inline instead of on LangChain's background
  // p-queue, so an error-path run is fully emitted by the time invoke()
  // resolves (read by BaseCallbackHandler's constructor, hence set before
  // `new` below). LangSmith off so no test pays a network timeout.
  process.env.LANGCHAIN_CALLBACKS_BACKGROUND = "false";
  process.env.LANGSMITH_TRACING = "false";
  producer = new CapturingProducer();
  tracer = new KafkaRunTracer({
    emitter: new RunEventEmitter(producer, "sample_agent", "observability-events"),
  });
});

describe("traceBackendCall", () => {
  test("a successful call emits a request + response pair, nested and thread-correlated", async () => {
    const result = await insideNode(() => cardsCall());

    // The CALLER gets the real, unmasked body — masking is telemetry-only.
    assert.equal(result.payload.accounts[0].number, "5310123456786083");

    const events = httpEvents("position/GetCardsByCustomer");
    assert.equal(events.length, 2, "one request + one response event");
    const [request, response] = events;
    assert.equal(request.data.direction, "request");
    assert.equal(response.data.direction, "response");

    // Correlation + placement in the trace tree.
    for (const e of events) {
      assert.equal(e.thread_id, THREAD_ID, "enveloped with the conversation thread");
      assert.ok(e.data.parent_run_id, "nested under the calling node run");
      assert.ok(e.data.dotted_order, "ordered within the trace");
      assert.ok(e.data.tags?.includes("backend-http"), "tagged for downstream queries");
    }

    // Metadata identifies the backend and the attempt (defaults outside retry).
    assert.equal(request.data.metadata?.backend_endpoint, "position/GetCardsByCustomer");
    assert.equal(request.data.metadata?.backend_base_url, "https://backend.example/api");
    assert.equal(request.data.metadata?.backend_envelope, "default");
    assert.equal(request.data.metadata?.backend_attempt, 1);
    assert.equal(request.data.metadata?.backend_max_attempts, 1);
    assert.equal(request.data.metadata?.backend_retryable, false);

    // The response event is self-sufficient — the logged view IS its outputs.
    const outputs = response.data.outputs as Record<string, unknown>;
    assert.equal(response.data.status, "success");
    assert.equal(outputs.status, 200);
    assert.equal(outputs.latency_ms, 12);
    assert.ok(outputs.response, "the masked body travels with the event");
  });

  test("only the logged view reaches the payload — the real result never does", async () => {
    await insideNode(() => cardsCall());

    const raw = producer.raw();
    assert.ok(raw.length > 0, "something was actually emitted");
    // Assert on the BYTES, not on a parsed field, so a leak under any key or
    // nesting is caught. The library redactor is credential-only; the
    // {result, logged} split is the only thing standing between this value
    // and the topic.
    assert.ok(!raw.includes("5310123456786083"), "real value absent from every payload");
    assert.doesNotMatch(raw, /\d{12,}/, "no long digit run survives");
    assert.ok(raw.includes('"number":"***"'), "the masked view is what was recorded");
    assert.ok(raw.includes("***7890"), "the pre-masked input is what was recorded");
  });

  test("a throw from fn propagates to the caller and is recorded as an error run", async () => {
    await insideNode(async () => {
      await assert.rejects(
        () =>
          traceBackendCall(
            {
              endpoint: "customer/SimpleSearch",
              baseUrl: "https://backend.example/api",
              envelope: "default",
              input: { payload: {} },
            },
            async () => {
              throw new Error("backend customer/SimpleSearch failed (500): ***");
            },
          ),
        /failed \(500\)/,
      );
    });

    const events = httpEvents("customer/SimpleSearch");
    assert.equal(events.length, 2, "the failed run still emits its pair");
    assert.equal(events[1].data.direction, "response");
    assert.equal(events[1].data.status, "error");
    assert.match(String(events[1].data.error), /failed \(500\)/);
  });

  test("a retried call is visible as one run per attempt, attempt 1 then attempt 2", async () => {
    await insideNode(async () => {
      for (let attempt = 1; attempt <= 2; attempt++) {
        await withAttemptContext({ attempt, attempts: 2 }, () => cardsCall());
      }
    });

    const requests = httpEvents("position/GetCardsByCustomer").filter(
      (e) => e.data.direction === "request",
    );
    assert.equal(requests.length, 2, "one run per attempt");
    assert.deepEqual(
      requests.map((e) => e.data.metadata?.backend_attempt),
      [1, 2],
    );
    assert.deepEqual(
      requests.map((e) => e.data.metadata?.backend_max_attempts),
      [2, 2],
    );
    assert.deepEqual(
      requests.map((e) => e.data.metadata?.backend_retryable),
      [true, true],
    );
  });

  test("currentAttempt is scoped: set inside withAttemptContext, undefined outside", async () => {
    assert.equal(currentAttempt(), undefined);
    await withAttemptContext({ attempt: 1, attempts: 3 }, async () => {
      assert.deepEqual(currentAttempt(), { attempt: 1, attempts: 3 });
    });
    assert.equal(currentAttempt(), undefined);
  });
});
