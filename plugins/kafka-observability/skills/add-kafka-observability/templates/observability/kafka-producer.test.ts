// Unit tests for KafkaEventProducer / buildConfig (src/observability/kafka-producer.ts).
// No live broker required: "localhost:19999" refuses the connection immediately
// (nothing listens there), which is exactly what exercises the bounded-queue /
// drop-on-full / closed-state edge cases without ever reaching "ready". The
// happy (delivered-to-a-real-broker) path is covered by the live verification
// in docs/design/design-027-kafka-observability.md, not here.
//
// Run after build: node --test dist/observability/kafka-producer.test.js

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildConfig, KafkaEventProducer } from "./kafka-producer.js";
import type { KafkaSettings } from "./settings.js";

const UNREACHABLE = "localhost:19999";

function settings(overrides: Partial<KafkaSettings> = {}): KafkaSettings {
  return {
    applicationName: "test",
    bootstrapServers: UNREACHABLE,
    topic: "observability-events",
    queueMaxSize: 1000,
    retries: 5,
    deliveryTimeoutMs: 30000,
    ...overrides,
  };
}

describe("buildConfig", () => {
  test("always sets acks=-1 (all), idempotence, and dr_cb regardless of input", () => {
    const config = buildConfig(settings());
    assert.equal(config["acks"], -1);
    assert.equal(config["enable.idempotence"], true);
    assert.equal(config["dr_cb"], true);
  });

  test("maps required fields", () => {
    const config = buildConfig(settings({ bootstrapServers: "kafka:29092", retries: 7, deliveryTimeoutMs: 5000 }));
    assert.equal(config["bootstrap.servers"], "kafka:29092");
    assert.equal(config["retries"], 7);
    assert.equal(config["delivery.timeout.ms"], 5000);
  });

  test("omits optional keys entirely when undefined (edge case — no null/undefined leaking into config)", () => {
    const config = buildConfig(settings());
    for (const key of ["client.id", "linger.ms", "batch.size", "security.protocol", "sasl.mechanism", "sasl.username", "sasl.password"]) {
      assert.equal(key in config, false, `expected "${key}" to be absent`);
    }
  });

  test("includes an optional key only when its setting is set", () => {
    const config = buildConfig(settings({ clientId: "ivr-router", saslUsername: "u" }));
    assert.equal(config["client.id"], "ivr-router");
    assert.equal(config["sasl.username"], "u");
    assert.equal("sasl.password" in config, false);
  });
});

describe("KafkaEventProducer — bounded queue against an unreachable broker", () => {
  test("produce() never throws even though the broker is unreachable", () => {
    const producer = new KafkaEventProducer(settings({ queueMaxSize: 10 }));
    assert.doesNotThrow(() => producer.produce("t", "k1", Buffer.from("{}")));
    return producer.shutdown(200);
  });

  test("a full queue drops new events and increments the dropped counter (edge case)", async () => {
    const producer = new KafkaEventProducer(settings({ queueMaxSize: 2 }));
    try {
      // Never becomes "ready" (nothing listens on UNREACHABLE), so the drain
      // loop never empties the queue — deterministic overflow.
      producer.produce("t", "k1", Buffer.from("1"));
      producer.produce("t", "k2", Buffer.from("2"));
      assert.equal(producer.dropped, 0, "queue not yet full");

      producer.produce("t", "k3", Buffer.from("3"));
      assert.equal(producer.dropped, 1, "3rd item over a maxSize of 2 must be dropped");

      producer.produce("t", "k4", Buffer.from("4"));
      assert.equal(producer.dropped, 2, "dropped count keeps growing per extra call");
    } finally {
      await producer.shutdown(200);
    }
  });

  test("shutdown() resolves within its own timeout even when the queue never drains (edge case)", async () => {
    const producer = new KafkaEventProducer(settings({ queueMaxSize: 10 }));
    producer.produce("t", "k1", Buffer.from("never delivered"));
    const start = Date.now();
    await producer.shutdown(150);
    assert.ok(Date.now() - start < 5000, "shutdown must not hang waiting for an unreachable broker");
  });

  test("produce() after shutdown() drops the event and increments dropped (edge case)", async () => {
    const producer = new KafkaEventProducer(settings({ queueMaxSize: 10 }));
    await producer.shutdown(150);
    const before = producer.dropped;
    producer.produce("t", "k1", Buffer.from("post-shutdown"));
    assert.equal(producer.dropped, before + 1);
  });

  test("shutdown() is idempotent — a second call does not throw or hang (edge case)", async () => {
    const producer = new KafkaEventProducer(settings({ queueMaxSize: 10 }));
    await producer.shutdown(150);
    await assert.doesNotReject(() => producer.shutdown(150));
  });
});
