// FILE: src/agent-step/capture-bounce.test.ts
//
// The capture-bounce bound (`ActionDef.captureBounces`). The `invalid_params`
// bounce is deliberately free — no gate stored, no confirmation attempt spent,
// no executor invoked — which is precisely why no OTHER counter in the pipeline
// can see it: the gate's `attemptsLeft` needs a stored gate, `errorCount` needs
// a verdict, a host tracker needs the executor. Unbounded, that re-asks a
// mis-supplying caller forever (live incident 2026-08-19: seven identical
// short-AFM bounces in 105 seconds, no exit). These pins hold the bound and the
// two properties that must survive it: the count is model-INVISIBLE, and the
// escalation is the EXISTING ladder rather than a second mechanism.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Annotation } from "@langchain/langgraph";
import { z } from "zod";

import { defineConfig } from "./define-config.js";
import { runSteps, buildAgentStepTool, type BuildAgentStepToolOptions } from "./runner.js";
import { agentStepStateSpec, type LibraryManagedSlots } from "./state.js";

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

type ActionName = "capture_value" | "gated_capture" | "unbounded_capture";

const selectors = {
  capture_value: (state: S) => state,
  gated_capture: (state: S) => state,
  unbounded_capture: (state: S) => state,
};

const LADDERS = {
  required_detail: {
    description: "The caller declines or cannot supply the required detail.",
    instruction:
      "Explain in ONE short sentence why the detail is needed, then re-ask in the SAME turn.",
    onExhaust: { reason: "abandon" as const, context: "test:details_not_provided" },
  },
};

/** A caller capture whose shape rule is a REFINEMENT — invisible to the JSON
 *  Schema, so the model sees a plain string and a bad capture reaches the
 *  runner as `invalid_params` (the project's caller-capture hard rule). The
 *  message is count-free on purpose: a count here measurably makes the model
 *  pad digits to satisfy it. */
const digits = z
  .object({
    value: z.string().refine((v) => /^\d{9}$/u.test(v), "not a usable capture"),
  })
  .strict();

const MAX = 3;
const KEY = "capture:capture_value";
const BAD = { action: "capture_value", params: { value: "0354081" } };
const GOOD = { action: "capture_value", params: { value: "354081234" } };

function makeOpts(): BuildAgentStepToolOptions<S, ActionName, never, typeof selectors> {
  const config = defineConfig<ActionName, never>({
    tool: { name: "capture_bounce_tool", description: "capture bounce tool" },
    actions: {
      capture_value: {
        description: "receives a dictated value",
        paramsSchema: digits,
        prereqs: [],
        captureBounces: { max: MAX, ladder: "required_detail" },
        verdicts: { ok: { ok: true, summary: "captured" } },
      },
      gated_capture: {
        description: "a confirm-gated capture",
        paramsSchema: digits,
        prereqs: [],
        controller: { requiresConfirmation: { maxAttempts: 3 } },
        captureBounces: { max: MAX, ladder: "required_detail" },
        verdicts: { ok: { ok: true, summary: "captured" } },
      },
      unbounded_capture: {
        description: "the same capture with NO bound declared",
        paramsSchema: digits,
        prereqs: [],
        verdicts: { ok: { ok: true, summary: "captured" } },
      },
    },
  });
  return {
    config,
    stateSchema,
    selectors,
    executors: {
      capture_value: async () => ({ verdict: "ok" }),
      gated_capture: async () => ({ verdict: "ok" }),
      unbounded_capture: async () => ({ verdict: "ok" }),
    },
    verifiers: {},
    handoff: { offTopic: { mode: "terminate" }, terminateMessage: "bye" },
    ladders: LADDERS as never,
  };
}

const BASE: S = { messages: [{ role: "user", id: "t1", content: "…" }] };

test("under the bound: the bounce is unchanged, and only the capture run is latched", async () => {
  const { body, committed } = await runSteps(makeOpts(), [BAD], BASE);
  const r = body.results[0];
  assert.equal(r.ok, false);
  assert.equal(r.error, "invalid_params");
  assert.ok(!("ladder" in r), "no ladder involvement below the bound");
  assert.deepEqual(committed.spentLadders, { [KEY]: 1 });
  assert.equal(committed.handoff, undefined);
  assert.equal(committed.awaitingInput, undefined, "no gate stored by a bounce");
});

test("the whole run under the bound stays a plain bounce", async () => {
  const third = await runSteps(makeOpts(), [BAD], { ...BASE, spentLadders: { [KEY]: MAX - 1 } });
  assert.equal(third.body.results[0].error, "invalid_params");
  assert.ok(!("ladder" in third.body.results[0]));
  assert.deepEqual(third.committed.spentLadders, { [KEY]: MAX });
});

