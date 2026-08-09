// FILE: src/agent-step/types.ts
//
// Public authoring contracts for the agent-step library: what a host DECLARES
// (actions, controller hooks, registries) and what an executor RETURNS. The
// compiled/runtime shapes derived from these live under compile/ and run/ —
// hosts never import those.

import type { z } from "zod";
import type { PageableSpec } from "./paginate.js";
import type { HandoffRequest } from "./state.js";

/** A typed library-state transition an executor may request. Effects are
 *  SIGNALS, not an ordered program: the runner honours each one at a fixed,
 *  documented point of the step lifecycle (see run/execution.ts):
 *
 *  - `request_handoff` — terminal business outcome: atomically clears every
 *    transient runner slot (`awaitingInput`, `currentFlow`, `boundedChoice`,
 *    `pagedRead`) and writes the `handoff` slot, exactly like the built-in
 *    `request_handoff` action. Honoured regardless of `ok` — a refusal verdict
 *    (e.g. "already closed") may still be terminal. TERMINAL IS ENFORCED:
 *    once the handoff is set, the step's remaining interaction lifecycle
 *    (flow open, OTP/match gates) is skipped and the batch ends after the
 *    current step — later steps do not run (handoff monotonicity, see
 *    run/execution.ts). This is the ONLY way an executor requests a handoff;
 *    writing the `handoff` slot through `stateUpdate` is rejected loudly.
 *  - `merge_flow_data` — shallow-merge into `currentFlow.data`. Honoured on
 *    `ok: true`; requesting it with no active flow (and no `startsFlow` on the
 *    action) is a programmer mistake and throws.
 *  - `otp_issued` — this step minted an SCA challenge; the runner opens the
 *    OTP gate for the consumer named in the action's `issuesOtp` hook.
 *    Honoured on `ok: true`; requires an active flow and the config hook.
 *  - `clear_awaiting_input` — drop the pending input gate only, keep the flow.
 *    Used for "the current OTP is dead but the flow continues" (e.g. timeout).
 *    Honoured regardless of `ok`.
 *  - `abort_flow` — terminal in-flow failure; drop the gate AND the flow (and
 *    any bounded-choice overlay). Honoured regardless of `ok`. */
export type ExecutorEffect =
  | { type: "request_handoff"; request: HandoffRequest }
  | { type: "merge_flow_data"; data: Record<string, unknown> }
  | { type: "otp_issued" }
  | { type: "clear_awaiting_input" }
  | { type: "abort_flow" };

/** Result a single executor returns to the runner. `resultBody` is the
 *  JSON-serializable object the LLM sees as that step's payload. `ok` is a
 *  batch-continuation control flag, NOT a success/verdict signal: `ok: true`
 *  proceeds to the next step; `ok: false` short-circuits the batch and sets
 *  `failed_at`. An executor may return `ok: true` for a "negative" domain
 *  outcome (carry the verdict in `resultBody`) when later steps should still
 *  run — decide on whether the batch should continue, not on whether the
 *  outcome was "good".
 *
 *  `stateUpdate` is a partial patch of HOST-OWNED slots, threaded to
 *  subsequent steps in the batch AND accumulated into the final tool Command.
 *  Library-managed slots (`awaitingInput`, `currentFlow`, `boundedChoice`,
 *  `pagedRead`, `handoff`, `errorCount`) may NOT appear in it — the runner is
 *  their only writer and rejects such a patch loudly. Library transitions go
 *  through `effects` instead. */
export interface ExecutorResult<T> {
  resultBody: object;
  stateUpdate?: Partial<T>;
  effects?: ExecutorEffect[];
  ok: boolean;
}

/** Projects the host state down to the slice one action's executor needs. The
 *  runner runs the action's selector (looked up by action name, like the
 *  executor) and hands the result to the executor as its `state` — the executor
 *  never sees the whole state, and never declares its own slice. A selector is
 *  trusted glue: it may reshape/rename, not just narrow. */
export type Selector<T> = (state: T) => unknown;

/** Selectors keyed 1:1 by action name. The runner looks the selector up by the
 *  step's action name (no transformation — the key IS the action name) and runs
 *  it to build the executor's `state`. */
export type SelectorRegistry<T, ActionName extends string> = Record<ActionName, Selector<T>>;

/** Executor called by the runner for each step. Receives `Slice` — whatever the
 *  action's selector returned — NOT the whole state, so it can't see anything
 *  the selector didn't hand it. Mutations that need verification (e.g.
 *  read-back after the write) handle it internally — the library has no wrap
 *  concept. */
export type Executor<Slice, T> = (
  params: unknown,
  state: Slice,
) => Promise<ExecutorResult<T>>;

/** The executor registry, keyed 1:1 by action name. Each entry's `state` param
 *  is derived from that action's selector return (`ReturnType<Selectors[K]>`),
 *  so an executor whose signature doesn't match what its selector produces is a
 *  compile error. */
export type ExecutorRegistry<
  T,
  Selectors extends Record<string, Selector<T>>,
