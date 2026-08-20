// FILE: src/agent-step/dictation.test.ts
//
// The `dictation` awaiting-input kind: the standing-ask lifecycle driven by
// `ActionDef.asks` (finalize phase — the batch's FINAL entry decides) and the
// non-locking admission semantics. (The caller-turn interception once tested
// here was removed — owner decision 2026-08-14: the engine never fabricates
// assistant turns.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { Annotation } from "@langchain/langgraph";
import { z } from "zod";

import { defineConfig } from "./define-config.js";
import { runSteps, buildAgentStepTool, type BuildAgentStepToolOptions } from "./runner.js";
import { agentStepStateSpec, type AwaitingInput, type LibraryManagedSlots } from "./state.js";
import { callerDigits } from "./capture.js";

interface S extends LibraryManagedSlots {
  messages?: unknown[];
}

const stateSchema = Annotation.Root({
  messages: Annotation<unknown[]>({
    reducer: (_old, next) => next,
    default: () => [],
  }),
  ...agentStepStateSpec,
});

type ActionName = "ask_source" | "capture_value" | "other_read" | "gated_change" | "terminal_action";

const selectors = {
  ask_source: (state: S) => state,
  capture_value: (state: S) => state,
  other_read: (state: S) => state,
  gated_change: (state: S) => state,
  terminal_action: (state: S) => state,
};

const CAPTURE_ASK = {
  action: "capture_value",
  param: "spokenDigits",
  expects: "digits",
} as const;

function makeOpts(): BuildAgentStepToolOptions<S, ActionName, never, typeof selectors> {
  const config = defineConfig<ActionName, never>({
    tool: { name: "dictation_test_tool", description: "dictation test tool" },
    actions: {
      ask_source: {
        description: "a step whose verdict asks the caller for a value",
        paramsSchema: z.object({}),
        prereqs: [],
        asks: { need_value: CAPTURE_ASK },
        verdicts: {
          need_value: { ok: false, summary: "need the value", body: { verdict: "need_value" } },
        },
      },
      capture_value: {
        description: "receives the asked-for digits",
        paramsSchema: z.object({
          spokenDigits: callerDigits(/^\d{4}$/u, "not a usable capture"),
        }),
        prereqs: [],
        asks: { invalid_params: CAPTURE_ASK },
        verdicts: {
          ok: { ok: true, summary: "captured", body: { verdict: "ok" } },
        },
      },
      other_read: {
        description: "an unrelated read",
        paramsSchema: z.object({}),
        prereqs: [],
        verdicts: {
          ok: { ok: true, summary: "read done", body: { verdict: "ok" } },
        },
      },
      gated_change: {
        description: "a confirm-gated mutation that also declares asks",
        paramsSchema: z.object({ value: z.string() }),
        prereqs: [],
        controller: { requiresConfirmation: true },
        asks: { some_verdict: CAPTURE_ASK },
        verdicts: {
          ok: { ok: true, summary: "changed", body: { verdict: "ok" } },
        },
      },
      terminal_action: {
        description: "a terminal step whose verdict ALSO declares an ask",
        paramsSchema: z.object({}),
        prereqs: [],
        asks: { closed: CAPTURE_ASK },
        verdicts: {
          closed: {
            ok: false,
            summary: "closed",
            body: { verdict: "closed" },
            effects: [
              {
                type: "request_handoff" as const,
                request: { reason: "completed" as const, context: "done" },
              },
            ],
          },
        },
      },
    },
  });

  const executors = {
    ask_source: async () => ({ verdict: "need_value" }),
    capture_value: async () => ({ verdict: "ok" }),
    other_read: async () => ({ verdict: "ok" }),
    gated_change: async () => ({ verdict: "ok" }),
    terminal_action: async () => ({ verdict: "closed" }),
  };

  return {
    config,
    stateSchema,
    selectors,
    executors,
    verifiers: {},
    handoff: { offTopic: { mode: "terminate" } } as never,
  };
}

const baseState = (awaitingInput: AwaitingInput | null = null): S => ({
  messages: [],
  awaitingInput,
});

const STANDING: AwaitingInput = {
  kind: "dictation",
  for_action: "capture_value",
  param: "spokenDigits",
  expects: "digits",
};

