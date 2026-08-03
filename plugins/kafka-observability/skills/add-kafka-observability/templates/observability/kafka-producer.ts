// FILE: src/observability/kafka-producer.ts
//
// Kafka producer backed by a bounded in-memory queue and a background drain
// loop (setInterval — Node is single-threaded, so this is the event-loop
// equivalent of a dedicated worker thread). produce() never blocks the
// caller: enqueue-or-drop, always synchronous, always immediate return.
//
// Shutdown sequence (via shutdown()):
//   1. _closed = true      — stops accepting new items immediately
//   2. drain loop stopped  — after flushing whatever is left in the queue
//   3. producer.flush()    — drains librdkafka's internal network buffer
//   4. producer.disconnect()

// @confluentinc/kafka-javascript's CJS entry re-exports via `{ ...RdKafka }` (a
// spread), which Node's static CJS/ESM interop analysis can't see through for
// named imports (fails at runtime: "Named export 'Producer' not found"). The
// default-import + destructure form below is the workaround Node's own error
// message recommends; the type import is unaffected (TS resolves types
// straight from the .d.ts, not the runtime interop analysis).
import type { Producer } from "@confluentinc/kafka-javascript";
import kafkaJs from "@confluentinc/kafka-javascript";
const { Producer: ProducerCtor } = kafkaJs;
import type { KafkaSettings } from "./settings.js";
import { BoundedQueue } from "./bounded-queue.js";
import type { EventProducer } from "./event-producer.js";

type QueueItem = { topic: string; key: string; value: Buffer };

const DRAIN_INTERVAL_MS = 10;

// Maps KafkaSettings fields to librdkafka config keys for optional values.
// Add new optional settings here — no changes to buildConfig() required (OCP).
const OPTIONAL_CONFIG_KEYS: Array<[keyof KafkaSettings, string]> = [
  ["clientId", "client.id"],
  ["lingerMs", "linger.ms"],
  ["batchSize", "batch.size"],
  ["securityProtocol", "security.protocol"],
  ["saslMechanism", "sasl.mechanism"],
  ["saslUsername", "sasl.username"],
  ["saslPassword", "sasl.password"],
];

// librdkafka's default (30s) means flush()/disconnect() effectively stall for
// up to 30s against a genuinely unreachable broker — REGARDLESS of the timeout
// argument passed to flush()/disconnect() themselves, since neither can return
// authoritatively until the connection attempt is itself declared dead. 3s is
// generous for a real broker (TCP handshake, even under load) while keeping a
// down broker from blocking shutdown() for anywhere near as long.
const SOCKET_CONNECTION_SETUP_TIMEOUT_MS = 3000;

export function buildConfig(settings: KafkaSettings): Record<string, unknown> {
  const config: Record<string, unknown> = {
    "bootstrap.servers": settings.bootstrapServers,
    "acks": -1, // -1 == "all" (librdkafka accepts either; -1 keeps the TS `number` type happy)
    "enable.idempotence": true,
    "retries": settings.retries,
    "delivery.timeout.ms": settings.deliveryTimeoutMs,
    "socket.connection.setup.timeout.ms": SOCKET_CONNECTION_SETUP_TIMEOUT_MS,
    "dr_cb": true, // required to receive 'delivery-report' events
  };
  for (const [attr, kafkaKey] of OPTIONAL_CONFIG_KEYS) {
    const value = settings[attr];
    if (value !== undefined) config[kafkaKey] = value;
  }
  return config;
}

export class KafkaEventProducer implements EventProducer {
  private readonly producer: Producer;
  private readonly queue: BoundedQueue<QueueItem>;
  private ready = false;
  private closed = false;
  private droppedEvents = 0;
  private drainTimer: NodeJS.Timeout | null = null;