> = {
  [K in keyof Selectors]: Executor<ReturnType<Selectors[K]>, T>;
};

/** Self-contained prereq: the predicate that tests state plus the denial body
 *  the runner emits when the predicate is false. The key in the registry is
 *  the prereq's name (used in `ActionDef.prereqs`). */
export interface Verifier<T> {
  check: (state: T) => boolean;
  denial: { summary: string; error: string };
}
export type VerifierRegistry<T> = Record<string, Verifier<T>>;

export interface ActionDef<PrereqName extends string> {
  /** Full LLM-facing mechanics for this action — params, verdicts/refusal
   *  codes, result-body shape, lifecycle. Attached to the action's Zod schema
   *  variant via `.describe()`, so the model receives it once, in the schema.
   *  Keep it mechanics-only; conversational policy belongs in the prompt. */
  description: string;
  /** Optional one-line label for the action, used ONLY in the composed
   *  tool-level description's action index. The full `description` is NOT
   *  repeated there — it already reaches the model through the schema. When
   *  omitted, the composed description lists the action name alone. */
  summary?: string;
  paramsSchema: z.ZodTypeAny;
  prereqs: PrereqName[];
  /** Downstream-slot invalidation map. Keys are state slot names this action
   *  may write; values are the slot names to reset to `null` when the watched
   *  slot's value CHANGES between pre-step and post-step state (after the
   *  executor's `stateUpdate` has been folded in). Used to express "if X is
   *  re-collected with a different value, anything derived from X is stale."
   *
   *  Change rule: invalidation fires only when the pre-step value was non-null
   *  AND the written value is not deep-VALUE-equal to it (canonicalized JSON
   *  compare — reference identity never counts, so an executor writing a
   *  fresh-but-equal object does not fire). First-time set (null → value)
   *  does NOT fire — there was nothing downstream to invalidate.
   *
   *  Invalidated slots are written as `null` regardless of their schema type.
   *  CAUTION: the `null` must survive the HOST's reducer for that slot —
   *  list only replace-on-write slots as invalidation targets. A record-merge
   *  reducer (`{...prev, ...(next ?? {})}`) swallows the `null` at the graph
   *  boundary, so the slot resurrects on the next turn even though the
   *  in-batch view saw it cleared. */
  invalidatesOnChange?: Record<string, string[]>;
  /** Opt this read into uniform pagination. `true` self-paginates (executor
   *  returns the FULL set in `resultBody.items`; the runner slices + caches it
   *  in `pagedRead`, skipping the executor on a same-query re-page); `"delegate"`
   *  means the backend pages (executor reads the injected `page`/`pageSize`,
   *  returns the page in `resultBody.items` + `resultBody.totalCount`; the runner
   *  just wraps it). The object form tunes page size. The runner injects
   *  `page`/`pageSize` params and emits a uniform `{ page, pageSize, totalCount,
   *  totalPages, hasMore, items, fromCache }` envelope. Requires a `z.object`
   *  params schema. Omit for non-list reads. */
  pageable?: PageableSpec;
  /** Optional library-coordinated lifecycle hooks: confirmation gating, OTP
   *  issue/consume, flow open/close, double-entry capture/consume, and
   *  batch-isolation flags. Omit for plain reads and collection steps that
   *  don't participate in any controller-managed lifecycle. */
  controller?: ControllerHooks;
}

/** Per-mutation opt-in for state-driven confirmation gating. Truthy form
 *  switches the action into a two-mode runner (propose / execute) with a
 *  lockdown that refuses unrelated steps while pending and bounded re-proposes.
 *  Library injects a generic `abort_pending_input` action into the
 *  tool schema whenever any mutation opts in to a library-managed gate.
 *
 *  There is deliberately NO TTL: the runner times nothing out. Stale gates
 *  clear via `abort_pending_input` or via backend signals the executor
 *  surfaces as `clear_awaiting_input` / `abort_flow` effects. */
export interface ConfirmationOpts {
  maxAttempts?: number;
  lockdown?: boolean;
  /** Render what the runner ACTUALLY recorded, for the model to speak back to
   *  the caller verbatim. Called when a proposal is stored; a non-empty return
   *  rides on the proposal body as `read_back` beside `proposed_params`.
   *
   *  Why the library asks: it owns the capture half (capture.ts sanitizes,
   *  joins spoken digit groups and validates), so it alone knows the exact
   *  value. Handing the model raw `proposed_params` and leaving "tell the
   *  caller what was recorded" to its discretion is measurably where read-backs
   *  break — a model converting digits to words drops or doubles one on runs of
   *  equals, and the caller then confirms against wrong words, the one mistake
   *  a confirmation gate cannot catch. Whoever owns the capture owns reporting
   *  it back.
   *
   *  The library does NOT own the lexicon: rendering is language- and
   *  channel-specific, so the host supplies this function as configuration.
   *  Deliberately non-generic — `ConfirmationOpts` carries no state type today
   *  and threading one ripples through `ControllerHooks`/`ActionDef`; hosts cast
   *  their own state, exactly as executors do with their slices. */
  readBack?: (params: Record<string, unknown>, state: unknown) => string | undefined;
}

