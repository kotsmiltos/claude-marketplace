# observability library — CHANGELOG

The version here is the **vendored library** version (`templates/observability/VERSION`),
independent of the plugin version in `.claude-plugin/plugin.json`. Downstream projects
carry a copy of this library in `src/observability/`; `/add-kafka-observability` compares
their `src/observability/VERSION` against the shipped one and upgrades via the
version-keyed guides in `migrations/`.

## 1.1.0 (2026-08-04)

Connection-diagnostics release, motivated by a real QA incident: an agent's events never
reached the shared sink, and the logs made the failure undiagnosable — startup printed
"Kafka run tracing ready" **before** any broker/SASL handshake, and a producer that never
connects is otherwise silent (the drain loop no-ops until librdkafka's "ready" event,
`event.error` does not reliably fire against black-holed egress, and the queue-full
warning needs `KAFKA_QUEUE_MAXSIZE` events to trigger). "Connected" and "never connected"
were indistinguishable from application logs.

No behavior changes beyond logging: `produce()`, drain, shutdown semantics, config keys,
and the disabled-by-default contract are untouched. Pure file refresh for consumers —
re-run `/add-kafka-observability` (see `migrations/1.0.0-to-1.1.0.md`).

- **`kafka-producer.ts`** — logs `[observability] Kafka producer connected` when the
  broker handshake actually completes, and arms a one-shot, `unref()`'d connection
  watchdog (default 30 s — 10× the 3 s socket setup timeout, generous for SASL_SSL) that
  warns when the producer has still not connected, including the current in-memory queue
  fill (`queue N/max`). Cleared on "ready" and on `shutdown()`. The threshold is an
  injectable constructor parameter so tests don't wait 30 s.
- **`index.ts`** — the startup line no longer claims readiness:
  "Kafka run tracing ready: …" → "Kafka run tracing initialized (producer connecting in
  background): …" (same app/topic/brokers/retries fields).
- **`kafka-producer.test.ts`** — two new watchdog tests on the existing
  unreachable-broker harness: the not-connected warning fires with the queue fill, and
  `shutdown()` clears the watchdog (no stray warning after a deliberate close).

## 1.0.0 (2026-08-03)

Initial release.

- **`KafkaRunTracer`** (`run-tracer.ts`) — a `BaseTracer` subclass attached globally via
  `registerConfigureHook` (the same mechanism LangSmith's own tracer uses). Captures every
  traced run — graph invocation, each LangGraph node, each LLM call (full rendered
  messages, invocation params, outputs, token usage), each tool run — and emits **two
  events per run**: `direction: "request"` at run creation (inputs) and
  `direction: "response"` at run end (inputs + outputs/error, latency, status). Trace
  hierarchy travels in every event (`trace_id`, `parent_run_id`, `dotted_order`) so the
  full LangSmith-style run tree is reconstructable downstream. `thread_id` is resolved
  from run metadata (LangGraph injects `configurable.thread_id` there), with a
  per-trace fallback map for child runs that carry no metadata.
- **Event envelope** (`schemas.ts`, zod-validated) — the bank-standard
  `{ id, thread_id, application_name, timestamp, data }` shape already consumed by the
  shared Elasticsearch sink. Kafka message key is the event's own `id` (per the
  ivr-router design-027 rev.2 finding: the sink upserts by key, so keying by thread
  collapses a thread's events into one document).
- **Transport** (`kafka-producer.ts`, `bounded-queue.ts`) — `@confluentinc/kafka-javascript`
  (librdkafka) behind a bounded in-memory queue (default 1000) with a 10 ms background
  drain loop. `produce()` never blocks; a full queue drops the event and logs a running
  count. `acks=all`, idempotent producer, bounded `shutdown()` (drain → flush → disconnect,
  every phase raced against a timer — librdkafka's own timeouts do not reliably bound a
  never-connected broker). Ported verbatim from ivr-router-ts design-027 (live-verified).
- **Redaction** (`redaction.ts`) — recursive masking of `authorization` / `api_key` /
  `password` / `token` / `secret` / `credential` / `connection_string` keys and
  `password=` fragments in string values, applied to every payload before serialization.
- **Size cap** — events over 512 KB are replaced by a truncation marker
  (`{ type: "truncated", original_bytes, sha256 }`).
- **Config** (`settings.ts`, `env.ts`) — `KAFKA_ENABLED` gate (must be exactly `"true"` —
  the global callback hook compares strictly); when enabled, `APPLICATION_NAME`,
  `KAFKA_BOOTSTRAP_SERVERS`, `KAFKA_OBSERVABILITY_TOPIC` are required and fail fast
  (no-config-fallback rule). Optional: `KAFKA_SECURITY_PROTOCOL`, `KAFKA_SASL_MECHANISM`,
  `KAFKA_SASL_USERNAME`, `KAFKA_SASL_PASSWORD`, `KAFKA_CLIENT_ID`,
  `KAFKA_PRODUCER_LINGER_MS`, `KAFKA_PRODUCER_BATCH_SIZE`, `KAFKA_QUEUE_MAXSIZE`,
  `KAFKA_PRODUCER_RETRIES`, `KAFKA_DELIVERY_TIMEOUT_MS`.
- Disabled by default: `startup()` is a no-op without `KAFKA_ENABLED=true`; no Kafka env
  var is read or required, and the tracer is never attached.
