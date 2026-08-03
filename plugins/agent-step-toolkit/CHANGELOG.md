# agent-step library changelog

Version history for the **agent-step runner library** vendored by this toolkit. This tracks the
library only — NOT the plugin package version in `.claude-plugin/plugin.json`. The current version
ships in `skills/create-tool/templates/agent-step/VERSION` and travels into every bootstrapped
project at `src/agent-step/VERSION`.

Entries are written by `/bump-version` (newest first). Each breaking or behaviour-changing entry
links a migration guide under `migrations/` that `/pull-library` applies to downstream projects.

Format follows [Keep a Changelog](https://keepachangelog.com/). The library uses semver:
**major** = breaking public-API change (exports/signatures in `index.ts` / `types.ts`, or the
`buildAgentStepTool` options), **minor** = additive, **patch** = internal-only.

## [1.9.0] — 2026-08-03

Minor: one additive export and one runner behaviour fix, absorbed from a downstream agent that
simplified its graph from six nodes to three. `request_handoff` now abandons transient runner state
atomically, and `createTerminalHandoff` lets an executor write the handoff slot for outcomes it
established itself — together they remove the host-side "watch an outcome enum and force the
handback" graph node. No API removal or signature change. Suite grows 105 → 108. Ships alongside a
new authoring doctrine reference, `references/orchestration-boundaries.md`.
Migration: [migrations/1.8.1-to-1.9.0.md](migrations/1.8.1-to-1.9.0.md).

### Added
- **`createTerminalHandoff(namespace, outcomes)`** (exported from `handoff.ts` / `index.ts`) — builds
  a host's `outcome → { reason, context }` mapper for DETERMINISTIC business-terminal outcomes. The
  executor that established the outcome writes the `handoff` slot in the SAME `stateUpdate` as its
  domain outcome, so `handoffRequested` is true the moment the batch commits. The outcome table is
  typed against `HandoffRequest["reason"]`, so a host's mapping is checked at compile time and the
  returned `reason` stays literal per outcome; `context` is `` `${namespace}:${outcome}` `` — routing
  metadata for `resolveClosingMessage` to key on, never caller-audible text. Replaces two host-side
  patterns: trusting the model to issue a second `request_handoff` call (it forgets, and the caller
  dead-ends), and the graph node that watches an outcome enum to force the handback (it duplicates
  knowledge the executor already had).

### Fixed
- **`request_handoff` abandons transient runner state atomically.** The built-in action previously
  wrote only the `handoff` slot, leaving `awaitingInput`, `currentFlow` and `pagedRead` behind. A
  handoff abandons the active conversation path by definition, so a graph thread routed back later
  could resume work the customer had already walked away from — a pending confirmation being the
  dangerous case, since the runner locks every following step until it resolves. The action now
  patches `clearAllPatch()` + `pagedRead: null` together with the slot, in one state update. This is
  what makes a handoff safe from inside a pending gate: the clear and the slot write cannot be
  observed apart. The pending-gate test was rewritten to assert the clear, and a test that a handoff
  from a pending confirmation resolves exactly once was added.

### Changed
- `agent-step-api.md` no longer describes the built-in action as a "pure slot write" — it is a pure
  state *transition* (no I/O, but more than one slot). New § *Executor half (`createTerminalHandoff`)*.
- `templates/project/package.json.template` — `test:sandbox` / `test:prompt` used
  `[ -n "$F" ] && node --test $F || echo "…"`, so a FAILING suite fell through to the `echo` and the
  script exited 0. Any project that took these scripts unchanged reports green while failing.
  Rewritten as `if/then/else`, plus `rm -rf dist` on all three test scripts so a stale
  build cannot resurrect deleted tests. Not a library change; shipped here because the template is
  the source every project inherits.

## [1.8.1] — 2026-07-23

Patch: the auto-handoff error counter now treats **no-executor batches as NEUTRAL** — they neither
increment nor reset the consecutive-failure streak. Absorbed from a downstream agent that traced a
live simulated outage. No API surface change; no project-side transforms. Suite grows 103 → 105.
Migration: [migrations/1.8.0-to-1.8.1.md](migrations/1.8.0-to-1.8.1.md).

### Fixed
- **The failure streak survives confirm-gate proposals.** A confirm-gated action retried during a
  backend outage necessarily interleaves a proposal between every two failing executes (the failed
  execute consumes the pending confirmation, so the retry re-proposes). The proposal — a successful
  batch in which NO executor ran — reset the counter under the 1.8.0 rule: fail → 1, re-propose →
  0, fail → 1, … so the auto-handoff threshold was unreachable for EVERY confirm-gated action. The
  reset now requires that an executor **actually ran** in the batch (`anExecutorRan`, set before
  the call so a throw still counts): executed work is the only proof the backend recovered.
  Proposals/re-proposals, prereq denials, param-validation failures, `abort_pending_input`, and
  handoff signals are neutral — aligning the main loop with the early-return refusals (lockdown,
  batch shape), which already bypassed the counter. The increment side is unchanged.
  Behavior delta: hosts using confirm gates + `backendFailureCodes` now actually escalate at the
  threshold (previously never); a host that relied on a non-executed turn (e.g. `invalid_params`)
  wiping the streak will see it survive instead. `state.ts` `errorCount` doc-comment updated.

## [1.8.0] — 2026-07-23

Additive surface + four behavior fixes, absorbed from a downstream agent — all host-configurable,
no domain strings baked in. The confirmation gate now compares schema-NORMALIZED params (a
value-normalizing schema no longer makes confirmation impossible), `invalidatesOnChange` uses deep
value equality (no spurious cascades on fresh-but-equal object writes), EVERY runner-emitted
summary is now a host-overridable templated system message, and the auto-handoff instruction
defaults to platform-delivers wording. No API removal or signature change. Suite grows 94 → 103.
Migration: [migrations/1.7.2-to-1.8.0.md](migrations/1.7.2-to-1.8.0.md).

### Added
- **17 templated `SystemMessages` keys** — the lockdown refusals (`lockdown_confirmation` /
  `lockdown_otp` / `lockdown_match`), the batch-shape refusals (`handoff_must_be_sole_step`,
  `mutation_must_be_sole_step`, `mutation_execute_must_be_sole`, `mutation_must_be_last_in_batch`),
  the confirmation outcomes (`confirm_proposed` / `confirm_reproposed` / `confirm_exhausted`), the
  OTP/match gate refusals (`otp_not_pending`, `match_not_pending`, `otp_blocked_match_pending`,
  `match_attempts_exhausted`), `handoff_requested`, `no_steps`, and `auto_handoff_instruction` —
  with `{placeholder}` interpolation via a new `formatMessage` helper (`messages.ts`; unknown
  placeholders stay verbatim). Templates are plain strings, so overrides can live in JSON locale
  resources. English defaults preserve the previous hardcoded strings (except
  `auto_handoff_instruction`, below). Previously only 9 runner summaries were overridable; now all are.
- **`HandoffSpec.actionDescription`** — override the LLM-facing description of the auto-injected
  `request_handoff` schema variant, for hosts whose `resolveClosingMessage` composes every closing
  from state (the built-in text tells the model its `context` is SPOKEN — describe it truthfully
  instead, or the schema contradicts the host prompt).

### Changed
- **Confirm gate compares canonicalized PARSED params** — new `paramsMatchPending` parses the raw
  re-call with the action's effective schema before comparing against the stored (parsed) proposal;
  a failed parse counts as drift. The propose branch parses with the same schema (was the bare
  `paramsSchema`). Fixes a blocking defect: any value-normalizing schema (e.g. a `z.preprocess`
  stripping STT separators, `"70,76"` ≡ `"7076"`) made a confirmed re-call read as drift →
  re-propose loop → attempts exhausted without ever executing. Behavior delta: re-calls that
  normalize to the stored proposal now EXECUTE (previously re-proposed); no legitimate flow relied
  on the old behavior.
- **Propose-path `invalid_params` no longer leaks raw Zod text** — the summary is the overridable
  `invalid_params` system message; the raw detail moves to `_debug`, matching the execute path and
  the documented `_debug` convention.
- **`invalidatesOnChange` uses deep value equality** (canonicalized JSON) instead of `Object.is` —
  an executor writing a fresh-but-value-equal OBJECT no longer fires a spurious cascade. New
  `types.ts` caveat: invalidation targets must be replace-on-write slots (a record-merge reducer
  swallows the cascade's `null` at the graph boundary).
- **Auto-handoff instruction defaults to platform-delivers wording** — the synthetic `auto_handoff`
  result's summary no longer instructs the model to speak the closing (both taught wiring paths
  deliver it platform-side; "speak this exact message" invited double-speaking). A host whose graph
  does NOT deliver the closing overrides `auto_handoff_instruction` and uses the `{message}`
  placeholder to restore the old behavior.

## [1.7.2] — 2026-07-02

Patch: two runtime fixes aligning the runner with its documented contract, plus doc-comment
precision. No API surface change; no project-side transforms. Suite grows 91 → 94.
Migration: [migrations/1.7.1-to-1.7.2.md](migrations/1.7.1-to-1.7.2.md).

### Fixed
- **Delegate stream timer now starts after connect.** `runDelegate` created both timeout signals
  at entry, so a slow thread-creation call ate into the streaming budget (`timeoutMs` was
  documented as starting "once the run has started", but the timer ticked from delegate entry).
  The stream signal is now created only after the connect phase returns; `connectTimeoutMs` /
  `timeoutMs` doc-comments state the phase each timer actually covers. Two new handoff tests
  cover the connect-timeout fallback and the stream-timer start point.
- **Missing state schema now throws at construction.** `buildAgentStepTool` called with neither
  `stateSchema` nor the deprecated `stateAnnotation` threw only on the first tool call (inside
  `runSteps`), although 1.7.0 documented the failure as construction-time — and since 1.7.0 made
  both options optional in the type, nothing failed at startup. `validateConfig` now enforces it
  at construction; the `runSteps` guard remains for direct callers (test harnesses).
- **`errorCount` doc-comment matched to the runner** (`state.ts`): host-listed
  `backendFailureCodes` verdicts also increment the counter (not only `executor_error`), and it
  resets on any batch that does not end in a backend failure — not only on a "fully successful"
  one.

## [1.7.1] — 2026-06-30

Patch: corrects the recommended `AgentInputSchema` derivation so LangGraph Studio renders its chat
input box. The 1.7.0 recipe ran `.partial()` over the whole input schema, which strips the
`messages` channel metadata Studio keys off — Studio then fell back to the raw-state editor ("pass
new messages as state") instead of the message input box. No library code change (the vendored
runner is byte-identical to 1.7.0); the fix is in the toolkit's project-state template + references.
Absorbed from a downstream agent that hit the missing-chat-box symptom after migrating its graph
input to `AgentInputSchema`. Migration: [migrations/1.7.0-to-1.7.1.md](migrations/1.7.0-to-1.7.1.md).

### Changed
- **`AgentInputSchema` re-attaches `messages` after `.partial()`** —
  `AgentStateSchema.omit({...}).partial().extend({ messages: MessagesZodState.shape.messages })`.
  The caller-supplied identity fields stay optional, while `messages` keeps its native
  typed-and-required messages shape (with the channel metadata) so Studio renders the chat input box.
  `MessagesZodState` is already imported for `AgentStateSchema`, so no new import is needed.

## [1.7.0] — 2026-06-30

Additive: a **Zod state schema is now a first-class alternative to a LangGraph `Annotation.Root`**.
The runner derives its intra-batch merger from either form, so a project can define graph state
**once** in Zod — one source of truth for reducers AND validation — and gain invoke-boundary
validation/coercion via a derived input schema. Absorbed from a downstream agent that used it to fix
a Studio crash (a numeric `telephone_number` reaching `.startsWith` as a non-string) and to stop
internal slots being injected at invoke. No breaking change — `stateAnnotation` still works as a
deprecated alias. Suite grows 89 → 91. The toolkit's templates + references now teach **only** the
single Zod-schema pattern. Migration: [migrations/1.6.0-to-1.7.0.md](migrations/1.6.0-to-1.7.0.md).

### Added
- **`stateSchema` option** on `buildAgentStepTool` (`BuildAgentStepToolOptions.stateSchema:
  StateSchemaLike`) — accepts a LangGraph `Annotation.Root` OR a Zod object whose fields carry
  reducer/default metadata via `withLangGraph` (`@langchain/langgraph/zod`). Both resolve to the same
  channel classes, so the merger reads `.operator` off either uniformly (a Zod schema's channels are
  resolved through the langgraph zod registry).
- **`StateSchemaLike`** type and **`agentStepInternalSlotMask`** const exported from `index.ts`. The
  mask is a Zod `.omit()` mask of the five library-managed slot keys (`awaitingInput`, `currentFlow`,
  `pagedRead`, `handoff`, `errorCount`) for deriving a graph INPUT schema that callers can't use to
  inject internal slots.
- **`zod-state.test.ts`** — isolation test proving the merger derives reducers off a Zod schema
  (first-wins vs `LastValue`) exactly as off an `Annotation.Root`.

### Changed
- **`agentStepZodShape` slots are now `withLangGraph`-wrapped** — spreading the fragment into a Zod
  state schema now carries each library slot's real last-writer-wins reducer + default as channel
  metadata (previously the Zod fragment was `.nullable().optional().default(null)`, i.e. `LastValue`
  with no registered reducer). The channel default rides the meta `default`, and fields stay plain
  `.nullable()` (a `withLangGraph` requirement).

### Deprecated
- **`stateAnnotation`** is now a deprecated alias of `stateSchema` (still accepted; the runner reads
  whichever is set). The runner throws at construction if neither is provided. New code uses
  `stateSchema`.

## [1.6.0] — 2026-06-26

Additive: an **auto-handoff safety net** — the runner counts consecutive backend failures and
auto-triggers a handoff at a threshold, so a customer is never trapped in an error loop. Plus a
**silent off_topic hand-back** and **split delegate timeouts**. Reconciled from multiple downstream
agents that had each grown the feature with hard-coded, project-specific failure codes; the library
version is **host-configurable** (no domain codes baked in). No
breaking change. Suite grows 83 → 89.
Migration: [migrations/1.5.0-to-1.6.0.md](migrations/1.5.0-to-1.6.0.md).

### Added
- **Auto-handoff** (`agent-step-api.md` `<auto_handoff>`): new library-managed `errorCount` slot
  plus three `BuildAgentStepToolOptions` — `backendFailureCodes?: string[]` (host verdicts that
  count as a backend failure; the runner-raised `executor_error` always counts),
  `errorHandoffThreshold?: number` (default 3), and `onErrorThreshold?(update, state)` (host hook
  to inject a custom handoff signal). At the threshold the runner writes the library `handoff` slot
  (`reason: "abandon"`) and/or calls the hook, resets the counter, and appends a synthetic
  `auto_handoff` step result. **Inert** unless a handoff path (the `handoff` opt or
  `onErrorThreshold`) is configured.
- `SystemMessages.auto_handoff` — the spoken line at the threshold (neutral English default;
  override via `messages`).
- `HandoffDelegateTarget.connectTimeoutMs` — separate connect-phase timeout for delegate runs.

### Changed
- **off_topic hand-back is now silent**: `createHandoffNode` emits empty spoken content
  (`success_message: ""`) for `off_topic` instead of `terminateMessage` — a topic change is an
  agent-to-agent re-route the destination agent narrates. `terminateMessage` is now only the
  delegate-FAILURE fallback. `completed` / `abandon` are unchanged.
- Delegate timeouts split: connect phase defaults to 10s (`connectTimeoutMs`), streaming phase to
  20s (`timeoutMs`, was a single 60s).

## [1.5.0] — 2026-06-26

Additive surface + two flow-control hardenings, absorbed from a downstream project. Host-overridable
runner system messages (new `messages.ts`), an honesty hook for handback closings, and stricter
double-entry / OTP ordering so a single batch can't bypass the second PIN entry. No breaking change;
the new APIs are opt-in and the guards only refuse batch shapes that were never safe. Suite grows
79 → 83. Migration: [migrations/1.4.0-to-1.5.0.md](migrations/1.4.0-to-1.5.0.md).

### Added
- **`messages.ts`** (new library file): `SystemMessages`, `DEFAULT_SYSTEM_MESSAGES` (neutral English),
  `resolveSystemMessages()` — all exported from `index.ts`. The runner's own refusal/error `summary`
  strings (executor crash, invalid params, unknown action, abort, flow gates) are now overridable via
  `buildAgentStepTool({ messages })` (`Partial<SystemMessages>`, shallow-merged). The library imports
  no host strings; a localized / voice-safe agent injects its wording.
- **`_debug`** field on `executor_error` / `invalid_params` step results — carries the raw technical
  cause so the (overridable, user-safe) `summary` no longer has to leak it.
- **`HandoffSpec.resolveClosingMessage?(state, request)`** — override the `completed` / `abandon`
  closing line from actual operation outcomes (honesty invariant: speak success only when state proves
  it persisted). Returns a string to replace `request.context`, or `undefined` to fall through.
  Never called for `off_topic`.

### Changed
- **Double-entry match is frozen to batch start.** A `requiresMatch` consumer is gated on the
  awaiting-input snapshot at batch start, so a capturer + its consumer in ONE batch is refused
  (`match_not_pending`) — the repeat must arrive in a separate turn (mirrors the confirmation
  same-batch-bypass guard). The `[consumer, issuer]` batch is unaffected.
- **Match-then-OTP ordering guard.** An `issuesOtp` step is refused with `otp_blocked_match_pending`
  (pre-execution, before the SCA backend is called) while a double-entry match gate is still pending,
  so `[capturer, issuer]` can no longer mint+send an OTP that overwrites the unconsumed match gate.

## [1.4.0] — 2026-06-12

Additive: the built-in `request_handoff` now covers the **full handback signal set** —
`HandoffRequest.reason` widens to `off_topic | completed | abandon` (`context` is per-reason:
the customer's request for `off_topic`; the **LLM-composed closing line** for `completed` /
`abandon`, which the resolver node delivers verbatim as the final reply — it may reference
what was done, matching the middleware's passive handback semantics: reply delivered, routing
flips for the next request). `completed` / `abandon` are terminate-only by nature (never
delegated); `off_topic` keeps the fixed envelope / delegate run. `HANDBACK_SIGNALS` extends
(identity, canonical lowercase). `context` now requires `min(1)`. Suite grows 76 → 79.
Migration: [migrations/1.3.1-to-1.4.0.md](migrations/1.3.1-to-1.4.0.md).

### Added
- `HandoffRequest.reason`: `"completed"` / `"abandon"` accepted alongside `"off_topic"`;
  `HANDBACK_SIGNALS` maps all three (identity).
- Resolver: `completed` / `abandon` speak `request.context` (LLM-composed closing) with their
  signal in `handoff_type`; the action description teaches all three reasons.

## [1.3.1] — 2026-06-12

Fix: the handback signal emitted as `handoff_type` by `createHandoffNode` (terminate mode /
delegate-failure fallback) is now the middleware's canonical lowercase vocabulary —
`HANDBACK_SIGNALS.off_topic` emits `"off_topic"` instead of `"OFF_TOPIC"`. Behaviorally
compatible either way (the middleware matches handoff types case-insensitively, verified
against its handoff-processor source), but the library now emits the exact canonical
strings. No API-surface change. Migration:
[migrations/1.3.0-to-1.3.1.md](migrations/1.3.0-to-1.3.1.md).

### Fixed
- `HANDBACK_SIGNALS` values lowercased to the middleware's canonical vocabulary (identity
  mapping today: `off_topic` → `"off_topic"`); `handoff_metadata.service_type` follows.