/** Per-action behavioural opts coordinated by the runner. Covers
 *  confirmation gating, OTP issue/consume, multi-turn flow lifecycle,
 *  double-entry capture/consume, and batch-isolation flags. Lives under
 *  `ActionDef.controller` — omit for plain reads / collection steps. */
export interface ControllerHooks {
  /** Refuse the batch if this action is mixed with any other step. Strict
   *  variant: applies regardless of confirm-mode state. Prefer
   *  `soleOnExecute` on confirm-required mutations so the LLM-natural
   *  "identify + verify + propose" batch still works. */
  soleStep?: boolean;
  /** Confirm-required-mutation friendly relaxation of `soleStep`:
   *  - When the action would resolve to EXECUTE mode (pending confirmation
   *    for this action with matching params), the batch must contain only
   *    this step — `mutation_must_be_sole_step`.
   *  - Otherwise (propose / re-propose / no pending), the action may ride
   *    alongside earlier steps but must be the LAST step in the batch —
   *    `mutation_must_be_last_in_batch` if not at the tail. This lets
   *    `[verify_customer, verify_card, change_status]` propose in one tool
   *    call while still keeping execute as a solo action.
   *  Mutually-exclusive with `soleStep` (if both are set, `soleStep` wins). */
  soleOnExecute?: boolean;
  /** Two-mode propose/execute gate for confirm-required mutations. */
  requiresConfirmation?: boolean | ConfirmationOpts;
  /** This action validates an OTP. The runner refuses it unless
   *  `awaitingInput.kind === "otp"` and `for_action` matches this action's
   *  name. The library never counts OTP attempts; the executor returns a
   *  `clear_awaiting_input` effect (drop the gate, keep the flow) or an
   *  `abort_flow` effect (terminal) based on the backend response. */
  requiresOtp?: boolean;
  /** This action issues an SCA challenge. The executor reports success via
   *  the `otp_issued` effect; the runner opens the OTP gate for the named
   *  consumer action. */
  issuesOtp?: { consumer_action: string };
  /** This action opens (or re-enters) a multi-turn flow. On `ok`, the
   *  runner creates `currentFlow` with the given `name` (or merges
   *  `merge_flow_data` into the existing flow if `currentFlow.name` matches).
   *  Refused if a different flow is currently active.
   *
   *  A flow persists across turns once opened and is cleared ONLY by `endsFlow`
   *  or an `abort_flow` effect — never implicitly. There is no "a new goal
   *  resets the flow" affordance: if a turn pursues an unrelated goal mid-flow,
   *  the prior flow (and its now-stale data) stays open until the host drives
   *  a reset — end the old flow before `startsFlow` of the new one. */
  startsFlow?: { name: string };
  /** This action terminates the active flow successfully. On `ok`, the
   *  runner clears `currentFlow` AND `awaitingInput`. */
  endsFlow?: boolean;
  /** Prereq: refuse with `wrong_flow` (or `no_flow_active`) if
   *  `currentFlow?.name` doesn't match this string. Cheaper to check than a
   *  full verifier; runs before any user-supplied prereqs. */
  requiresFlow?: string;
  /** This action is the *consumer* of a double-entry pattern: the customer
   *  provides a value (PIN, password, security answer) once, then again,
   *  and the system checks they match. The library refuses the action
   *  unless `awaitingInput.kind === "match"` and `for_action` matches.
   *  The executor runs normally — host owns the actual comparison and
   *  side-effect — and signals match/mismatch via its return:
   *  - `ok: true` → library treats as match, auto-clears `awaitingInput`.
   *  - `ok: false` + `resultBody.verdict === "match_mismatch"` → library
   *    decrements `attempts_left`; on exhaustion clears `awaitingInput` and
   *    aborts the flow. Otherwise leaves the awaiting slot alone so the
   *    customer can retry.
   *  - `ok: false` + any other verdict → library leaves state alone
   *    (unrelated failure, e.g. backend error). */
  requiresMatch?: { capturer: string; maxAttempts?: number };
  /** This action is the *capturer* of a double-entry pattern: it stores
   *  something (typically a tokenised form of the customer's first entry)
   *  for the consumer to compare against on the next turn. On `ok:true`,
   *  the library sets `awaitingInput.kind="match"` for the named consumer
   *  with `attempts_left = consumer.requiresMatch.maxAttempts`. Idempotent —
   *  re-running the capturer while a match is already awaiting just resets
   *  the attempts counter (and the host's stored token, via a
   *  `merge_flow_data` effect). */
  startsMatchFor?: { consumer_action: string };
}

export interface AgentStepConfig<ActionName extends string, PrereqName extends string> {
  tool: { name: string; description: string };
  actions: Record<ActionName, ActionDef<PrereqName>>;
}

export interface StepResult {
  action: string;
  ok: boolean;
  [key: string]: unknown;
}

export interface RunnerResultBody {
  summary: string;
  results: StepResult[];
  failed_at?: number;
}
