# Reference: Orchestration Boundaries

<overview>
The runner is a flow controller. It owns proposal state, parameter matching, attempt accounting,
pending-action lockdown, flow lifecycle, pagination, and atomic handoff clearing. Every one of those
mechanisms has a host-side lookalike that a project reaches for when a live conversation misbehaves —
an extra action to record a choice, an extra graph node to force an outcome, an extra system message
to make the model act. Each one looks like a small local fix. Together they are a second, undocumented
orchestrator running beside the first, and the two disagree under load.

This reference draws the boundary: what belongs in an action, what belongs in the graph, and what
belongs to the library. It is written from measured failures in deployed agents, not from taste —
including one where the failure mode was an irreversible action executed against the user's intent.

Read this before adding an action, a graph node, or a model-input guard.
</overview>

<action_boundary>
## Actions do work; the library controls orchestration

**A domain action must add authoritative behaviour:** backend I/O, tool-side validation, or a
meaningful deterministic business-state transition.

An empty-parameter action that only records a conversational choice, selects a closing, or requests a
handoff is a **wrapper around the library** and should not exist. The tell is an executor with no
`rawParams` use, no backend call, and a `stateUpdate` that writes one outcome enum:

```ts
// ANTI-PATTERN — a no-op action the model must be taught to call
export async function declareDetailsUnknown(_rawParams, state) {
  return {
    resultBody: { summary: M.details_unknown.recorded, verdict: "recorded" },
    stateUpdate: { flowOutcome: "details_unknown" },
    ok: true,
  };
}
```

Everything this achieves is already available: the built-in `request_handoff` with an exact
`{ reason, context }` pair. The wrapper costs a schema entry the model must choose correctly, a
locale entry, a registry entry, a selector, and a test suite — to express a transition the library
already expresses.

**Use the built-in `request_handoff` directly** for non-operational terminal choices — the customer
declines to continue, asks for a human, is pointed at self-service, or cannot supply a required
detail. Define the host's stable `{ reason, context }` pairs in one place and document them; the
`context` is what `resolveClosingMessage` keys the spoken line on.

**Use `createTerminalHandoff` (1.9.0+)** for the other kind of terminal: an outcome an *executor*
establishes deterministically. It writes the `handoff` slot in the same `stateUpdate` as the domain
outcome, so nothing depends on the model making a second call. See `agent-step-api.md`
§ *Executor half*.

**Do not split a deterministic continuation into a second model-selected action.** If step B always
follows step A with no judgement in between, B belongs inside A's executor. Every action boundary is
a decision the model can get wrong; do not create decisions that do not exist.

**Do not create an intent-classification action or graph node for a judgement the ReAct model already
makes.** Triage belongs in the prompt unless a tool consults an external authority or produces a
deterministic fact the model cannot establish itself.

**Keep outcome state single-purpose.** Reserve a domain outcome slot for executor-owned
backend/business results. Conversational choices carry their meaning in the handoff `context` — do
not mirror them into a second outcome enum, or two sources of truth will drift.
</action_boundary>

<graph_minimalism>
## Do not duplicate the runner

**Target three semantic nodes: `agent`, `tools`, and `resolve_handoff`.** Add another only when a
required transition genuinely cannot be expressed by the runner, a domain executor, or the handoff
contract — and document the missing library capability first, so the gap gets fixed upstream instead
of worked around in every project.

The common surplus node watches an outcome enum and forces a handback the model failed to emit
(`force_escalate`, `force_complete`, and relatives). It is a real bug being patched in the wrong
place: the executor that wrote the enum already knew the conversation was over. Move the knowledge to
where it originated — `createTerminalHandoff` in the executor's `stateUpdate` — and the node has
nothing left to do.

Project graph code must not reproduce proposal state, parameter matching, attempt accounting,
pending-action lockdown, or handoff clearing. If a project has re-implemented one of these, it will
diverge from the runner's version at exactly the moment both are under pressure.
</graph_minimalism>

<confirmation_safety>
## Never add a graph-level "act now" confirmation nudge

This one has a price tag. Read it before you reinvent it.

