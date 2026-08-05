import { test } from "node:test";
import { validate } from "@cfworker/json-schema";
import assert from "node:assert/strict";
import { Annotation } from "@langchain/langgraph";
import { z } from "zod";

import { defineConfig } from "./define-config.js";
import {
  buildAgentStepTool,
  REQUEST_BOUNDED_CHOICE_ACTION,
  RESOLVE_BOUNDED_CHOICE_ACTION,
  runSteps,
  type BuildAgentStepToolOptions,
} from "./runner.js";
import type { ExecutorRegistry } from "./types.js";
import type {
  AwaitingInput,
  BoundedChoice,
  CurrentFlow,
  HandoffRequest,
} from "./state.js";
import type { PagedCache } from "./paginate.js";

interface S {
  messages?: unknown[];
  detail?: string | null;
  changed?: boolean | null;
  awaitingInput?: AwaitingInput | null;
  currentFlow?: CurrentFlow | null;
  boundedChoice?: BoundedChoice | null;
  pagedRead?: PagedCache<unknown> | null;
  handoff?: HandoffRequest | null;
}

const replace = <T>() => ({
  reducer: (_old: T | null, next: T | null) => next,
  default: () => null as T | null,
});

const stateSchema = Annotation.Root({
  detail: Annotation<string | null>(replace<string>()),
  changed: Annotation<boolean | null>(replace<boolean>()),
  awaitingInput: Annotation<AwaitingInput | null>(replace<AwaitingInput>()),
  currentFlow: Annotation<CurrentFlow | null>(replace<CurrentFlow>()),
  boundedChoice: Annotation<BoundedChoice | null>(replace<BoundedChoice>()),
  pagedRead: Annotation<PagedCache<unknown> | null>(replace<PagedCache<unknown>>()),
  handoff: Annotation<HandoffRequest | null>(replace<HandoffRequest>()),
  errorCount: Annotation<number | null>(replace<number>()),
});

type ActionName = "capture_detail" | "permanent_change";

const config = defineConfig<ActionName, never>({
  tool: { name: "choice_test_tool", description: "bounded-choice test tool" },
  actions: {
    capture_detail: {
      description: "capture a detail supplied by the caller",
      paramsSchema: z.object({ value: z.string() }),
      prereqs: [],
    },
    permanent_change: {
      description: "perform a permanent confirm-required change",
      paramsSchema: z.object({ value: z.string() }),
      prereqs: [],
      controller: { requiresConfirmation: true, soleOnExecute: true },
    },
  },
});

const selectors = {
  capture_detail: (state: S) => state,
  permanent_change: (state: S) => state,
};

function makeOpts(withHandoff = true): {
  opts: BuildAgentStepToolOptions<S, ActionName, never, typeof selectors>;
  calls: { capture: number; change: number };
} {
  const calls = { capture: 0, change: 0 };
  const executors: ExecutorRegistry<S, typeof selectors> = {
    capture_detail: async (raw) => {
      calls.capture++;
      const value = (raw as { value: string }).value;
      return {
        resultBody: { summary: "detail captured" },
        stateUpdate: { detail: value },
        ok: true,
      };
    },
    permanent_change: async () => {
      calls.change++;
      return {
        resultBody: { summary: "permanent change complete" },
        stateUpdate: { changed: true },
        ok: true,
      };
    },
  };
  return {
    opts: {
      config,
      stateSchema,
      selectors,
      executors,
      verifiers: {},
      ...(withHandoff
        ? {
            handoff: {
              offTopic: { mode: "terminate" as const },
              terminateMessage: "bye",
            },
          }
        : {}),
      boundedChoices: {
        unsupported_information: {
          description: "unsupported factual clarification",
          selections: ["continue"],
          directInputActions: ["capture_detail"],
          onRepeatHandoff: {
            reason: "abandon",
            context: "status_change:human_requested",
          },
        },
      },
    },
    calls,
  };
}

const pendingConfirmation: AwaitingInput = {
  kind: "confirmation",
  for_action: "permanent_change",
  params: { value: "lost" },
  attempts_left: 3,
  max_attempts: 3,
};

