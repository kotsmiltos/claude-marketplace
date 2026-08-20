// FILE: src/agent-step/note-refusal.test.ts
//
// Engine-owned escalation ladders (journey-engine G7): the `note_refusal`
// control + the task-scoped `spentLadders` latch. The pins mirror the shape's
// two siblings (deflect_aside, the bounded choice's repeat fallback): a free
// use instructs and touches nothing else; exhaustion escalates ATOMICALLY
// into the ladder's configured handoff; the escalation route is engine-only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Annotation } from "@langchain/langgraph";
import { z } from "zod";

import { defineConfig } from "./define-config.js";
import { runSteps, buildAgentStepTool, type BuildAgentStepToolOptions } from "./runner.js";
import {
  agentStepStateSpec,
  agentStepTaskScopedSlots,
  type LibraryManagedSlots,
} from "./state.js";

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

type ActionName = "capture_value" | "gated_change";

const selectors = {
  capture_value: (state: S) => state,
  gated_change: (state: S) => state,
};

const LADDERS = {
  required_detail: {
    description: "The caller declines or cannot supply the required detail.",
    instruction:
      "Explain in ONE short sentence why the detail is needed, then re-ask in the SAME turn.",
    onExhaust: { reason: "abandon" as const, context: "test:details_not_provided" },
  },
};

function makeOpts(
  ladders: Record<string, unknown> | undefined = LADDERS,
): BuildAgentStepToolOptions<S, ActionName, never, typeof selectors> {
  const config = defineConfig<ActionName, never>({
    tool: { name: "ladder_test_tool", description: "ladder test tool" },
    actions: {
      capture_value: {
        description: "receives the asked-for value",
        paramsSchema: z.object({ value: z.string() }),
        prereqs: [],
        verdicts: { ok: { ok: true, summary: "captured" } },
      },
      gated_change: {
        description: "a confirm-gated mutation",
        paramsSchema: z.object({ value: z.string() }),
        prereqs: [],
        controller: { requiresConfirmation: { maxAttempts: 3 } },
        verdicts: { ok: { ok: true, summary: "changed" } },
      },
    },
  });
  return {
    config,
    stateSchema,
    selectors,
    executors: {
      capture_value: async () => ({ verdict: "ok" }),
      gated_change: async () => ({ verdict: "ok" }),
    },
    verifiers: {},
    handoff: { offTopic: { mode: "terminate" }, terminateMessage: "bye" },
    ladders: ladders as never,
  };
}

const BASE: S = { messages: [{ role: "user", id: "t1", content: "…" }] };

const noteStep = { action: "note_refusal", params: { ladder: "required_detail" } };

test("first use: the latch counts it and the result carries the configured instruction", async () => {
  const { body, committed } = await runSteps(makeOpts(), [noteStep], BASE);
  const r = body.results[0];
  assert.equal(r.ok, true);
  assert.equal(r.summary, LADDERS.required_detail.instruction);
  assert.equal(r.refusal_noted, true);
  assert.equal(r.ladder, "required_detail");
  assert.ok(!("handoff_requested" in r), "a free use never hands off");
  assert.deepEqual(committed.spentLadders, { required_detail: 1 });
  assert.equal(committed.handoff, undefined, "handoff untouched on a free use");
});

test("exhausted: the control escalates ATOMICALLY into the configured handoff", async () => {
  const { body, committed } = await runSteps(makeOpts(), [noteStep], {
    ...BASE,
    spentLadders: { required_detail: 1 },
  });
  const r = body.results[0];
  assert.equal(r.ok, true);
  assert.equal(r.ladder_exhausted, true);
  assert.equal(r.handoff_requested, true);
  assert.equal(r.reason, "abandon");
  assert.deepEqual(committed.handoff, {
    reason: "abandon",
    context: "test:details_not_provided",
  });
});

test("maxFreeUses: N free uses before the escalation", async () => {
  const opts = makeOpts({
    required_detail: { ...LADDERS.required_detail, maxFreeUses: 2 },
  });
  const second = await runSteps(opts, [noteStep], {
    ...BASE,
    spentLadders: { required_detail: 1 },
  });
  assert.equal(second.body.results[0].refusal_noted, true);
  assert.ok(!("handoff_requested" in second.body.results[0]));
  assert.deepEqual(second.committed.spentLadders, { required_detail: 2 });
  const third = await runSteps(opts, [noteStep], {
    ...BASE,
    spentLadders: { required_detail: 2 },
  });
  assert.equal(third.body.results[0].handoff_requested, true);
});

test("unknown ladder → invalid_params, nothing latched", async () => {
  const { body, committed } = await runSteps(
    makeOpts(),
    [{ action: "note_refusal", params: { ladder: "nope" } }],
    BASE,
  );
  assert.equal(body.results[0].error, "invalid_params");
  assert.equal(committed.spentLadders, undefined);
});

test("a standing dictation survives a free use untouched", async () => {
  const dictation = {
    kind: "dictation" as const,
    for_action: "capture_value",
    param: "value",
    expects: "text" as const,
  };
  const { committed } = await runSteps(makeOpts(), [noteStep], {
    ...BASE,
    awaitingInput: dictation,
  });
  assert.equal(committed.awaitingInput, undefined, "persists by non-write");
});

test("refused while a confirmation gate is locked — the gate's contract owns replies", async () => {
  const { body } = await runSteps(makeOpts(), [noteStep], {
    ...BASE,
    awaitingInput: {
      kind: "confirmation",
      for_action: "gated_change",
      params: { value: "lost" },
      attempts_left: 3,
      max_attempts: 3,
    },
  });
  assert.equal(body.results[0].ok, false);
  assert.ok(!body.results[0].refusal_noted, "no latch spend on a refused call");
});

test("note_refusal must be the sole step in its batch", async () => {
  const { body } = await runSteps(
    makeOpts(),
    [noteStep, { action: "capture_value", params: { value: "x" } }],
    BASE,
  );
  assert.equal(body.results[0].error, "note_refusal_must_be_sole_step");
});

test("construction: ladders without handoff, an empty instruction, or a bad onExhaust all throw", () => {
  const noHandoff = makeOpts();
  delete (noHandoff as { handoff?: unknown }).handoff;
  assert.throws(() => buildAgentStepTool(noHandoff), /ladders require handoff/);
  assert.throws(
    () =>
      buildAgentStepTool(
        makeOpts({ required_detail: { ...LADDERS.required_detail, instruction: " " } }),
      ),
    /non-empty instruction/,
  );
  assert.throws(
    () =>
      buildAgentStepTool(
        makeOpts({
          required_detail: { ...LADDERS.required_detail, onExhaust: { reason: "nope" } },
        }),
      ),
    /invalid onExhaust/,
  );
  // The deflect control stores its own once-latch under this key in the
  // shared spentLadders record.
  });

test("spentLadders is task-scoped (cleared by a task-ending handback)", () => {
  assert.ok(
    (agentStepTaskScopedSlots as readonly string[]).includes("spentLadders"),
    "a finished task's spent explanations must not poison the next task",
  );
});

test("the control is injected only when ladders are configured", () => {
  const enabled = buildAgentStepTool(makeOpts());
  assert.match(JSON.stringify(enabled.schema), /note_refusal/);
  assert.match(enabled.description, /note_refusal/);
  const disabledOpts = makeOpts();
  delete (disabledOpts as { ladders?: unknown }).ladders;
  const disabled = buildAgentStepTool(disabledOpts);
  assert.doesNotMatch(JSON.stringify(disabled.schema), /note_refusal/);
  assert.doesNotMatch(disabled.description, /note_refusal/);
});
