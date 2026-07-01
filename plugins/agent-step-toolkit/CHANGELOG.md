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