## [1.3.0] — 2026-06-12

Additive: **library-coordinated channel handoff** for specialized agents. Opt in via
`buildAgentStepTool({ handoff: spec })` — the runner auto-injects the reserved
`request_handoff` action (sole-step, no prereqs, lockdown-bypassing; pure write of the new
library-managed `handoff` slot), and the host graph resolves it with `createHandoffNode(spec)`
behind a `handoffRequested` conditional edge: **terminate** mode emits the OFF_TOPIC handback
`additional_kwargs` with the envelope as `success_message`; **delegate** mode calls another
LangGraph deployment over the Platform API (fetch+SSE, `replyNode` token filtering for voice,
behavioral fallback to the envelope) and KEEPS the conversation — its final message is not a
handoff (informational `delegated_to` only). Control-plane custom events (`handoff`,
`delegated_token`, `handoff_complete`, `delegated_restart`) for streaming clients
(`stream_mode: ["messages-tuple", "custom"]`). Hosts spreading
`agentStepStateSpec` / `agentStepZodShape` get the `handoff` slot for free. Test suite grows
65 → 76. Migration: [migrations/1.2.0-to-1.3.0.md](migrations/1.2.0-to-1.3.0.md).

### Added
- `handoff.ts` + `handoff.test.ts` — `HandoffSpec` / `HandoffOffTopicSpec` /
  `HandoffDelegateTarget`, `createHandoffNode`, `handoffRequested`, `HANDOFF_ACTION`,
  `HANDOFF_NODE`, `HANDOFF_ACTION_DESCRIPTION`, `handoffParamsSchema`, `HANDBACK_SIGNALS`
  (reason → `handoff_type` signal; `off_topic` → `"OFF_TOPIC"`, the extension point for
  `completed` / `abandon`).