  constructor(settings: KafkaSettings) {
    this.queue = new BoundedQueue(settings.queueMaxSize);
    this.producer = new ProducerCtor(buildConfig(settings));
    this.producer.on("ready", () => {
      this.ready = true;
    });
    this.producer.on("event.error", (err) => {
      console.error("[observability] Kafka producer error:", err);
    });
    this.producer.on("delivery-report", (err) => {
      if (err) console.error("[observability] Kafka delivery failed:", err);
    });
    this.producer.connect();
    this.drainTimer = setInterval(() => this.drainOnce(), DRAIN_INTERVAL_MS);
    this.drainTimer.unref?.(); // never keeps the process alive on its own
  }

  get dropped(): number {
    return this.droppedEvents;
  }

  /** Enqueue for async delivery by the background drain loop. Never blocks —
   *  a full queue drops the event immediately and logs a running total. */
  produce(topic: string, key: string, value: Buffer): void {
    if (this.closed) {
      this.droppedEvents++;
      console.warn(
        `[observability] producer is closed, dropping event (topic=${topic}, total dropped=${this.droppedEvents})`,
      );
      return;
    }
    if (this.queue.enqueue({ topic, key, value })) return;
    this.droppedEvents++;
    console.warn(
      `[observability] Kafka queue full, dropping event (topic=${topic}, total dropped=${this.droppedEvents})`,
    );
  }

  private drainOnce(): void {
    if (!this.ready) return;
    let item: QueueItem | undefined;
    while ((item = this.queue.dequeue())) {
      try {
        this.producer.produce(item.topic, null, item.value, item.key);
      } catch (err) {
        console.error(`[observability] failed to produce to topic=${item.topic}:`, err);
      }
    }
    this.producer.poll();
  }

  /** Races `promise` against a `ms`-timer and returns whichever settles
   *  first. Verified empirically (not documented behavior) that
   *  flush()/disconnect()'s own timeout argument does NOT reliably bound
   *  their callback against a broker that never finishes connecting — the
   *  callback can simply never fire. This is the only bound that actually
   *  holds: it does not cancel the underlying call (there is no cancel API),
   *  it just stops OUR wait on it — a shutdown path must never hang the
   *  caller regardless of what the native binding does in the background. */
  private static raceTimeout(promise: Promise<void>, ms: number): Promise<void> {
    return Promise.race([
      promise,
      new Promise<void>((resolve) => setTimeout(resolve, ms)),
    ]);
  }

  /** Blocks (async) until the queue is drained, librdkafka's own buffer is
   *  flushed, and the client disconnects — each phase bounded by its share of
   *  `timeoutMs` (see raceTimeout()). Idempotent — safe to call once at
   *  shutdown. */
  async shutdown(timeoutMs = 30_000): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.drainTimer) clearInterval(this.drainTimer);

    const deadline = Date.now() + timeoutMs;
    while (this.queue.size > 0 && Date.now() < deadline) {
      this.drainOnce();
      await new Promise((resolve) => setTimeout(resolve, DRAIN_INTERVAL_MS));
    }

    // Nothing was ever produced/buffered on a client that never connected —
    // flush() is meaningless there, and (per the above) actively dangerous:
    // it throws synchronously ("Producer not connected") on some call paths.
    if (this.ready) {
      try {
        await KafkaEventProducer.raceTimeout(
          new Promise<void>((resolve) => {
            this.producer.flush(Math.max(deadline - Date.now(), 0), (err) => {
              if (err) console.error("[observability] producer flush error:", err);
              resolve();
            });
          }),
          Math.max(deadline - Date.now(), 0),
        );
      } catch (err) {
        console.error("[observability] producer flush threw:", err);
      }
    }

    try {
      await KafkaEventProducer.raceTimeout(
        new Promise<void>((resolve) => {
          this.producer.disconnect(Math.max(deadline - Date.now(), 0), (err) => {
            if (err) console.error("[observability] producer disconnect error:", err);
            resolve();
          });
        }),
        Math.max(deadline - Date.now(), 0),
      );
    } catch (err) {
      console.error("[observability] producer disconnect threw:", err);
    }
  }
}