const requestChoice = {
  action: REQUEST_BOUNDED_CHOICE_ACTION,
  params: { choice: "unsupported_information" },
};

const continueChoice = {
  action: RESOLVE_BOUNDED_CHOICE_ACTION,
  params: { choice: "unsupported_information", selection: "continue" },
};

test("bounded choice controls are injected without becoming domain actions", () => {
  const { opts } = makeOpts();
  const tool = buildAgentStepTool(opts);
  assert.deepEqual(Object.keys(config.actions).sort(), ["capture_detail", "permanent_change"]);
  // The tool is bound with the JSON-schema rendering; assert through the same
  // shape validator the wrapper uses.
  assert.equal(validate({ steps: [requestChoice] }, tool.schema as never).valid, true);
  assert.equal(validate({ steps: [continueChoice] }, tool.schema as never).valid, true);
  assert.match(tool.description, /request_bounded_choice/);
  assert.match(tool.description, /resolve_bounded_choice/);
});

test("offer overlays a pending confirmation without changing any underlying runner state", async () => {
  const { opts, calls } = makeOpts();
  const initial: S = {
    awaitingInput: pendingConfirmation,
    currentFlow: { name: "loss", data: { card: "bound" } },
    pagedRead: { key: "cards", signature: "{}", rows: ["cached"], extras: {} },
  };
  const { body, committed } = await runSteps(opts, [requestChoice], initial);
  const next = { ...initial, ...committed };
  assert.equal(body.results[0].choice_requested, true);
  assert.deepEqual(next.awaitingInput, pendingConfirmation);
  assert.deepEqual(next.currentFlow, initial.currentFlow);
  assert.deepEqual(next.pagedRead, initial.pagedRead);
  assert.deepEqual(next.boundedChoice, {
    name: "unsupported_information",
    status: "pending",
  });
  assert.deepEqual(calls, { capture: 0, change: 0 });
});

test("continue resolves only the choice and preserves the suspended confirmation", async () => {
  const { opts, calls } = makeOpts();
  const initial: S = {
    messages: [{ role: "user", content: "continue", id: "turn-continue" }],
    awaitingInput: pendingConfirmation,
    boundedChoice: { name: "unsupported_information", status: "pending" },
  };
  const { body, committed } = await runSteps(opts, [continueChoice], initial);
  const next = { ...initial, ...committed };
  assert.equal(body.results[0].choice_resolved, true);
  assert.deepEqual(next.awaitingInput, pendingConfirmation);
  assert.deepEqual(next.boundedChoice, {
    name: "unsupported_information",
    status: "resolved",
    selection: "continue",
    resolved_on_caller_turn_id: "turn-continue",
  });
  assert.equal(calls.change, 0, "a meta-level continue never executes the mutation");
});

test("resolution fails closed when no stable caller-turn identity is available", async () => {
  const { opts, calls } = makeOpts();
  const initial: S = {
    messages: [{ role: "user", content: "continue" }],
    awaitingInput: pendingConfirmation,
    boundedChoice: { name: "unsupported_information", status: "pending" },
  };
  const { body, committed } = await runSteps(opts, [continueChoice], initial);
  assert.equal(body.results[0].error, "bounded_choice_turn_identity_unavailable");
  assert.deepEqual(committed, {});
  assert.equal(calls.change, 0);
});

test("hosts that compact messages can provide an explicit stable caller-turn id", async () => {
  const { opts } = makeOpts();
  const compactingHost = {
    ...opts,
    getCallerTurnId: () => "invoke-42",
  };
  const initial: S = {
    awaitingInput: pendingConfirmation,
    boundedChoice: { name: "unsupported_information", status: "pending" },
  };
  const { body, committed } = await runSteps(
    compactingHost,
    [continueChoice],
    initial,
  );
  assert.equal(body.results[0].choice_resolved, true);
  assert.deepEqual(committed.boundedChoice, {
    name: "unsupported_information",
    status: "resolved",
    selection: "continue",
    resolved_on_caller_turn_id: "invoke-42",
  });
});

