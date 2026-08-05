// Unit tests for the configure-slot attachment (src/observability/configure-slot.ts):
// documents the upstream hook failure the slot exists to survive, then proves the
// slot attaches under that failure, dedupes, installs idempotently, stays inert
// when disabled, and uninstalls cleanly.
//
// The failure is simulated with als.run(undefined, ...): entering the shared
// tracing AsyncLocalStorage (globalThis[Symbol.for("ls:tracing_async_local_storage")])
// with NO store is exactly what a run context that does not descend from
// startup() sees (INC-2026-0045 — e.g. requests on a server created before the
// graph module was imported). node --test runs each test file in its own
// process, so the un-unregisterable configure hooks other test files register
// never leak in here.
//
// Run after build: node --test dist/observability/configure-slot.test.js

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { CallbackManager } from "@langchain/core/callbacks/manager";
import { registerConfigureHook } from "@langchain/core/context";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import {
  installConfigureSlot,
  getAttachDiagnostics,
  __resetConfigureSlotForTests,
} from "./configure-slot.js";
import { KafkaRunTracer } from "./run-tracer.js";

// Importing "@langchain/core/context" above guarantees the global ALS instance
// exists (that module initializes it eagerly).
type StoreRunner = { run<T>(store: unknown, fn: () => T): T; getStore(): unknown };
const als = (globalThis as Record<symbol, unknown>)[
  Symbol.for("ls:tracing_async_local_storage")
] as StoreRunner;

function handlersNamed(mgr: unknown, name: string): number {
  const handlers = (mgr as { handlers?: Array<{ name: string }> } | undefined)?.handlers ?? [];
  return handlers.filter((h) => h.name === name).length;
}

afterEach(() => {
  __resetConfigureSlotForTests();
  delete process.env.KAFKA_ENABLED;
  delete process.env.TEST_PROBE_HOOK;
});

describe("the upstream failure the slot exists for", () => {
  class AlsBreakProbe extends BaseCallbackHandler {
    name = "als_break_probe";
  }

  test("a registered configure-hook fires in a descendant context but NOT under an ALS break", () => {
    process.env.TEST_PROBE_HOOK = "true";
    registerConfigureHook({ handlerClass: AlsBreakProbe, envVar: "TEST_PROBE_HOOK", inheritable: true });

    // Sanity: this test body descends from the registration — the hook fires.
    const healthy = CallbackManager.configure();
    assert.equal(handlersNamed(healthy, "als_break_probe"), 1);

    // Same registration, same process, no store: the hook is invisible. This
    // is upstream behavior, not ours — if it ever starts passing (hooks become
    // process-global), the slot can be retired.
    const broken = als.run(undefined, () => CallbackManager.configure());
    assert.equal(handlersNamed(broken, "als_break_probe"), 0);
  });
});

describe("installConfigureSlot()", () => {
  test("attaches KafkaRunTracer when the hook registry is invisible (ALS break)", () => {
    process.env.KAFKA_ENABLED = "true";
    installConfigureSlot({ hookAlsoRegistered: true });

    const mgr = als.run(undefined, () => CallbackManager.configure());

    assert.equal(handlersNamed(mgr, "kafka_run_tracer"), 1);
    assert.equal(getAttachDiagnostics().attachedBySlot, 1);
    assert.equal(getAttachDiagnostics().configureCalls, 1);
  });

  test("dedupes by handler name — a manager already carrying the tracer is untouched", () => {
    process.env.KAFKA_ENABLED = "true";
    installConfigureSlot({ hookAlsoRegistered: true });

    const inherited = new KafkaRunTracer();
    const mgr = als.run(undefined, () => CallbackManager.configure([inherited]));

    assert.equal(handlersNamed(mgr, "kafka_run_tracer"), 1);
    assert.equal(getAttachDiagnostics().alreadyAttached, 1);
    assert.equal(getAttachDiagnostics().attachedBySlot, 0);
  });

  test("double install wraps once (edge case — startup() retried after a config throw)", () => {
    process.env.KAFKA_ENABLED = "true";
    installConfigureSlot({ hookAlsoRegistered: false });
    installConfigureSlot({ hookAlsoRegistered: false });

    const mgr = als.run(undefined, () => CallbackManager.configure());

    assert.equal(handlersNamed(mgr, "kafka_run_tracer"), 1);
    assert.equal(getAttachDiagnostics().configureCalls, 1); // a double wrap would count 2
  });

  test('inert when KAFKA_ENABLED is not exactly "true" (strict gate, same as the hook)', () => {
    process.env.KAFKA_ENABLED = "TRUE";
    installConfigureSlot({ hookAlsoRegistered: false });

    const mgr = als.run(undefined, () => CallbackManager.configure());

    assert.equal(handlersNamed(mgr, "kafka_run_tracer"), 0);
    assert.equal(getAttachDiagnostics().configureCalls, 0);
  });

  test("__resetConfigureSlotForTests() restores the original configure slot", () => {
    process.env.KAFKA_ENABLED = "true";
    installConfigureSlot({ hookAlsoRegistered: false });
    __resetConfigureSlotForTests();

    const mgr = als.run(undefined, () => CallbackManager.configure());

    assert.equal(handlersNamed(mgr, "kafka_run_tracer"), 0);
  });
});
