# Kafka Run Observability (LangSmith parity)

Fire-and-forget Kafka observability for every traced LangChain/LangGraph run in this
process. Disabled by default. Vendored from the `kafka-observability` plugin
(`claude-marketplace`) — version in `VERSION`; upgrade with `/add-kafka-observability`.
Do not hand-edit library files; project-specific behavior belongs at the project level.

## What it captures

Everything the application would send to LangSmith. `KafkaRunTracer` extends the same
`BaseTracer` base class as LangSmith's own tracer and is attached globally via
`registerConfigureHook` — every run (graph invocation, LangGraph node, LLM call with
full rendered messages + outputs + token usage, tool run) produces:

- one `direction: "request"` event at run start (inputs, serialized constructor info),
- one `direction: "response"` event at run end (inputs + outputs/error, status, latency,
  streaming-token event timestamps).

Trace hierarchy (`trace_id`, `parent_run_id`, `dotted_order`) travels in every event, so
the LangSmith-style run tree is reconstructable downstream. `thread_id` comes from run
metadata (LangGraph injects `configurable.thread_id`); events outside a thread use
`"no-thread"`.

```
graph/node/LLM/tool run (via BaseTracer hooks)
       │ onRunCreate ──► request event      │ onRunUpdate ──► response event
       ▼
RunEventEmitter (event-emitter.ts)
       ├── project Run → event data (child_runs dropped; each run emits its own)
       ├── validate (zod), redact sensitive fields
       ├── serialize, truncate if >512 KB ({original_bytes, sha256} marker)
       └── produce (key = event.id — the ES sink upserts by key; design-027 rev.2)
       ▼
KafkaEventProducer (kafka-producer.ts)
       └── bounded queue → 10ms background drain loop → librdkafka
```

## Environment variables

### Required to enable

| Variable | Description |
|----------|-------------|
| `KAFKA_ENABLED` | Exactly `true` to activate (strict — the global hook compares `=== "true"`). Defaults off; every other var below is ignored when disabled. |
| `APPLICATION_NAME` | Service identifier (e.g. `ib_password_reset_agent`). |
| `KAFKA_BOOTSTRAP_SERVERS` | Broker address(es) (e.g. `kafka:29092`). |
| `KAFKA_OBSERVABILITY_TOPIC` | Topic name (e.g. `observability-events`). |

### Optional

| Variable | Description |
|----------|-------------|
| `KAFKA_SECURITY_PROTOCOL` | e.g. `SASL_SSL`, `PLAINTEXT` |
| `KAFKA_SASL_MECHANISM` | e.g. `PLAIN`, `SCRAM-SHA-256` |
| `KAFKA_SASL_USERNAME` / `KAFKA_SASL_PASSWORD` | SASL credentials (Key Vault in deployment settings) |
| `KAFKA_CLIENT_ID` | Producer client ID |
| `KAFKA_PRODUCER_LINGER_MS` / `KAFKA_PRODUCER_BATCH_SIZE` | Batching |
| `KAFKA_QUEUE_MAXSIZE` | In-memory queue capacity (default: 1000) |
| `KAFKA_PRODUCER_RETRIES` | Producer retry count (default: 5) |
| `KAFKA_DELIVERY_TIMEOUT_MS` | Per-message delivery timeout in ms (default: 30000) |

## Event schema

```json
{
  "id": "uuid-v4 (Kafka message key)",
  "thread_id": "conversation-correlation-id",
  "application_name": "ib_password_reset_agent",
  "timestamp": "2026-01-01T00:00:00.000Z",
  "data": {
    "type": "run",
    "direction": "request | response",
    "run_id": "...", "trace_id": "...", "parent_run_id": "...", "dotted_order": "...",
    "run_type": "chain | llm | tool | ...",
    "name": "agent | AzureChatOpenAI | password_reset_agent_step | ...",
    "inputs": { "...": "always present" },
    "outputs": { "...": "response only" },
    "error": "response only, when failed",
    "status": "success | error (response only)",
    "events": [{ "name": "new_token", "time": "...", "kwargs": { "token": "..." } }],
    "metadata": { "thread_id": "...", "langgraph_node": "...", "...": "..." },
    "start_time": "...", "end_time": "...", "latency_ms": 123.4
  }
}
```

## Reliability

- **Bounded queue** (default 1000, `KAFKA_QUEUE_MAXSIZE`) drained by a single background
  loop; `produce()` is always synchronous and non-blocking — a run is never slowed down.
- **Drop policy**: a full queue drops the new event immediately and logs a running
  dropped-event count. Never backpressures the caller.
- **Delivery**: `acks=all`, idempotent producer, explicit retries (default 5) and
  `delivery.timeout.ms` (default 30000).
- **Graceful shutdown**: `await shutdown()` drains the queue, flushes librdkafka's
  buffer, then disconnects — each phase bounded by a timeout race (librdkafka's own
  flush/disconnect timeouts do NOT reliably bound a never-connected broker).
- **Fire-and-forget**: validation/redaction/transport errors are logged, never thrown
  into the run. **Known gap**: no replay — sustained broker unavailability or queue
  saturation loses events (accepted tradeoff for never blocking the caller).
- **Redaction**: `authorization`/`api_key`/`password`/`token`/`secret`/`credential`/
  `connection_string` keys and `password=` fragments are masked in every payload. NOTE:
  redaction masks secrets, not PII — full prompts/transcripts (incl. `telephone_number`)
  flow to the topic by design, same data-boundary decision as self-hosted LangSmith.

## LangSmith migration

The tracer runs ALONGSIDE LangSmith — both are callback handlers. Validation sequence:
enable `KAFKA_ENABLED=true` with `LANGSMITH_TRACING=true`, compare sinks, then unset the
`LANGSMITH_*` vars. Not replicated from LangSmith: artifacts created inside LangSmith
itself (feedback, annotations, datasets/experiments) and the UI — the downstream
consumer (e.g. Elasticsearch/Kibana over the topic) owns viewing.
