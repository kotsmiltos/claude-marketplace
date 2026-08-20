// FILE: src/observability/event-emitter.ts
//
// Converts a LangChain tracer Run into an observability event, then validates,
// redacts, applies the host's content mask (if any), serializes,
// truncates-if-oversized, and produces it. Depends only on the narrow
// EventProducer contract (DIP) — unit-testable with a fake producer, no Kafka
// client involved.

import { createHash, randomUUID } from "node:crypto";
import type { Run } from "@langchain/core/tracers/base";
import { redact } from "./redaction.js";
import { applyContentMask, type ContentMask } from "./content-mask.js";
import { ObservabilityEventSchema, RunEventDataSchema, type RunEventData } from "./schemas.js";
import type { EventProducer } from "./event-producer.js";

const MAX_PAYLOAD_BYTES = 512 * 1024; // 512 KB — replaced by a truncation marker beyond this

export type RunDirection = "request" | "response";

function toIso(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

/** JSON round-trip: BaseMessage & friends serialize via their own toJSON (the
 *  `lc` format LangSmith stores), functions/undefined drop out, and the result
 *  is a plain tree the redactor and zod can walk. A value that cannot be
 *  serialized (circular, BigInt, …) becomes an explicit marker instead of
 *  killing the event. */
function toPlain(value: unknown): Record<string, unknown> | undefined {
  if (value == null) return undefined;
  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  } catch (err) {
    return { __unserializable: String(err) };
  }
}

/** Intra-run events (new_token, …) minus each event's `chunk` kwarg — the raw
 *  generation-chunk object is heavy and fully redundant with the run's final
 *  outputs; token text and timestamps are kept. */
function sanitizeRunEvents(
  events: Run["events"],
): Array<Record<string, unknown>> | undefined {
  if (!events || events.length === 0) return undefined;
  return events.map((e) => {
    if (!e.kwargs) return { name: e.name, time: e.time };
    const { chunk: _chunk, ...kwargs } = e.kwargs;
    return { name: e.name, time: e.time, kwargs };
  });
}

/** Project a tracer Run onto the event `data` shape. `child_runs` is dropped
 *  deliberately — every child emits its own events; the tree is rebuilt
 *  downstream from trace_id/parent_run_id/dotted_order. */
export function runToEventData(run: Run, direction: RunDirection): RunEventData {
  const metadata = (run.extra as { metadata?: Record<string, unknown> } | undefined)?.metadata;
  const base = {
    type: "run" as const,
    direction,
    run_id: run.id,
    trace_id: run.trace_id,
    parent_run_id: run.parent_run_id,
    dotted_order: run.dotted_order,
    run_type: run.run_type,
    name: run.name,
    tags: run.tags,
    metadata: toPlain(metadata),
    inputs: toPlain(run.inputs),
    start_time: toIso(run.start_time),
  };
  if (direction === "request") {
    return { ...base, serialized: toPlain(run.serialized) };
  }
  return {
    ...base,
    outputs: toPlain(run.outputs),
    error: run.error,
    status: run.error ? ("error" as const) : ("success" as const),
    events: sanitizeRunEvents(run.events),
    end_time: typeof run.end_time === "number" ? toIso(run.end_time) : undefined,
    latency_ms: typeof run.end_time === "number" ? run.end_time - run.start_time : undefined,
  };
}

export class RunEventEmitter {
  /** `contentMask` is the HOST's domain-PII policy (see content-mask.ts).
   *  Defaulted to null so the public constructor stays backward compatible and
   *  an application that supplies nothing emits byte-identical payloads. */
  constructor(
    private readonly producer: EventProducer,
    private readonly applicationName: string,
    private readonly topic: string,
    private readonly contentMask: ContentMask | null = null,
  ) {}

  /** The one path every emit funnels through: project, validate, redact,
   *  mask content, serialize, truncate-if-oversized, produce. */
  emitRun(threadId: string, run: Run, direction: RunDirection): void {
    const parsedData = RunEventDataSchema.parse(runToEventData(run, direction));
    // Credential redaction FIRST, so the library's own contract stays primary
    // whatever the host policy does. Order-independent in practice —
    // ***REDACTED*** carries no digits for a digit policy to find.
    const redactedData = redact(parsedData);
    const data = this.contentMask
      ? applyContentMask(redactedData, this.contentMask)
      : redactedData;

    // Re-validating `data` here is also the guard on host masks: a policy that
    // returns the wrong shape for a content field throws, and the tracer's
    // fire-and-forget wrapper logs and drops the event rather than writing a
    // malformed document to the sink.
    const event = ObservabilityEventSchema.parse({
      id: randomUUID(),
      thread_id: threadId,
      application_name: this.applicationName,
      timestamp: new Date().toISOString(),
      data,
    });

    let payload: Buffer = Buffer.from(JSON.stringify(event), "utf-8");
    if (payload.length > MAX_PAYLOAD_BYTES) {
      payload = this.truncatedPayload(event, payload);
    }

    // Keyed by the event's own id, not thread_id: the shared QA/PROD
    // Elasticsearch sink upserts by Kafka message key, so a shared thread_id
    // key would collapse every event for a thread into a single overwritten
    // document (found live in QA).
    this.producer.produce(this.topic, event.id, payload);
  }

  private truncatedPayload(
    event: { id: string; thread_id: string; application_name: string; timestamp: string },
    original: Buffer,
  ): Buffer {
    const sha256 = createHash("sha256").update(original).digest("hex");
    const truncated = {
      id: event.id,
      thread_id: event.thread_id,
      application_name: event.application_name,
      timestamp: event.timestamp,
      data: { type: "truncated", original_bytes: original.length, sha256 },
    };
    return Buffer.from(JSON.stringify(truncated), "utf-8");
  }
}