test("a final entry whose verdict is listed in asks records the dictation", async () => {
  const { body, committed } = await runSteps(makeOpts(), [{ action: "ask_source", params: {} }], baseState());
  assert.equal(body.results[0].verdict, "need_value");
  assert.deepEqual(committed.awaitingInput, STANDING);
  // The record is VISIBLE on the final entry — the transcript is the model's
  // only authority for engine state.
  assert.deepEqual(body.results[0].standing_ask, {
    action: "capture_value",
    param: "spokenDigits",
  });
  assert.match(String(body.results[0].ask_contract), /call "capture_value" with it in "spokenDigits"/);
  // No render declared → no ask_text field.
  assert.ok(!("ask_text" in body.results[0]), "ask_text only when the ask renders");
});

test("an ask with render stamps the host-rendered ask_text beside standing_ask", async () => {
  const base = makeOpts();
  const cfg = base.config as unknown as {
    actions: Record<string, { asks?: Record<string, Record<string, unknown>> }>;
  };
  cfg.actions.ask_source.asks!.need_value = {
    ...CAPTURE_ASK,
    render: () => "Exact host-rendered ask bytes?",
  };
  const { body } = await runSteps(base, [{ action: "ask_source", params: {} }], baseState());
  assert.equal(body.results[0].ask_text, "Exact host-rendered ask bytes?");
  assert.deepEqual(body.results[0].standing_ask, {
    action: "capture_value",
    param: "spokenDigits",
  });
});

test("servicing the standing ask clears it (unlisted verdict on the asked action)", async () => {
  const { body, committed } = await runSteps(
    makeOpts(),
    [{ action: "capture_value", params: { spokenDigits: "1234" } }],
    baseState(STANDING),
  );
  assert.equal(body.results[0].ok, true);
  assert.equal(committed.awaitingInput, null);
});

test("invalid_params on the asked action re-records the ask (runner-raised code is a legal key)", async () => {
  const { body, committed } = await runSteps(
    makeOpts(),
    [{ action: "capture_value", params: { spokenDigits: "12" } }],
    baseState(STANDING),
  );
  assert.equal(body.results[0].error, "invalid_params");
  assert.deepEqual(committed.awaitingInput, STANDING);
});

test("an unrelated action leaves the standing ask untouched — and is NOT locked out by it", async () => {
  const { body, committed } = await runSteps(
    makeOpts(),
    [{ action: "other_read", params: {} }],
    baseState(STANDING),
  );
  assert.equal(body.results[0].ok, true, "dictation must not lock the surface");
  assert.equal(
    "awaitingInput" in committed,
    false,
    "no transition — the caller still owes the value",
  );
});

test("a live confirmation gate wins over asks (a proposal's ask never stomps the gate)", async () => {
  const { body, committed } = await runSteps(
    makeOpts(),
    [{ action: "gated_change", params: { value: "x" } }],
    baseState(STANDING),
  );
  assert.equal(body.results[0].needs_confirmation, true);
  const awaiting = committed.awaitingInput as AwaitingInput;
  assert.equal(awaiting?.kind, "confirmation");
  // Every proposal carries its reply contract — the gate turn reacts to the
  // result, not to prompt memory (journey-engine G2).
  assert.match(
    String(body.results[0].reply_contract),
    /A clear yes → re-call "gated_change" with exactly the proposed params/,
  );
});

test("a terminal handoff skips the ask its own verdict declares", async () => {
  const { committed } = await runSteps(
    makeOpts(),
    [{ action: "terminal_action", params: {} }],
    baseState(),
  );
  assert.equal(committed.awaitingInput, null, "handoff cleanup stands; no dictation re-set");
  assert.ok(committed.handoff);
});

test("construction-time validation rejects an ask targeting an unknown action or param", () => {
  const opts = makeOpts();
  const bad = structuredClone as unknown; // structuredClone can't copy zod schemas
  void bad;
  const withUnknownTarget = {
    ...opts,
    config: {
      ...opts.config,
      actions: {
        ...opts.config.actions,
        ask_source: {
          ...opts.config.actions.ask_source,
          asks: { need_value: { action: "nope", param: "spokenDigits", expects: "digits" as const } },
        },
      },
    },
  };
  assert.throws(() => buildAgentStepTool(withUnknownTarget as never), /unknown action "nope"/);
  const withUnknownParam = {
    ...opts,
    config: {
      ...opts.config,
      actions: {
        ...opts.config.actions,
        ask_source: {
          ...opts.config.actions.ask_source,
          asks: { need_value: { action: "capture_value", param: "nope", expects: "digits" as const } },
        },
      },
    },
  };
  assert.throws(() => buildAgentStepTool(withUnknownParam as never), /not declared on "capture_value"/);
});
