import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { Annotation } from "@langchain/langgraph";
import type { AIMessage } from "@langchain/core/messages";

import { defineConfig } from "./define-config.js";
import { buildAgentStepTool, runSteps, type BuildAgentStepToolOptions } from "./runner.js";
import { HANDOFF_ACTION, handoffRequested, type HandoffSpec } from "./handoff/contract.js";
import { createHandoffNode } from "./handoff/node.js";
import type { ExecutorRegistry, VerifierRegistry } from "./types.js";
import type {
  AwaitingInput,
  BoundedChoice,
  CurrentFlow,
  HandoffRequest,
} from "./state.js";
import type { PagedCache } from "./paginate.js";

interface S {
  thing?: string | null;
  awaitingInput?: AwaitingInput | null;
  currentFlow?: CurrentFlow | null;
  boundedChoice?: BoundedChoice | null;
  pagedRead?: PagedCache<unknown> | null;
  handoff?: HandoffRequest | null;
  errorCount?: number | null;
}

const replaceNull = <T>() => ({
  reducer: (_o: T | null, n: T | null) => n ?? null,
  default: () => null as T | null,
});

const testStateAnnotation = Annotation.Root({
  thing: Annotation<string | null>(replaceNull<string>()),
  awaitingInput: Annotation<AwaitingInput | null>(replaceNull<AwaitingInput>()),
  currentFlow: Annotation<CurrentFlow | null>(replaceNull<CurrentFlow>()),
  boundedChoice: Annotation<BoundedChoice | null>(replaceNull<BoundedChoice>()),
  pagedRead: Annotation<PagedCache<unknown> | null>(replaceNull<PagedCache<unknown>>()),
  handoff: Annotation<HandoffRequest | null>(replaceNull<HandoffRequest>()),
  errorCount: Annotation<number | null>(replaceNull<number>()),
});

type ActionName = "read_thing" | "change_thing";

function makeConfig() {
  return defineConfig<ActionName, never>({
    tool: { name: "test_tool", description: "test tool" },
    actions: {
      read_thing: {
        description: "read the thing",
        paramsSchema: z.object({}),
        prereqs: [],
      },
      change_thing: {
        description: "change the thing",
        paramsSchema: z.object({ v: z.string() }),
        prereqs: [],
        controller: { requiresConfirmation: true },
      },
    },
  });
}

const selectors = {
  read_thing: (s: S) => s,
  change_thing: (s: S) => s,
};

function makeOpts(withHandoff: boolean, withBoundedChoices = false): {
  opts: BuildAgentStepToolOptions<S, string, string, typeof selectors>;
  calls: { read: number; change: number };
} {
  const calls = { read: 0, change: 0 };
  const executors: ExecutorRegistry<S, typeof selectors> = {
    read_thing: async () => {
      calls.read++;
      return { resultBody: { summary: "thing read", value: "x" }, ok: true };
    },
    change_thing: async () => {
      calls.change++;
      return { resultBody: { summary: "thing changed" }, stateUpdate: { thing: "y" }, ok: true };
    },
  };
  const verifiers: VerifierRegistry<S> = {};
  const handoff: HandoffSpec<S> = {
    offTopic: { mode: "terminate" },
    terminateMessage: "Transferring you now.",
  };
  return {
    opts: {
      config: makeConfig(),
      stateSchema: testStateAnnotation,
      selectors,
      executors,
      verifiers,
      ...(withHandoff ? { handoff } : {}),
      ...(withBoundedChoices
        ? {
            boundedChoices: {
              unsupported_information: {
                description: "unsupported factual clarification",
                selections: ["continue"],
              },
            },
          }
        : {}),
    },
    calls,
  };
}

const HANDOFF_STEP = {
  action: HANDOFF_ACTION,
  params: { reason: "off_topic", context: "wants a transfer" },
};
const ABANDON_STEP = {
  action: HANDOFF_ACTION,
  params: { reason: "abandon", context: "status_change:human_requested" },
};

// ─── runner: built-in request_handoff action ──────────────────────────────── //

