// FILE: src/observability/event-producer.ts
//
// Narrow transport contract (DIP/ISP) — the only surface RunEventEmitter
// needs. KafkaEventProducer (kafka-producer.ts) satisfies this structurally; a
// test double or any other transport is a drop-in replacement with no
// dependency on the Kafka client at all.

export interface EventProducer {
  produce(topic: string, key: string, value: Buffer): void;
}