- `BuildAgentStepToolOptions.handoff?` (optional) — auto-injects `request_handoff`; the name
  is reserved ONLY while the opt is provided (a tool without the opt may define its own
  `request_handoff` action — the orchestrator/scaffold mechanism does). Batches containing
  the built-in plus anything else are refused whole with
  `error: "handoff_must_be_sole_step"`.
- Library-managed `handoff: HandoffRequest | null` slot — `HandoffRequestSchema` exported,
  included in `agentStepStateSpec` / `agentStepZodShape` / `LibraryManagedSlots`.

## [1.2.0] — 2026-06-11

Additive: `PagedCacheSchema` is now re-exported from `index.ts`, completing the library-managed
slot-schema trio (`AwaitingInputSchema` / `CurrentFlowSchema` were already exported; the paged-read
schema was exported from `state.ts` but missing from the barrel). Hosts that spread
`agentStepStateSpec` / `agentStepZodShape` are unaffected; hosts that hand-rolled a `PagedCache`
Zod schema can now import the real one. Migration:
[migrations/1.1.1-to-1.2.0.md](migrations/1.1.1-to-1.2.0.md).

### Added
- `PagedCacheSchema` re-exported from `index.ts` (no new symbol — `state.ts` already exported it;
  the barrel omission made it unreachable for consumers importing from `./agent-step/index.js`).

