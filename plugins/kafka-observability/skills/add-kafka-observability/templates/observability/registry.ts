// FILE: src/observability/registry.ts
//
// Module-level singleton holding the shared RunEventEmitter. Needed because
// the global callback hook (registerConfigureHook in index.ts) constructs a
// fresh KafkaRunTracer per configured invocation — the tracer instances are
// cheap and stateless-ish, but the producer/emitter must be one per process.
// Kept in its own module so run-tracer.ts and index.ts can both import it
// without a circular dependency.

import type { RunEventEmitter } from "./event-emitter.js";

let emitter: RunEventEmitter | null = null;

export function setEmitter(value: RunEventEmitter | null): void {
  emitter = value;
}

export function getEmitter(): RunEventEmitter | null {
  return emitter;
}