test("past the bound: the engine climbs the ladder — its instruction, no handoff yet", async () => {
  const { body, committed } = await runSteps(makeOpts(), [BAD], {
    ...BASE,
    spentLadders: { [KEY]: MAX },
  });
  const r = body.results[0];
  assert.equal(r.ok, false, "the step still failed — the capture never parsed");
  assert.equal(r.error, "invalid_params", "the standing ask stays owed");
  assert.equal(r.summary, LADDERS.required_detail.instruction);
  assert.equal(r.ladder, "required_detail");
  assert.ok(!("handoff_requested" in r));
  assert.deepEqual(committed.spentLadders, { [KEY]: MAX + 1, required_detail: 1 });
  assert.equal(committed.handoff, undefined);
});

test("the next bounce exhausts the ladder and escalates ATOMICALLY", async () => {
  const { body, committed } = await runSteps(makeOpts(), [BAD], {
    ...BASE,
    spentLadders: { [KEY]: MAX + 1, required_detail: 1 },
  });
  const r = body.results[0];
  assert.equal(r.ladder_exhausted, true);
  assert.equal(r.handoff_requested, true);
  assert.equal(r.reason, "abandon");
  assert.deepEqual(committed.handoff, {
    reason: "abandon",
    context: "test:details_not_provided",
  });
});

test("a capture that PARSES clears the run — only consecutive failures escalate", async () => {
  const { body, committed } = await runSteps(makeOpts(), [GOOD], {
    ...BASE,
    spentLadders: { [KEY]: MAX },
  });
  assert.equal(body.results[0].ok, true);
  assert.deepEqual(committed.spentLadders, {}, "the bounce run is gone");
});

test("an unrelated ladder count is never disturbed by a capture run", async () => {
  const { committed } = await runSteps(makeOpts(), [BAD], {
    ...BASE,
    spentLadders: { required_detail: 1 },
  });
  assert.deepEqual(committed.spentLadders, { required_detail: 1, [KEY]: 1 });
});

test("no policy declared: the bounce behaves exactly as before, latching nothing", async () => {
  const { body, committed } = await runSteps(
    makeOpts(),
    [{ action: "unbounded_capture", params: { value: "0354081" } }],
    BASE,
  );
  assert.equal(body.results[0].error, "invalid_params");
  assert.equal(committed.spentLadders, undefined);
});

test("the CONFIRM-GATED propose path bounces through the same bound", async () => {
  const step = { action: "gated_capture", params: { value: "0354081" } };
  const first = await runSteps(makeOpts(), [step], BASE);
  assert.equal(first.body.results[0].error, "invalid_params");
  assert.deepEqual(first.committed.spentLadders, { "capture:gated_capture": 1 });
  assert.equal(first.committed.awaitingInput, undefined, "a bounce stores no gate");
  const past = await runSteps(makeOpts(), [step], {
    ...BASE,
    spentLadders: { "capture:gated_capture": MAX },
  });
  assert.equal(past.body.results[0].summary, LADDERS.required_detail.instruction);
});

test("model-facing bytes stay COUNT-FREE at every stage of the bound", async () => {
  const states: S[] = [
    BASE,
    { ...BASE, spentLadders: { [KEY]: MAX } },
    { ...BASE, spentLadders: { [KEY]: MAX + 1, required_detail: 1 } },
  ];
  for (const state of states) {
    const { body } = await runSteps(makeOpts(), [BAD], state);
    const r = body.results[0];
    const bytes = `${r.summary} ${r._debug ?? ""}`;
    // The measured hazard is a count OF THE CAPTURE — how many digits were
    // expected, how many arrived, how many tries are left. Numerals and the
    // digit/attempt vocabulary are the whole surface; an instruction's "ONE
    // short sentence" is about brevity, not about the caller's value.
    assert.doesNotMatch(
      bytes,
      /\d|\b(digits?|ψηφί(?:o|ο|α|ων)|attempts?|tries|προσπάθει\w*)\b/iu,
      `a count reached the model: ${bytes}`,
    );
  }
});

test("construction: a bad max or an unknown ladder throws", () => {
  const badMax = makeOpts();
  (badMax.config.actions as Record<string, { captureBounces?: unknown }>).capture_value.captureBounces =
    { max: 0, ladder: "required_detail" };
  assert.throws(() => buildAgentStepTool(badMax), /captureBounces\.max as an integer/);

  const badLadder = makeOpts();
  (badLadder.config.actions as Record<string, { captureBounces?: unknown }>).capture_value.captureBounces =
    { max: 2, ladder: "nope" };
  assert.throws(() => buildAgentStepTool(badLadder), /not a configured ladder/);
});
