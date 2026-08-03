// FILE: src/observability/settings.ts
//
// Kafka observability config. `isKafkaEnabled()` is the cheap, never-throwing
// gate (checked first, always). `readKafkaSettings()` is only ever called once
// the gate is true, and validates every required var together — no fallbacks.

import { boolEnv, intEnv, optionalEnv, requiredEnv } from "./env.js";

export interface KafkaSettings {
  applicationName: string;
  bootstrapServers: string;
  topic: string;

  securityProtocol?: string;
  saslMechanism?: string;
  saslUsername?: string;
  saslPassword?: string;
  clientId?: string;
  lingerMs?: number;
  batchSize?: number;

  // Bounded in-memory queue. produce() is always non-blocking (Node's single
  // event loop can't afford a synchronous wait-and-drop without freezing every
  // other concurrent request this server handles) — a full queue drops the new
  // event immediately and logs a running count.
  queueMaxSize: number;

  // Durability
  retries: number;
  deliveryTimeoutMs: number;
}

export function isKafkaEnabled(): boolean {
  return boolEnv("KAFKA_ENABLED");
}

export function readKafkaSettings(): KafkaSettings {
  return {
    applicationName: requiredEnv("APPLICATION_NAME"),
    bootstrapServers: requiredEnv("KAFKA_BOOTSTRAP_SERVERS"),
    topic: requiredEnv("KAFKA_OBSERVABILITY_TOPIC"),

    securityProtocol: optionalEnv("KAFKA_SECURITY_PROTOCOL"),
    saslMechanism: optionalEnv("KAFKA_SASL_MECHANISM"),
    saslUsername: optionalEnv("KAFKA_SASL_USERNAME"),
    saslPassword: optionalEnv("KAFKA_SASL_PASSWORD"),
    clientId: optionalEnv("KAFKA_CLIENT_ID"),
    lingerMs: optionalEnv("KAFKA_PRODUCER_LINGER_MS") ? intEnv("KAFKA_PRODUCER_LINGER_MS", 0) : undefined,
    batchSize: optionalEnv("KAFKA_PRODUCER_BATCH_SIZE") ? intEnv("KAFKA_PRODUCER_BATCH_SIZE", 0) : undefined,

    queueMaxSize: intEnv("KAFKA_QUEUE_MAXSIZE", 1000),

    retries: intEnv("KAFKA_PRODUCER_RETRIES", 5),
    deliveryTimeoutMs: intEnv("KAFKA_DELIVERY_TIMEOUT_MS", 30000),
  };
}