test("request_handoff (sole step) writes the handoff slot and succeeds", async () => {
  const { opts } = makeOpts(true);
  const { body, committed } = await runSteps(opts, [HANDOFF_STEP], {} as S);
  assert.equal(body.failed_at, undefined);
  assert.equal(body.results[0].ok, true);
  assert.equal(body.results[0].handoff_requested, true);
  assert.deepEqual(committed.handoff, { reason: "off_topic", context: "wants a transfer" });
  assert.equal(handoffRequested(committed), true);
});

test("request_handoff mixed with another step is refused, nothing executes", async () => {
  const { opts, calls } = makeOpts(true);
  const { body, committed } = await runSteps(
    opts,
    [{ action: "read_thing", params: {} }, HANDOFF_STEP],
    {} as S,
  );
  assert.equal(body.failed_at, 0);
  assert.equal(body.results[0].error, "handoff_must_be_sole_step");
  assert.equal(calls.read, 0);
  assert.equal(committed.handoff, undefined);
});

test("request_handoff with an invalid reason fails param validation", async () => {
  const { opts } = makeOpts(true);
  const { body, committed } = await runSteps(
    opts,
    [{ action: HANDOFF_ACTION, params: { reason: "bored", context: "x" } }],
    {} as S,
  );
  assert.equal(body.results[0].error, "invalid_params");
  assert.equal(committed.handoff, undefined);
});

test("request_handoff atomically abandons pending interaction, flow, and page state", async () => {
  const { opts } = makeOpts(true, true);
  const initial: S = {
    awaitingInput: {
      kind: "confirmation",
      for_action: "change_thing",
      params: { v: "y" },
      attempts_left: 2,
      max_attempts: 3,
      flow_ref: "change_flow",
    },
    currentFlow: { name: "change_flow", data: { proposed: "y" } },
    boundedChoice: { name: "unsupported_information", status: "pending" },
    pagedRead: {
      key: "read_thing",
      signature: "{}",
      rows: ["stale"],
      extras: { summary: "old page" },
    },
  };
  const { body, committed } = await runSteps(opts, [HANDOFF_STEP], initial);
  assert.equal(body.failed_at, undefined);
  assert.equal(body.results[0].ok, true);
  assert.deepEqual(committed.handoff, { reason: "off_topic", context: "wants a transfer" });
  assert.equal(committed.awaitingInput, null);
  assert.equal(committed.currentFlow, null);
  assert.equal(committed.boundedChoice, null);
  assert.equal(committed.pagedRead, null);
});

test("feature-disabled handoff leaves an unrelated boundedChoice-shaped host slot untouched", async () => {
  const { opts } = makeOpts(true);
  const initial: S = {
    boundedChoice: { name: "host_domain_choice", status: "pending" },
  };
  const { body, committed } = await runSteps(opts, [HANDOFF_STEP], initial);
  assert.equal(body.results[0].ok, true);
  assert.equal(committed.boundedChoice, undefined);
});

test("feature-disabled domain execution neither reads nor rewrites a boundedChoice-shaped host slot", async () => {
  const { opts, calls } = makeOpts(true);
  // getCallerTurnId MAY be consulted here (the config carries a confirm-gated
  // action, whose same-turn protection keys on the turn identity) — but the
  // bounded-choice machinery itself must stay fully inert: the pending-shaped
  // host slot is neither read (no lockdown fires) nor rewritten.
  const withoutFeature = {
    ...opts,
    getCallerTurnId: () => "turn-1",
  };
  const initial: S = {
    boundedChoice: { name: "host_domain_choice", status: "pending" },
  };
  const { body, committed } = await runSteps(
    withoutFeature,
    [{ action: "read_thing", params: {} }],
    initial,
  );
  assert.equal(body.results[0].ok, true);
  assert.equal(calls.read, 1);
  assert.equal(committed.boundedChoice, undefined);
});

test("caller-turn hook is never consulted when no feature needs it", async () => {
  const { opts } = makeOpts(true);
  // Strip the confirm gate so neither bounded choices nor confirmation exist.
  // (Shallow clone — the config holds zod schemas, which structuredClone
  // cannot copy.)
  const { controller: _dropped, ...bareChangeThing } = opts.config.actions.change_thing;
  const cfg = {
    ...opts.config,
    actions: { ...opts.config.actions, change_thing: bareChangeThing },
  } as typeof opts.config;
  const tripwired = {
    ...opts,
    config: cfg,
    getCallerTurnId: () => {
      throw new Error("must not be consulted when no feature needs turn identity");
    },
  };
  const { body } = await runSteps(tripwired, [{ action: "read_thing", params: {} }], {} as S);
  assert.equal(body.results[0].ok, true);
});

