// FILE: src/observability/index.ts
//
// Public API + composition root. startup() builds the singleton Kafka
// producer + emitter and registers the global callback hook that attaches a
// KafkaRunTracer to every LangChain/LangGraph invocation in the process —
// the same attachment mechanism LangSmith's own tracer uses, so no graph
// export, node function, or tool signature changes.
//
// Disabled by default (KAFKA_ENABLED !== "true"): startup() is a no-op, no
// Kafka env var is read or required, and the tracer is never attached. When
// enabled, all required settings are validated together and fail fast — no
// fallbacks, per the team's configuration rule.
//
// Wiring (done by /add-kafka-observability): the module that builds/exports
// the graph calls startup() once at module load:
//
//   import { startup as startupObservability } from "./observability/index.js";
//   startupObservability();

import { registerConfigureHook } from "@langchain/core/context";
import { isKafkaEnabled, readKafkaSettings } from "./settings.js";
import { KafkaEventProducer } from "./kafka-producer.js";
import { RunEventEmitter } from "./event-emitter.js";
import { KafkaRunTracer } from "./run-tracer.js";
import { setEmitter } from "./registry.js";

export { KafkaRunTracer } from "./run-tracer.js";
export type { KafkaRunTracerFields } from "./run-tracer.js";
export { RunEventEmitter, runToEventData } from "./event-emitter.js";
export type { ObservabilityEvent, RunEventData } from "./schemas.js";

let producer: KafkaEventProducer | null = null;
let started = false;

/** Call once at module load (the graph entry module). Idempotent. Validates
 *  all required Kafka settings fail-fast when KAFKA_ENABLED=true. */
export function startup(): void {
  if (started) return;
  started = true;
  if (!isKafkaEnabled()) {
    console.log('[observability] Kafka run tracing disabled (KAFKA_ENABLED !== "true") — skipping init');
    return;
  }
  const settings = readKafkaSettings();
  producer = new KafkaEventProducer(settings);
  setEmitter(new RunEventEmitter(producer, settings.applicationName, settings.topic));
  // Attach globally: every callback-manager configure() while
  // KAFKA_ENABLED === "true" gets a KafkaRunTracer (deduped by handler name
  // within a run tree; inheritable so child runs — nodes, LLM calls, tools —
  // report to the same instance).
  registerConfigureHook({ handlerClass: KafkaRunTracer, envVar: "KAFKA_ENABLED", inheritable: true });
  // "initialized", NOT "ready": the broker/SASL handshake is still in flight
  // here. The producer logs "Kafka producer connected" when it completes, and
  // warns if it never does — claiming readiness at this point sent a real QA
  // incident down the wrong path (events silently queued, log said "ready").
  console.log(
    `[observability] Kafka run tracing initialized (producer connecting in background): ` +
      `app=${settings.applicationName} topic=${settings.topic} ` +
      `brokers=${settings.bootstrapServers} retries=${settings.retries} ` +
      `delivery_timeout_ms=${settings.deliveryTimeoutMs}`,
  );
}

/** Drain the queue and flush the broker connection. Call at process shutdown
 *  where a hook exists (e.g. the CLI's quit path). Bounded — never hangs on an
 *  unreachable broker. No-op when disabled or never started. */
export async function shutdown(): Promise<void> {
  if (producer) await producer.shutdown();
}

/** TEST SEAM: resets module-level singleton state so tests can exercise
 *  startup()/shutdown() transitions independently. Callers MUST await
 *  shutdown() first if a real producer was constructed, or its drain loop
 *  leaks across tests. NOTE: an already-registered configure hook cannot be
 *  unregistered — tests relying on hook absence must run before any enabled
 *  startup(). */
export function __resetForTests(): void {
  producer = null;
  setEmitter(null);
  started = false;
}