## [1.1.1] — 2026-06-09

Internal: doc-comment corrections only — no behavior, signature, or export change. Surfaced by a
contract audit comparing the library's documented guarantees against live runtime behavior across
several consumers. Migration: [migrations/1.1.0-to-1.1.1.md](migrations/1.1.0-to-1.1.1.md) (no
consumer transforms — the refreshed doc-comments are the whole upgrade).

### Fixed
- `runner.ts` header referenced a non-existent `cancel_pending_confirmation` action — corrected to
  the actual reserved action `abort_pending_input`.
- `ConfirmationOpts.ttlMs` is now documented as **INERT** (accepted for forward-compat, never read;
  the runner times nothing out) in `types.ts`, and the `CONFIRMATION_DEFAULTS.ttlMs` value is marked
  unused in `runner.ts` — aligning the type doc-comment with the runner and the `agent-step-api.md`
  reference, which already flagged it inert.

### Changed (documentation)
- `ExecutorResult.ok` is now documented as a **batch-continuation control flag, not a
  success/verdict signal** — `ok: true` for a "negative" outcome (verdict in `resultBody`) is valid
  when later steps should still run. Reconciled the apparent Pattern 1 vs Pattern 2 conflict in
  `executor-patterns.md`.
- `startsFlow` doc now states that a flow persists across turns and is cleared only by
  `endsFlow`/`abortFlow` — there is no implicit reset on a goal-switch; the host must drive it.