test("request_handoff from a pending confirmation resolves exactly once", async () => {
  const { opts } = makeOpts(true);
  const initial: S = {
    awaitingInput: {
      kind: "confirmation",
      for_action: "change_thing",
      params: { v: "y" },
      attempts_left: 2,
      max_attempts: 3,
    },
    currentFlow: { name: "change_flow", data: {} },
    pagedRead: { key: "read_thing", signature: "{}", rows: [], extras: {} },
  };
  const { committed } = await runSteps(opts, [ABANDON_STEP], initial);
  const pending = { ...initial, ...committed };
  const node = createHandoffNode<S>({
    offTopic: { mode: "terminate" },
    terminateMessage: "Transferring you now.",
  });
  const events: unknown[] = [];

  const first = await node(pending, nodeConfig(events));
  const messages = first.messages as AIMessage[];
  assert.equal(first.handoff, null);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].additional_kwargs.is_handoff, true);
  assert.equal(messages[0].additional_kwargs.handoff_type, "abandon");
  assert.deepEqual(
    (events as { type: string }[]).map((event) => event.type),
    ["handoff", "handoff_complete"],
  );

  const second = await node({ ...pending, handoff: first.handoff as null }, nodeConfig(events));
  assert.deepEqual(second, {});
  assert.equal(events.length, 2, "a consumed handoff emits no second control-plane signal");
});

test("request_handoff without the handoff opt is an unknown action", async () => {
  const { opts } = makeOpts(false);
  const { body } = await runSteps(opts, [HANDOFF_STEP], {} as S);
  assert.equal(body.results[0].error, "unknown_action");
});