**The confirmation gate is a real two-call gate.** The first matching action call proposes and reads
the values back; a later exact-parameter re-call executes. A clarification makes **no tool call** and
leaves `awaitingInput` unchanged. A clear correction re-proposes. A terminal cancellation,
self-service pivot, or human request uses `request_handoff` directly — it is allowed under lockdown
and clears the pending interaction atomically.

**The problem it tries to solve.** A model sometimes ends its turn with a confirmation still pending
and no decision taken — announcing it will proceed while calling nothing. The runner then locks every
following step (`pending_confirmation_locked`), so the user's next answer is discarded and they are
asked to confirm the same value again.

**The fix that looks obvious.** A graph guard that detects the stalled gate and appends one
SystemMessage to the model input — "a confirmation is pending, act NOW in this same turn" — without
interpreting the user's words at all. It can be built carefully: once per user turn, no keyword
matching, the model still choosing between executing, re-proposing and aborting.

**Why it does not work.** Measured across successive attempts to make it safe:

1. Firing while the gate was proposed in the *same* turn made the model execute before the user had
   answered the read-back — the gate bypassed entirely, in every conversation observed.
2. Skipping same-turn proposals was not enough. On a mutation gate, a user objecting to part of the
   proposal was read as confirmation, and the irreversible action executed.
3. Narrowing to read-only actions was also not enough as a design, and the guard was removed. With no
   nudge, the model answers the objection and re-asks — confirmed by a live objection test.

**The rule.** A false execute on a READ costs a lookup of values the user already confirmed. A
false execute on a MUTATION is unrecoverable. Any instruction that raises the model's prior toward
"act" applies to both, because the model reads instruction tone, not your action taxonomy. Prompt
priority plus runner state is the safe boundary; a stalled gate is recovered by the customer speaking
again, which is cheap.

If a stalled confirmation is hurting a specific flow, fix the **prompt's** handling of that gate, or
raise a library gap — do not add a graph nudge.

**Model-input guards in general.** A guard that hands the model a *fact* it cannot observe (an earlier
signal already fired; the channel gave no feedback) is defensible, provided it fires at most once per
customer turn, never enters the channel's message stream, and interprets nothing. A guard that tells
the model what to *decide* is the anti-pattern above.
</confirmation_safety>

<handoff_honesty>
## A promise is not a transfer

**Never tell the customer that someone will take over unless the same turn executes the terminal
action that emits the handoff.** After that action succeeds, produce no model-composed answer text —
the resolver supplies the fixed closing.

**Handoff `context` is internal routing metadata.** Only exact `{ reason, context }` pairs may select
caller-audible catalog messages; arbitrary model-composed context is never spoken. This is what makes
`resolveClosingMessage` an honesty mechanism rather than decoration: the spoken line is derived from
what actually happened, not from what the model chose to say.

**An explicit human request has priority at every stage, including a pending confirmation.** The
built-in action is designed for exactly this — no prereqs, allowed under lockdown, atomic clear.

**A graph checkpoint is not a delivered transfer.** It proves only that the agent requested a
transition. The transfer is verified at the channel boundary, when the middleware emits the expected
handoff frame. Where the downstream leg gives no completion feedback, never claim the customer was
connected and never give a wait estimate.

**An off-topic request hands back silently** so the orchestrator can route it; the middleware must not
re-enter the same specialist in the same turn.
</handoff_honesty>

<review_checklist>
## Review checklist

Before merging a change that adds an action, a node, or a guard:

- [ ] Every action does backend I/O, tool-side validation, or a deterministic business transition — no empty-parameter recorders.
- [ ] Terminal outcomes an executor establishes write the `handoff` slot themselves (`createTerminalHandoff`), not via a second model call or a forcing node.
- [ ] Terminal conversational choices use the built-in `request_handoff` with a documented `{ reason, context }` pair.
- [ ] The graph is `agent` / `tools` / `resolve_handoff`, or the extra node's missing library capability is written down.
- [ ] No graph code re-implements proposal state, parameter matching, attempt accounting, lockdown, or handoff clearing.
- [ ] No model-input guard tells the model what to decide; any guard supplies only unobservable facts, once per customer turn, outside the channel stream.
- [ ] No spoken text promises a transfer that the same turn does not execute.
- [ ] Deterministic continuations live inside the executor that precedes them, not behind a new action boundary.
</review_checklist>