## [1.1.0] — 2026-06-08

Additive: native read-pagination. Opt a list read into uniform pagination with `pageable` on its
action; the runner injects `page`/`pageSize` params, returns a standard
`{ page, pageSize, totalCount, totalPages, hasMore, items, fromCache }` envelope, and (self mode)
caches the full set in the new library-managed `pagedRead` slot so a same-query re-page skips the
executor. Opt-in — existing tools are unaffected. Migration: [migrations/1.0.0-to-1.1.0.md](migrations/1.0.0-to-1.1.0.md).

### Added
- `paginate.ts` (new library file): `PageableSpec` / `PageEnvelope` / `PagedCache` types +
  `DEFAULT_PAGE_SIZE`, `MAX_PAGE_SIZE`, `clampPageSize`, `querySignature`, `pageRows`,
  `buildPageEnvelope`. Exported from `index.ts`.
- `ActionDef.pageable?: PageableSpec` — `true` (self-paginate), `"delegate"` (backend pages), or
  `{ mode, pageSize?, maxPageSize? }`.
- Library-managed `pagedRead` state slot (`PagedCacheSchema`; added to `agentStepStateSpec` +
  `agentStepZodShape`).

### Changed
- New construction-time check: a `pageable` action's `paramsSchema` must be a `z.object` (the runner
  merges `page`/`pageSize` into it).