test("pending choice blocks a mistaken matching mutation re-call", async () => {
  const { opts, calls } = makeOpts();
  const initial: S = {
    awaitingInput: pendingConfirmation,
    boundedChoice: { name: "unsupported_information", status: "pending" },
  };
  const { body, committed } = await runSteps(
    opts,
    [{ action: "permanent_change", params: { value: "lost" } }],
    initial,
  );
  assert.equal(body.results[0].error, "bounded_choice_pending_locked");
  assert.equal(calls.change, 0);
  assert.deepEqual(committed, {});
});

test("resolve control cannot be batched with a suspended mutation", async () => {
  const { opts, calls } = makeOpts();
  const initial: S = {
    awaitingInput: pendingConfirmation,
    boundedChoice: { name: "unsupported_information", status: "pending" },
  };
  const { body } = await runSteps(
    opts,
    [continueChoice, { action: "permanent_change", params: { value: "lost" } }],
    initial,
  );
  assert.equal(body.results[0].error, "bounded_choice_must_be_sole_step");
  assert.equal(calls.change, 0);
});

test("resolved choice keeps domain work locked for the rest of the same caller turn", async () => {
  const { opts, calls } = makeOpts();
  const initial: S = {
    messages: [{ role: "user", content: "continue", id: "turn-continue" }],
    awaitingInput: pendingConfirmation,
    boundedChoice: {
      name: "unsupported_information",
      status: "resolved",
      selection: "continue",
      resolved_on_caller_turn_id: "turn-continue",
    },
  };
  const { body, committed } = await runSteps(
    opts,
    [{ action: "permanent_change", params: { value: "lost" } }],
    initial,
  );
  assert.equal(body.results[0].error, "bounded_choice_resume_turn_locked");
  assert.equal(calls.change, 0);
  assert.deepEqual(committed, {});
});

test("a stored turn id with missing current identity fails closed for domain work", async () => {
  const { opts, calls } = makeOpts();
  const initial: S = {
    awaitingInput: pendingConfirmation,
    boundedChoice: {
      name: "unsupported_information",
      status: "resolved",
      selection: "continue",
      resolved_on_caller_turn_id: "turn-continue",
    },
  };
  const { body } = await runSteps(
    opts,
    [{ action: "permanent_change", params: { value: "lost" } }],
    initial,
  );
  assert.equal(body.results[0].error, "bounded_choice_resume_turn_locked");
  assert.equal(calls.change, 0);
});

test("same-turn lock still permits an immediate terminal human handoff", async () => {
  const { opts, calls } = makeOpts();
  const initial: S = {
    messages: [{ role: "user", content: "continue", id: "turn-continue" }],
    awaitingInput: pendingConfirmation,
    boundedChoice: {
      name: "unsupported_information",
      status: "resolved",
      selection: "continue",
      resolved_on_caller_turn_id: "turn-continue",
    },
  };
  const { body, committed } = await runSteps(
    opts,
    [
      {
        action: "request_handoff",
        params: { reason: "abandon", context: "status_change:human_requested" },
      },
    ],
    initial,
  );
  assert.equal(body.results[0].handoff_requested, true);
  assert.deepEqual(committed.handoff, {
    reason: "abandon",
    context: "status_change:human_requested",
  });
  assert.equal(committed.awaitingInput, null);
  assert.equal(committed.boundedChoice, null);
  assert.deepEqual(calls, { capture: 0, change: 0 });
});