test("config may define its own request_handoff when the handoff opt is absent", () => {
  // The orchestrator/scaffold mechanism predates the built-in and names its
  // own tool action `request_handoff`. The name is reserved ONLY for tools
  // that opt into the library handoff.
  const { opts } = makeOpts(false);
  const own = {
    ...opts,
    config: {
      tool: opts.config.tool,
      actions: {
        ...opts.config.actions,
        [HANDOFF_ACTION]: {
          description: "scaffold-mechanism outbound handoff (own action)",
          paramsSchema: z.object({}),
          prereqs: [],
        },
      },
    },
    selectors: { ...selectors, [HANDOFF_ACTION]: (s: S) => s },
    executors: {
      ...opts.executors,
      [HANDOFF_ACTION]: async () => ({ resultBody: {}, ok: true }),
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  assert.doesNotThrow(() => buildAgentStepTool(own as any));
});

test("config defining request_handoff is rejected at construction", () => {
  const { opts } = makeOpts(true);
  const bad = {
    ...opts,
    config: {
      tool: opts.config.tool,
      actions: {
        ...opts.config.actions,
        [HANDOFF_ACTION]: {
          description: "imposter",
          paramsSchema: z.object({}),
          prereqs: [],
        },
      },
    },
    selectors: { ...selectors, [HANDOFF_ACTION]: (s: S) => s },
    executors: {
      ...opts.executors,
      [HANDOFF_ACTION]: async () => ({ resultBody: {}, ok: true }),
    },
  };
  assert.throws(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    () => buildAgentStepTool(bad as any),
    /reserved action name/,
  );
});

test("tool description advertises request_handoff only when enabled", () => {
  const withIt = buildAgentStepTool(makeOpts(true).opts);
  const withoutIt = buildAgentStepTool(makeOpts(false).opts);
  assert.match(withIt.description, /request_handoff/);
  assert.doesNotMatch(withoutIt.description, /request_handoff/);
});

test("HandoffSpec.actionDescription overrides the request_handoff schema variant description", () => {
  // A host whose resolveClosingMessage overrides every closing must be able
  // to describe `context` truthfully — the built-in text promises the model
  // its context is what gets spoken.
  // The tool is bound with the JSON-schema rendering — read the variant
  // descriptions from the wire shape (what the provider actually receives).
  const variantDescriptions = (tool: { schema: unknown }): (string | undefined)[] => {
    const s = tool.schema as {
      properties: { steps: { items: { anyOf?: Array<{ description?: string }> } } };
    };
    return (s.properties.steps.items.anyOf ?? [s.properties.steps.items]).map(
      (o) => (o as { description?: string }).description,
    );
  };

  const { opts: defaults } = makeOpts(true);
  const stock = variantDescriptions(buildAgentStepTool(defaults));
  assert.ok(
    stock.some((d) => d?.includes("Hand the conversation back")),
    "without an override the built-in description is used",
  );

  const { opts: custom } = makeOpts(true);
  custom.handoff = { ...custom.handoff!, actionDescription: "CUSTOM-HANDOFF-DESC" };
  const overridden = variantDescriptions(buildAgentStepTool(custom));
  assert.ok(overridden.includes("CUSTOM-HANDOFF-DESC"), "override replaces the description");
  assert.ok(
    !overridden.some((d) => d?.includes("Hand the conversation back")),
    "the default text is fully replaced",
  );
});

// ─── handoff node ─────────────────────────────────────────────────────────── //

function nodeConfig(events: unknown[], threadId = "t-1") {
  return {
    configurable: { thread_id: threadId },
    writer: (chunk: unknown) => events.push(chunk),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

test("handoff node (terminate) off_topic is SILENT — empty content, slot cleared, envelope emitted", async () => {
  const node = createHandoffNode<S>({
    offTopic: { mode: "terminate" },
    terminateMessage: "Transferring you now.",
  });
  const events: unknown[] = [];
  const update = await node(
    { handoff: { reason: "off_topic", context: "wants a transfer" } },
    nodeConfig(events),
  );
  assert.equal(update.handoff, null);
  const [message] = update.messages as AIMessage[];
  // off_topic is a silent agent-to-agent hand-back — the caller hears nothing
  // from this agent; the router/destination owns the reply. The terminateMessage
  // is NOT spoken on a topic-change redirect.
  assert.equal(message.content, "");
  assert.deepEqual(message.additional_kwargs, {
    is_handoff: true,
    handoff_type: "off_topic",
    handoff_reason: "wants a transfer",
    handoff_metadata: {
      service_type: "off_topic",
      success_message: "",
    },
  });
  const types = (events as { type: string }[]).map((e) => e.type);
  assert.deepEqual(types, ["handoff", "handoff_complete"]);
  assert.equal((events[1] as { content: string }).content, "");
});

test("handoff node (completed) speaks the LLM-composed closing with the completed signal", async () => {
  const node = createHandoffNode<S>({
    offTopic: { mode: "terminate" },
    terminateMessage: "Transferring you now.",
  });
  const events: unknown[] = [];
  const update = await node(
    { handoff: { reason: "completed", context: "All done — your card is now active. Goodbye!" } },
    nodeConfig(events),
  );
  assert.equal(update.handoff, null);
  const [message] = update.messages as AIMessage[];
  // The closing is the LLM-composed context, NOT the off_topic envelope.
  assert.equal(message.content, "All done — your card is now active. Goodbye!");
  assert.deepEqual(message.additional_kwargs, {
    is_handoff: true,
    handoff_type: "completed",
    handoff_reason: "All done — your card is now active. Goodbye!",
    handoff_metadata: {
      service_type: "completed",
      success_message: "All done — your card is now active. Goodbye!",
    },
  });
});

test("handoff node (abandon) speaks the acknowledgement with the abandon signal", async () => {
  const node = createHandoffNode<S>({
    offTopic: { mode: "terminate" },
    terminateMessage: "Transferring you now.",
  });
  const update = await node(
    { handoff: { reason: "abandon", context: "No problem, we can stop here." } },
    nodeConfig([]),
  );
  const [message] = update.messages as AIMessage[];
  assert.equal(message.content, "No problem, we can stop here.");
  assert.equal(message.additional_kwargs.handoff_type, "abandon");
  assert.equal(message.additional_kwargs.is_handoff, true);
});

test("request_handoff accepts the completed and abandon reasons (sole step)", async () => {
  const { opts } = makeOpts(true);
  for (const reason of ["completed", "abandon"] as const) {
    const { body, committed } = await runSteps(
      opts,
      [{ action: HANDOFF_ACTION, params: { reason, context: "closing line" } }],
      {} as S,
    );
    assert.equal(body.results[0].ok, true);
    assert.deepEqual(committed.handoff, { reason, context: "closing line" });
  }
});

test("handoff node is a no-op when no handoff is pending", async () => {
  const node = createHandoffNode<S>({
    offTopic: { mode: "terminate" },
    terminateMessage: "x",
  });
  const update = await node({ handoff: null }, nodeConfig([]));
  assert.deepEqual(update, {});
});

test("handoff node (delegate) falls back to terminate when the delegate is unreachable", async () => {
  const node = createHandoffNode<S>({
    offTopic: {
      mode: "delegate",
      url: "http://127.0.0.1:9",
      assistantId: "general",
      timeoutMs: 2_000,
    },
    terminateMessage: "Transferring you now.",
  });
  const events: unknown[] = [];
  const update = await node(
    { handoff: { reason: "off_topic", context: "wants a transfer" } },
    nodeConfig(events),
  );
  const [message] = update.messages as AIMessage[];
  assert.equal(message.content, "Transferring you now.");
  assert.equal(message.additional_kwargs.is_handoff, true);
  assert.equal(message.additional_kwargs.handoff_type, "off_topic");
  assert.equal(typeof message.additional_kwargs.delegate_error, "string");
  const types = (events as { type: string }[]).map((e) => e.type);
  assert.deepEqual(types, ["handoff", "handoff_delegate_failed", "handoff_complete"]);
  // The control-plane event still reported the *intended* mode.
  assert.equal((events[0] as { mode: string }).mode, "delegate");
});

test("handoff node (delegate) connect timeout aborts a hung thread-create and falls back", async () => {
  const realFetch = globalThis.fetch;
  // The thread-creation POST hangs until its abort signal fires — only the
  // connect timer can end this test; the stream timer is deliberately huge.
  globalThis.fetch = ((_url: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(init.signal?.reason ?? new Error("aborted")),
      );
    })) as typeof fetch;
  try {
    const node = createHandoffNode<S>({
      offTopic: {
        mode: "delegate",
        url: "http://delegate.test",
        assistantId: "general",
        connectTimeoutMs: 50,
        timeoutMs: 60_000,
      },
      terminateMessage: "Transferring you now.",
    });
    const events: unknown[] = [];
    const started = Date.now();
    const update = await node(
      { handoff: { reason: "off_topic", context: "wants a transfer" } },
      nodeConfig(events),
    );
    assert.ok(Date.now() - started < 10_000, "fell back on the connect timer, not the stream timer");
    const [message] = update.messages as AIMessage[];
    assert.equal(message.content, "Transferring you now.");
    assert.equal(typeof message.additional_kwargs.delegate_error, "string");
    const types = (events as { type: string }[]).map((e) => e.type);
    assert.deepEqual(types, ["handoff", "handoff_delegate_failed", "handoff_complete"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("handoff node (delegate) stream timer starts after connect, not at delegate entry", async () => {
  const realFetch = globalThis.fetch;
  const sse =
    'event: messages\ndata: [{"type":"AIMessageChunk","content":"delegate reply"},{"langgraph_node":"reply"}]\n\n';
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith("/threads")) {
      // Connect deliberately takes LONGER than timeoutMs: were the stream
      // timer started at delegate entry, it would already have fired by the
      // time the run-stream request below is made.
      await new Promise((resolve) => setTimeout(resolve, 400));
      return new Response("{}", { status: 200 });
    }
    assert.equal(init?.signal?.aborted, false, "stream timer must not tick during connect");
    return new Response(sse, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }) as typeof fetch;
  try {
    const node = createHandoffNode<S>({
      offTopic: {
        mode: "delegate",
        url: "http://delegate.test",
        assistantId: "general",
        connectTimeoutMs: 60_000,
        timeoutMs: 150,
      },
      terminateMessage: "Transferring you now.",
    });
    const events: unknown[] = [];
    const update = await node(
      { handoff: { reason: "off_topic", context: "wants a transfer" } },
      nodeConfig(events),
    );
    // Delegate success: the delegate's reply is spoken, no handback kwargs.
    const [message] = update.messages as AIMessage[];
    assert.equal(message.content, "delegate reply");
    assert.deepEqual(message.additional_kwargs, { delegated_to: "general" });
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── clearsOnHandback ────────────────────────────────────────────────────────
// The thread OUTLIVES the task (channel middlewares reuse one thread id per
// call and never reset it), so a task-ending handback must not leave the
// finished task's state behind for the next one to inherit.

const BUSY_STATE: S & { outcome?: string | null; pointer?: string | null } = {
  awaitingInput: {
    kind: "confirmation",
    for_action: "change_thing",
    params: { v: "y" },
    attempts_left: 2,
    max_attempts: 3,
  },
  currentFlow: { name: "change_flow", data: { proposed: "y" } },
  boundedChoice: { name: "unsupported_information", status: "pending" },
  pagedRead: { key: "read_thing", signature: "{}", rows: ["stale"], extras: {} },
  errorCount: 2,
  outcome: "already_active",
  pointer: "card-1",
};

test("handoff node clears library task-scoped slots + declared domain slots on completed", async () => {
  const node = createHandoffNode<typeof BUSY_STATE>({
    offTopic: { mode: "terminate" },
    terminateMessage: "Transferring you now.",
    clearsOnHandback: ["outcome", "pointer"],
  });
  const events: unknown[] = [];
  const update = await node(
    { ...BUSY_STATE, handoff: { reason: "completed", context: "done" } },
    nodeConfig(events),
  );
  for (const slot of ["awaitingInput", "currentFlow", "boundedChoice", "pagedRead", "errorCount"]) {
    assert.equal(update[slot], null, `${slot} must be cleared`);
  }
  assert.equal(update.outcome, null, "declared domain slot must be cleared");
  assert.equal(update.pointer, null, "declared domain slot must be cleared");
  assert.equal(update.handoff, null);
  // The reply itself is unaffected — the closing is composed before the clear.
  const [message] = update.messages as AIMessage[];
  assert.equal(message.content, "done");
  assert.equal(message.additional_kwargs.handoff_type, "completed");
});

test("handoff node clears on abandon too (a failed task ends the task)", async () => {
  const node = createHandoffNode<typeof BUSY_STATE>({
    offTopic: { mode: "terminate" },
    terminateMessage: "Transferring you now.",
    clearsOnHandback: ["outcome"],
  });
  const update = await node(
    { ...BUSY_STATE, handoff: { reason: "abandon", context: "gave up" } },
    nodeConfig([]),
  );
  assert.equal(update.outcome, null);
  assert.equal(update.currentFlow, null);
});

test("handoff node clears NOTHING on off_topic — a mid-task aside stays resumable", async () => {
  const node = createHandoffNode<typeof BUSY_STATE>({
    offTopic: { mode: "terminate" },
    terminateMessage: "Transferring you now.",
    clearsOnHandback: ["outcome", "pointer"],
  });
  const update = await node(
    { ...BUSY_STATE, handoff: { reason: "off_topic", context: "wants something else" } },
    nodeConfig([]),
  );
  // Only the handoff slot is consumed; the in-progress task survives the aside
  // so the caller can be routed back into it.
  assert.deepEqual(Object.keys(update).sort(), ["handoff", "messages"]);
});

test("resolveClosingMessage still sees the pre-clear state", async () => {
  const seen: (string | null | undefined)[] = [];
  const node = createHandoffNode<typeof BUSY_STATE>({
    offTopic: { mode: "terminate" },
    terminateMessage: "Transferring you now.",
    clearsOnHandback: ["outcome"],
    resolveClosingMessage: (state) => {
      seen.push(state.outcome);
      return state.outcome === "already_active" ? "No activation needed." : undefined;
    },
  });
  const update = await node(
    { ...BUSY_STATE, handoff: { reason: "completed", context: "internal" } },
    nodeConfig([]),
  );
  assert.deepEqual(seen, ["already_active"], "the closing is chosen BEFORE the clear");
  const [message] = update.messages as AIMessage[];
  assert.equal(message.content, "No activation needed.");
  assert.equal(update.outcome, null);
});

test("a spec without clearsOnHandback clears only the library's own slots", async () => {
  const node = createHandoffNode<typeof BUSY_STATE>({
    offTopic: { mode: "terminate" },
    terminateMessage: "Transferring you now.",
  });
  const update = await node(
    { ...BUSY_STATE, handoff: { reason: "completed", context: "done" } },
    nodeConfig([]),
  );
  assert.equal(update.awaitingInput, null);
  assert.equal(update.outcome, undefined, "an undeclared domain slot is never touched");
});