- `package.json` `test` script broadened to `dist/agent-step/*.test.js` (runs the new `paginate.test.js`
  alongside `runner.test.js`).

## [1.0.0] — 2026-06-05

Breaking: per-action **state selectors**. The runner now projects the host state down
to a per-action slice before calling the executor, so executors receive only what they
need — not the whole state. Migration: [migrations/0.1.0-to-1.0.0.md](migrations/0.1.0-to-1.0.0.md).

### Breaking
- `buildAgentStepTool` / `runSteps` require a new `selectors` registry — one `Selector` per
  action, keyed by action name. New signature:
  `buildAgentStepTool({ config, stateAnnotation, selectors, executors, verifiers })`.
- Selectors and the `executors` registry are now keyed by the **exact action name** (snake_case).
  The snake-to-camel executor-key convention is gone (`toExecutorKey` removed); the runner now
  dispatches `executors[action](params, selectors[action](view))`.
- `Executor<T>` → `Executor<Slice, T>` — the executor's `state` param is the selector's return,
  not the whole state. `ExecutorRegistry<T>` → `ExecutorRegistry<T, Selectors>`, per-action typed
  from each selector's return so a mismatch is a compile error at the construction boundary.

### Added
- `Selector<T>` and `SelectorRegistry<T, ActionName>` exports.

### Changed
- Executor throws are now caught by the runner and surfaced as an `ok:false` step
  (`error: "executor_error"`) instead of escaping `runSteps`; earlier steps' commits are preserved.
- Removed the inert `proposedAt` timestamp from pending confirmations (TTL was already removed).

## [0.1.0] — baseline

Initial embedded library. No migration guide (nothing precedes it).

- `buildAgentStepTool({ config, stateAnnotation, executors, verifiers })`, `runSteps`, `defineConfig`.
- Executor signature `Executor<T> = (params, state: T) => Promise<ExecutorResult<T>>` — executor
  receives the whole state.
- Lifecycle: confirmation propose/execute, OTP issue/consume, double-entry match, multi-turn flow,
  batch-isolation (`soleStep` / `soleOnExecute`), `invalidatesOnChange`.