test("after explicit continue, the later confirmation re-call may execute", async () => {
  const { opts, calls } = makeOpts();
  const initial: S = {
    messages: [
      { role: "user", content: "continue", id: "turn-continue" },
      { role: "assistant", content: "repeat confirmation" },
      { role: "user", content: "yes", id: "turn-confirm" },
    ],
    awaitingInput: pendingConfirmation,
    boundedChoice: {
      name: "unsupported_information",
      status: "resolved",
      selection: "continue",
      resolved_on_caller_turn_id: "turn-continue",
    },
  };
  const { body, committed } = await runSteps(
    opts,
    [{ action: "permanent_change", params: { value: "lost" } }],
    initial,
  );
  assert.equal(body.results[0].ok, true);
  assert.equal(calls.change, 1);
  assert.equal(committed.awaitingInput, null);
  assert.equal(committed.changed, true);
  assert.deepEqual(committed.boundedChoice, undefined, "resolved one-shot marker persists");
});

test("configured direct input consumes a pending choice and proceeds normally", async () => {
  const { opts, calls } = makeOpts();
  const initial: S = {
    boundedChoice: { name: "unsupported_information", status: "pending" },
  };
  const { body, committed } = await runSteps(
    opts,
    [{ action: "capture_detail", params: { value: "123" } }],
    initial,
  );
  assert.equal(body.results[0].ok, true);
  assert.equal(calls.capture, 1);
  assert.equal(committed.detail, "123");
  assert.deepEqual(committed.boundedChoice, {
    name: "unsupported_information",
    status: "resolved",
    selection: "domain_input",
  });
});

for (const status of ["pending", "resolved"] as const) {
  test(`repeat offer from ${status} state atomically escalates and clears all transient state`, async () => {
    const { opts, calls } = makeOpts();
    const initial: S = {
      awaitingInput: pendingConfirmation,
      currentFlow: { name: "loss", data: {} },
      boundedChoice: {
        name: "unsupported_information",
        status,
        ...(status === "resolved"
          ? {
              selection: "continue",
              resolved_on_caller_turn_id: "turn-continue",
            }
          : {}),
      },
      ...(status === "resolved"
        ? {
            messages: [
              { role: "user", content: "continue", id: "turn-continue" },
              {
                role: "user",
                content: "another unsupported question",
                id: "turn-faq-2",
              },
            ],
          }
        : {}),
      pagedRead: { key: "cards", signature: "{}", rows: [], extras: {} },
    };
    const { body, committed } = await runSteps(opts, [requestChoice], initial);
    assert.equal(body.results[0].handoff_requested, true);
    assert.deepEqual(committed.handoff, {
      reason: "abandon",
      context: "status_change:human_requested",
    });
    assert.equal(committed.awaitingInput, null);
    assert.equal(committed.currentFlow, null);
    assert.equal(committed.boundedChoice, null);
    assert.equal(committed.pagedRead, null);
    assert.deepEqual(calls, { capture: 0, change: 0 });
  });
}

test("repeat-handoff configuration is rejected when handoff is disabled", () => {
  const { opts } = makeOpts(false);
  assert.throws(
    () => buildAgentStepTool(opts),
    /configures onRepeatHandoff but handoff is not enabled/,
  );
});

test("repeat-handoff configuration is runtime-validated at construction", () => {
  const { opts } = makeOpts();
  const invalid = {
    ...opts,
    boundedChoices: {
      unsupported_information: {
        description: "unsupported factual clarification",
        selections: ["continue"],
        onRepeatHandoff: { reason: "invalid", context: "" },
      },
    },
  } as unknown as typeof opts;
  assert.throws(
    () => buildAgentStepTool(invalid),
    /invalid onRepeatHandoff/,
  );
});

test("repeat fallback commits only the normalized handoff fields", async () => {
  const { opts } = makeOpts();
  const withExtra = {
    ...opts,
    boundedChoices: {
      unsupported_information: {
        description: "unsupported factual clarification",
        selections: ["continue"],
        onRepeatHandoff: {
          reason: "abandon",
          context: "status_change:human_requested",
          leaked: "must-not-reach-state",
        },
      },
    },
  } as unknown as typeof opts;
  buildAgentStepTool(withExtra);
  const { committed } = await runSteps(withExtra, [requestChoice], {
    boundedChoice: { name: "unsupported_information", status: "pending" },
  });
  assert.deepEqual(committed.handoff, {
    reason: "abandon",
    context: "status_change:human_requested",
  });
});
