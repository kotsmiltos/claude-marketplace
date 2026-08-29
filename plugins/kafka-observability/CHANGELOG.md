# observability library — CHANGELOG

The version here is the **vendored library** version (`templates/observability/VERSION`),
independent of the plugin version in `.claude-plugin/plugin.json`. Downstream projects
carry a copy of this library in `src/observability/`; `/add-kafka-observability` compares
their `src/observability/VERSION` against the shipped one and upgrades via the
version-keyed guides in `migrations/`.

## 1.8.0 (2026-08-28)

Parity release: **spoken digit runs now follow the numeral pass's length rule**. 1.7.0
masked every qualifying word run whole, on the claim that "word-form values are always
secret-bearing, never correlation identifiers" — wrong the moment a caller dictates a card
number or a tax id, which they do: the same dictation typed as numerals keeps `***4410` /
`***6789` (the tail the flow itself reads back), while the spoken form lost it entirely,
purely because the caller spoke instead of typing. The length boundary that already
separates these shapes in the numeral pass separates them identically in word form —
7+ digits is a dictated identifier (card 16, ΑΦΜ 9), 3–6 is a secret (PIN 4, OTP 6).

### Added

- `keepLast` (default **4**) / `keepLastMinRun` (default **7**) on
  `SpokenDigitMaskOptions` — mirroring `maskDigitsInText`'s options and defaults. A run of
  `keepLastMinRun`+ digits collapses whole (separators included) to `***<last keepLast
  digits>` with kept words **translated to numerals** («…τέσσερα τέσσερα ένα μηδέν» →
  `***4410`); the language packs now map word → digit to make that possible. Runs of 3–6
  digits are masked exactly as in 1.7.0 — PIN and OTP output is byte-identical. `keepLast:
  0` masks every run whole (the 1.7.0 behaviour, now the opt-out).
- Tail safety rule: the tail is the REAL last digits or absent, never partial — if any of
  the last `keepLast` digits is unrecoverable (a `#` token left by a prior digit pass in a
  mixed run), the run is masked whole instead of emitting a half-real tail.
- `digitContentMask({ spokenLanguages })` now shares `keepLast`/`keepLastMinRun` (and
  `maskChar`, as before) between both passes — `keepLast: 0` blankets numeral and spoken
  runs alike, and a spoken and a typed card mask to the SAME `***4410`.
- Tests: 12 new (suite 194 → **206**) — 16-word card and 9-word ΑΦΜ collapse with
  translated tails (Greek incl. inflected/accentless/uppercase variants in the tail,
  English incl. oh→0), the 7-digit threshold in both directions (the 6-word OTP still
  masks whole), numeral digits contributing to a tail, separator collapse, `keepLast: 0`
  and `keepLastMinRun` options, the never-partial-tail fallback, and spoken/typed parity
  through `digitContentMask`.

### Changed

- **Default behaviour change for wired spoken masking, stated plainly:** a policy wired on
  1.7.0 masked a 7+-word dictated run whole; on 1.8.0 the same run keeps a translated
  `***<last4>` tail unless `keepLast: 0` is passed. PIN/OTP-shaped runs (3–6 digits) are
  unaffected. Anything NOT wired is untouched — with no policy (or no `spokenLanguages`/
  manual spoken pass), emitted bytes remain identical to 1.6.0, same guard tests as 1.7.0.
- Doc-comment idempotency note now mirrors `maskDigitsInText`'s: idempotent with
  `keepLast: 0`; the default keep-tail policy leaves a numeral tail a LATER digit pass
  would re-mask — the documented composition runs the digit pass first, so the tail
  survives there.
- No export removed or changed, no env key, event schema untouched.

## 1.7.0 (2026-08-26)

Privacy release: **masking of digits spoken as words**. The 1.6.0 seam works — a live
Kafka capture of a downstream voice-banking agent's full PIN-change conversation showed
zero plaintext PIN/OTP numerals once its domain masker was composed with
`maskDigitsInText` — but the callers speak, and on a voice channel word-form is how digits
normally arrive: the same capture carried the PIN as «τέσσερα οκτώ τρία επτά» (59
occurrences) and the OTP as «ένα δύο τρία τέσσερα πέντε έξι» (135 occurrences) inside
llm-run content, the limit the 1.5.0→1.6.0 guide had named ("numbers spoken as words are
not numerals"). English word digits ("four eight three seven") leak identically. This is a
language-shaped but domain-independent text transform — the same class of primitive as
`maskDigitsInText` — so per the library's own doctrine (primitives in the library, policy
with the application) it ships here rather than being copy-pasted into every agent repo.

### Added

- `maskSpokenDigitsInText(text, opts?)` in `content-mask.ts` — masks runs of consecutive
  spoken digit words. Pluggable language packs, Greek and English built in
  (`languages` option takes a subset; default both): Greek covers digit words 0–9 with the
  spoken variants and inflections ASR emits (μηδέν, ένα/μία/μια, δύο/δυο, τρία/τρεις,
  τέσσερα/τέσσερις, πέντε, έξι, επτά/εφτά, οκτώ/οχτώ, εννέα/εννιά), matched
  case-insensitively and accent-tolerantly (uppercase «ΤΕΣΣΕΡΑ» and accentless «τεσσερα»
  both hit — normalization is lowercase + NFD accent strip + final-sigma fold); English is
  zero/oh/one…nine. The rule: consecutive digit-words joined by spaces, commas or dashes
  are one run; numerals and already-masked `#` tokens inside it COUNT as run members (so
  mixed dictation «τέσσερα 8 τρία επτά» — and its digits-first-composed form
  «τέσσερα # τρία επτά» — stays one run instead of two leaking fragments); a run is masked
  only at `minRun` (default **3**) or more members with at least one actual digit word, so
  a lone «ένα» («θέλω ένα νέο PIN») or a pair («δύο τρία λεπτά») survives as prose while
  the PIN (4) and OTP (6) shapes are always caught. One `maskChar` per word,
  digit-for-digit for embedded numerals, **no keepLast tail** — word-form values are always
  secret-bearing (PINs, OTPs), never correlation identifiers a flow reads back. Idempotent.
  Numeral-only runs are untouched (`maskDigitsInText`'s job). Types `SpokenDigitLanguage` /
  `SpokenDigitMaskOptions`; new `index.ts` re-exports for all three.
- `digitContentMask({ spokenLanguages: ["el", "en"] })` — opt-in composition inside the
  ready-made policy: numeral pass FIRST, then the spoken pass with the same `maskChar`
  (order is load-bearing — see the run-member rule above). Omitted, the policy is
  byte-identical to 1.6.0.
- README: the manual composition for projects with their own domain masker —
  `(v) => redactValue(mapStringsDeep(v, (s) => maskSpokenDigitsInText(maskDigitsInText(s)), { keys: true }))`
  — and both ORDER rules stated (digit pass inside the key tiers; numeral pass before the
  spoken pass). Limits updated: the "numbers spoken as words" limit is now scoped to what
  actually remains — composed number words above nine («σαράντα οκτώ», "forty-eight") and
  languages without a pack.
- Tests: 36 new (suite 158 → **194**) — Greek inflected/accentless/uppercase forms, mixed
  separators, the minRun boundary in both directions, the lone-digit-word prose guard,
  English runs, mixed numeral+word runs and the digits-first composition, idempotency, a
  realistic Greek utterance carrying a 4-word PIN and a 6-word OTP fully masked while the
  surrounding sentence (and its prose «ένα») survives, and an emitter-level regression
  guard pinning `digitContentMask()` without `spokenLanguages` to 1.6.0 output.

### Changed

- Nothing breaking; no export removed or changed, no env key (language selection is a code
  option, not configuration), event schema untouched, and the `events[].name`/
  `events[].time` carve-out stays. **With nothing new wired, emitted bytes are identical
  to 1.6.0** — the no-mask default was untouched and the new emitter regression test pins
  the spoken words verbatim in a 1.6.0-style policy's output.

## 1.6.0 (2026-08-20)

Privacy release: a **host-supplied content mask**. Every traced run carried the
conversation verbatim — prompts, completions, graph state, tool params — and the only
masking the library did was credential redaction, so caller-dictated card numbers, tax
ids, PINs and OTPs reached a durable, indexed sink untouched. The first design put a digit
policy in the library; it was wrong, and the library's own `traceBackendCall` contract
already said why ("no notion of the domain's PII"): every length or key rule is a guess
about someone else's flow, and the guesses fail on real payloads — a "mask short runs,
pass long ones" rule ships a full 16-digit PAN, which is exactly what a card flow keeps in
graph state. So this release ships the **seam and the building blocks, not the policy**,
extending to all runs the division backend-call runs already used.

### Added

- `content-mask.ts` — the seam and its primitives. `ContentMask` /
  `ContentField` types; `applyContentMask(data, mask)` (the field-scoping helper the
  emitter uses); `maskDigitsInText(text, opts?)` (runs of 7+ digits → `***<last4>`,
  shorter runs → one `#` per digit, single space/dash CONTINUES a run so voice dictation
  reads as one number, Unicode `\p{Nd}` not `\d`, options `maskChar`/`keepLast`/
  `keepLastMinRun`); `mapStringsDeep(value, fn, { keys? })` (strings only — numbers stay
  numbers so token analytics survive; `keys: true` also masks OBJECT KEYS, which is the
  only thing that reaches a slot keyed BY the sensitive value); `digitContentMask(opts?)`
  (the two composed, ready-made but never installed).
- `startup({ contentMask })` — `StartupOptions`, an object so future seams need no further
  signature change. `RunEventEmitter` takes the policy as a defaulted 4th constructor
  argument. The startup line now always reports `content_mask=host|off` — logged even when
  off, unlike the run filter, because an operator needs to see that nothing is masking.
- `content-mask.test.ts` — 36 tests in 7 groups, including a realistic captured chain-run event
  (LangChain message envelopes, a PAN-keyed state slot, usage counters, a streaming token)
  asserting content is masked while `run_id` / `trace_id` / `dotted_order` / the timeline /
  `metadata` / `serialized` / numeric usage counters survive byte-for-byte. Suite:
  114 → 158 (with 5 `event-emitter.test.ts` and 3 `index.test.ts` additions).
- New `index.ts` re-exports: `applyContentMask`, `digitContentMask`, `mapStringsDeep`,
  `maskDigitsInText`, and the `ContentField` / `ContentMask` / `DigitMaskOptions` /
  `DigitContentMaskOptions` / `StartupOptions` types.
- README: "Content masking (opt-in, host-supplied)" — the wiring, the in/out-of-scope
  table, the composition rule for projects that already own a domain masker (digit pass
  INSIDE the key-based one, because key tiers trim tails and the digit pass preserves
  them), and the limits stated plainly (words-not-numerals, non-numeric PII, the four real
  digits `keepLast: 4` leaves behind, `metadata` being out of scope).

### Changed

- `emitRun`'s pipeline gains one step: project → validate → redact → **mask** → serialize
  → truncate → produce. Credential redaction still runs first, so the library's own
  contract stays primary. The existing `ObservabilityEventSchema.parse` after it now also
  guards host policies — one that returns the wrong shape for a content field drops the
  event with a logged error instead of writing a malformed document to the sink.
- `events[].name` and `events[].time` are carved out of the masked scope: the library
  builds that array itself (`sanitizeRunEvents` → `{name, time, kwargs}`), so they are
  machine-generated timeline data in the same category as `start_time`/`end_time`, in
  scope only by accident of nesting. Only each entry's `kwargs` reaches the mask. Caught
  in test: a digit policy had been shredding every token timestamp into `##:##:##`, taking
  inter-token latency analysis with it — the same class of carve-out as
  `USAGE_KEY_PATTERN` in `redaction.ts`.
- Nothing breaking; no env keys added. Masking is code, not configuration, because a
  policy is a function. **With no policy wired, emitted bytes are identical to 1.5.0** —
  verified by a regression test asserting the omitted-argument payload.

## 1.5.0 (2026-08-11)

Coverage release: opt-in **backend HTTP call tracing**. Outgoing backend calls were the
one run kind the tracer could not see — traced to stdout only, which rotates away in
QA/PROD, so an after-the-fact investigation had the LLM and node runs of a conversation
but no record of what was sent to the backends or what came back. Absorbed from a
downstream agent that built and verified the module at the project layer
(set-pin-agents-ts plan-012).

### Added

- `backend-trace.ts` — `traceBackendCall` executes a backend HTTP call as a traced child
  run: name `http:<endpoint>`, tag `backend-http`, metadata `backend_endpoint` /
  `backend_base_url` / `backend_envelope` / `backend_attempt` / `backend_max_attempts` /
  `backend_retryable`. Nests under the issuing node/tool run via LangChain's
  AsyncLocalStorage callback inheritance (installs `@langchain/core/context` explicitly —
  load-bearing side-effect import), so no `RunnableConfig` threading and no executor
  signature change. The `{result, logged}` split returns the REAL response to the caller
  while recording only the caller-masked view. `withAttemptContext` / `currentAttempt`
  make a silent retry visible as one run per attempt.
- `backend-trace.test.ts` — 5 tests through the real emitter/tracer path (pair emission +
  nesting + metadata, byte-level leak check on the masked/real split, error recording,
  per-attempt runs, attempt-context scoping). Suite: 109 → 114.
- New `index.ts` re-exports: `traceBackendCall`, `withAttemptContext`, `currentAttempt`,
  `TracedCallInfo`, `TracedCallOutcome`.
- README: "Backend HTTP call tracing" section (chokepoint pattern, retry visibility, and
  the pre-masking security contract — library redaction stays credential-only; domain
  masking is the caller's job, and these events land in a durable indexed sink).

### Changed

- Nothing breaking; no env keys, no event-schema change. Nothing is traced until project
  code calls the helper — without adoption, emitted bytes are identical to 1.4.1.

Migration: [migrations/1.4.1-to-1.5.0.md](migrations/1.4.1-to-1.5.0.md) (no mandatory
transforms; conditional swap for projects with a pre-1.5.0 hand-rolled module).

## 1.4.1 (2026-08-09)

Documentation-only. No behaviour, no exports, no env keys, no event-shape change — a project
on 1.4.0 gains nothing functional by upgrading, and nothing breaks if it does.

The version moves anyway because the marker's only job is identity: comments, a test fixture
and the in-library README had been reworded in place while `VERSION` stayed at 1.4.0, so the
shipped 1.4.0 and a downstream 1.4.0 were no longer the same bytes. This restores that.

- `event-emitter.ts`, `schemas.ts` — comment wording generalized (no code touched).
- `kafka-producer.test.ts` — client-id fixture is a generic sample name.
- `redaction.test.ts` — one `describe` label states the finding without the QA thread id.
- `README.md` — `APPLICATION_NAME` example and the event-envelope example use a generic
  service name.

Suite unchanged at 109.
Migration: [migrations/1.4.0-to-1.4.1.md](migrations/1.4.0-to-1.4.1.md) (no action required).

## 1.4.0 (2026-08-07)

Redaction-precision release, closing a real information-loss bug found by a downstream
consumer of the event stream during 1.3.0 QA verification (400+ over-redacted fields
across 20 events): the sensitive-key pattern's `token` substring also matched every
LLM usage counter LangChain emits — `tokenUsage`, `prompt_tokens`, `completion_tokens`,
`input/output_tokens`, the `*_token(s)_details` objects — masking them all to
`***REDACTED***` and making cost/usage analytics impossible from the pipeline.

Two surgical carve-outs in `redaction.ts`; the credential key pattern itself is untouched
(deliberately NOT tightened — an under-match there would leak a real credential):

- **Scalar type guard** — a number, boolean, or null value is never masked, whatever its
  key: only strings can BE a credential and only objects/arrays can contain one. This
  alone un-redacts every numeric counter, including provider-specific ones inside details
  objects (`cached_tokens`, `reasoning_tokens`, `audio_tokens`, camelCase `promptTokens`)
  and future counters not yet on any list. Consequence: `password: null` now passes as
  null (was masked — carried no information either way).
- **Usage-container exemption** — an anchored allowlist
  (`(prompt|completion|input|output|total)_tokens?(_details)?`, `(estimated_)?token_?usage`
  / `tokenUsage`, `usage(_metadata)?`) recurses into these objects instead of masking them
  whole. Deliberately NOT a generic `_tokens?$` suffix rule, which would also exempt
  `access_token`-style credentials. Contents still pass through full redaction — a string
  secret inside a usage object stays masked.

Unchanged, fail-safe: sensitive-keyed strings stay masked; any other sensitive-keyed
object/array is still masked whole (`credentials: {…}` never leaks unmatched inner keys);
`password=` fragment masking in string values unchanged. Streaming `new_token`
`kwargs.token` chunks stay masked (string under key `token`) — redundant rather than
harmful, the full content survives in `outputs`; dropping those entries outright would be
a separate, deliberate behavior change this release does not make.

- **`redaction.test.ts`** — pins both directions: OpenAI/LangChain/Anthropic-shaped usage
  payloads survive verbatim (incl. details objects and camelCase counters) while
  `api_key`, `Authorization`, `access_token`, `refresh_token`, `client_secret`, `token`
  (string), `connection_string`, and whole credential objects stay masked; a string
  secret inside `tokenUsage` is still caught; two pre-1.4.0 pins updated as documented
  behavior changes (numeric under sensitive-substring key, `password: null`).

## 1.3.0 (2026-08-06)

Event-volume release: **opt-in run filtering**. By default the tracer emits a
request/response pair for every traced run (full LangSmith parity — unchanged). Payload
verification on one downstream agent showed ~73% of a real turn's events carry zero
unique content: LangGraph's `__start__` pseudo-node echoes the root inputs, auto-generated
conditional-edge `RunnableLambda` wrappers carry only the routing decision, and thin
wrapper nodes (`agent`, `tools`) rewrap their single nested llm/tool run's output
byte-identically. A survey of several other agents
confirmed the wrapper≈child duplication does **not** generalize — several of their nodes
transform outputs or have no nested run at all — so name-based filtering is strictly a
per-app, payload-verified opt-in, never a default.

Additive: no event-schema, transport, or wiring change; two new **optional** env vars.
With filtering off (default) emitted bytes are identical to 1.2.0.

- **`run-filter.ts`** (new) — `RunFilter`: allowlist/denylist over `run_type:name`
  `*`-glob patterns, where the name side matches the run name OR
  `metadata.langgraph_node` (the run_type side prevents `chain:agent` from also dropping
  the nested llm run, which inherits the wrapper's langgraph_node). **The root run always
  survives, in both modes** — it is the sole carrier of the full invocation input/final
  state and the only event without `langgraph_node`, the turn-boundary marker for
  timeline consumers. Filtering drops a run's request+response pair atomically (the
  predicate reads only fields stable across the run's lifetime) and never re-parents:
  surviving events' `parent_run_id`/`dotted_order` may reference dropped runs.
- **`KAFKA_RUN_FILTER_MODE`** / **`KAFKA_RUN_FILTER_PATTERNS`** (new optional env vars) —
  `off` (default) | `allow` | `deny`, plus comma-separated patterns. Fail-fast at startup
  on an invalid mode, a mode without patterns, or patterns while the mode is off
  (no-config-fallback rule). When active, startup logs one greppable line:
  `[observability] run filter active: mode=… patterns=… (root run always emitted)`.
- **`run-tracer.ts`** — `safeEmit` consults the filter (registry-resolved, like the
  emitter; `filter` test seam on `KafkaRunTracerFields`) before `emitter.emitRun`.
  Filtered runs are still traced — children are matched independently, and the thread map
  keeps learning `thread_id` from the always-kept root.
- **`registry.ts`** — holds the once-validated `RunFilter` alongside the emitter (the
  hook/slot construct fresh tracer instances per configure; the filter must be one per
  process).
- **`index.ts`** — reads and validates ALL config (settings, attach mode, filter) before
  any side effect; exports `RunFilter` / `readRunFilterFromEnv`; `__resetForTests()`
  clears the filter.
- **`run-filter.test.ts`** (new) + run-tracer/index test additions — parsing fail-fast
  combinations, glob anchoring/escaping, run_type-guarded langgraph_node matching, the
  root guarantee in both modes, pair-atomic dropping through the real BaseTracer
  entrypoints, and thread inheritance across a filtered parent.
- **`configure-slot.ts`** — housekeeping that rode into `main` via the PR #5 merge
  without a version and ships here: the idempotency/startup `Symbol.for` keys are now
  `kafkaObservability.*`. Runtime-internal, no contract change; only relevant if two
  library copies of different versions ever share one process (their markers no longer
  collide — each copy would install its own slot wrap, which the name-dedupe still keeps
  to one tracer per run).

## 1.2.0 (2026-08-05)

Attachment-robustness release, closing the INC-2026-0045 root cause: in QA App Service
(LangGraph Platform image) the tracer **never attached** — `registerConfigureHook` stores
its registry in AsyncLocalStorage (`enterWith` at registration, `getStore()` at configure
time), so a hook registered at graph-module load is invisible to any run whose async
context does not descend from `startup()`. Platform harnesses that create their
run-dispatch channel before importing the graph sever exactly that ancestry; the hook
registers cleanly at boot, then silently never fires (`_getConfigureHooks()` returns `[]`).
The identical image worked in local docker-compose because there the graph import
preceded the server — reproduced mechanically on Node 22 (a server created before the
import never sees the `enterWith` store, even for later connections).

Additive: no event-schema, transport, or wiring change; existing deployments upgrade by
file refresh (see `migrations/1.1.0-to-1.2.0.md`).

- **`configure-slot.ts`** (new) — `installConfigureSlot()` wraps this package's own
  `CallbackManager._configureSync` (the exact attachment point LangSmith's tracer
  occupies — the only ancestry-independent slot) and appends a `KafkaRunTracer` with the
  hook path's exact semantics: `KAFKA_ENABLED === "true"` gate checked at configure time,
  fresh instance per configure, deduped by handler name, inheritable. Idempotent
  (Symbol.for marker), reversible, runtime-only (nothing on disk is patched), confined to
  the library's own `@langchain/core` copy. Falls back to wrapping `configure()` with a
  warning if the underscored static ever disappears.
- **ALS-break detector** — when the hook was registered too (`both` mode) and the slot
  still had to attach, one loud `[observability] ALS context break detected: … (store
  classification)` line fires, distinguishing severed ancestry (`store-undefined`) from a
  clobbered store and from a foreign-core-copy registration — the discriminating evidence
  for the upstream escalation.
- **Boot attachment diagnostics** — startup now logs one greppable line: attach mode,
  pid, resolved `@langchain/core/context` URL (which physical copy), shared-ALS presence,
  hooks visible at boot (registration readback), `NODE_OPTIONS` + `execArgv` (injected
  agent/loader detection); plus a duplicate-library warning when a second `startup()`
  sees a different core URL.
- **`KAFKA_ATTACH_MODE`** (`settings.ts`, new optional env var) — `hook` | `patch` |
  `both` (default `both`: hook + slot, deduped; the slot doubles as the hook's failure
  detector). Invalid values throw at startup (no-config-fallback rule).
- **`index.ts`** — `startup()` wires the chosen attachment path(s) and the diagnostics;
  exports `getAttachDiagnostics()`; `__resetForTests()` also restores the configure slot
  (the hook remains un-unregisterable — unchanged upstream limitation).
- **`configure-slot.test.ts`** (new) — documents the upstream failure (a registered hook
  firing in a descendant context but NOT under `als.run(undefined, …)`), and proves the
  slot attaches under that break, dedupes by name, installs idempotently, stays inert
  unless `KAFKA_ENABLED` is exactly `"true"`, and uninstalls cleanly.

## 1.1.0 (2026-08-04)

Connection-diagnostics release, motivated by a real QA incident: an agent's events never
reached the shared sink, and the logs made the failure undiagnosable — startup printed
"Kafka run tracing ready" **before** any broker/SASL handshake, and a producer that never
connects is otherwise silent (the drain loop no-ops until librdkafka's "ready" event,
`event.error` does not reliably fire against black-holed egress, and the queue-full
warning needs `KAFKA_QUEUE_MAXSIZE` events to trigger). "Connected" and "never connected"
were indistinguishable from application logs.

No behavior changes beyond logging: `produce()`, drain, shutdown semantics, config keys,
and the disabled-by-default contract are untouched. Pure file refresh for consumers —
re-run `/add-kafka-observability` (see `migrations/1.0.0-to-1.1.0.md`).

- **`kafka-producer.ts`** — logs `[observability] Kafka producer connected` when the
  broker handshake actually completes, and arms a one-shot, `unref()`'d connection
  watchdog (default 30 s — 10× the 3 s socket setup timeout, generous for SASL_SSL) that
  warns when the producer has still not connected, including the current in-memory queue
  fill (`queue N/max`). Cleared on "ready" and on `shutdown()`. The threshold is an
  injectable constructor parameter so tests don't wait 30 s.
- **`index.ts`** — the startup line no longer claims readiness:
  "Kafka run tracing ready: …" → "Kafka run tracing initialized (producer connecting in
  background): …" (same app/topic/brokers/retries fields).
- **`kafka-producer.test.ts`** — two new watchdog tests on the existing
  unreachable-broker harness: the not-connected warning fires with the queue fill, and
  `shutdown()` clears the watchdog (no stray warning after a deliberate close).

## 1.0.0 (2026-08-03)

Initial release.

- **`KafkaRunTracer`** (`run-tracer.ts`) — a `BaseTracer` subclass attached globally via
  `registerConfigureHook` (the same mechanism LangSmith's own tracer uses). Captures every
  traced run — graph invocation, each LangGraph node, each LLM call (full rendered
  messages, invocation params, outputs, token usage), each tool run — and emits **two
  events per run**: `direction: "request"` at run creation (inputs) and
  `direction: "response"` at run end (inputs + outputs/error, latency, status). Trace
  hierarchy travels in every event (`trace_id`, `parent_run_id`, `dotted_order`) so the
  full LangSmith-style run tree is reconstructable downstream. `thread_id` is resolved
  from run metadata (LangGraph injects `configurable.thread_id` there), with a
  per-trace fallback map for child runs that carry no metadata.
- **Event envelope** (`schemas.ts`, zod-validated) — the
  `{ id, thread_id, application_name, timestamp, data }` shape already consumed by the
  shared Elasticsearch sink. Kafka message key is the event's own `id` (a sink that
  upserts by key would otherwise collapse a thread's events into one document).
- **Transport** (`kafka-producer.ts`, `bounded-queue.ts`) — `@confluentinc/kafka-javascript`
  (librdkafka) behind a bounded in-memory queue (default 1000) with a 10 ms background
  drain loop. `produce()` never blocks; a full queue drops the event and logs a running
  count. `acks=all`, idempotent producer, bounded `shutdown()` (drain → flush → disconnect,
  every phase raced against a timer — librdkafka's own timeouts do not reliably bound a
  never-connected broker). Ported verbatim from a live-verified implementation.
- **Redaction** (`redaction.ts`) — recursive masking of `authorization` / `api_key` /
  `password` / `token` / `secret` / `credential` / `connection_string` keys and
  `password=` fragments in string values, applied to every payload before serialization.
- **Size cap** — events over 512 KB are replaced by a truncation marker
  (`{ type: "truncated", original_bytes, sha256 }`).
- **Config** (`settings.ts`, `env.ts`) — `KAFKA_ENABLED` gate (must be exactly `"true"` —
  the global callback hook compares strictly); when enabled, `APPLICATION_NAME`,
  `KAFKA_BOOTSTRAP_SERVERS`, `KAFKA_OBSERVABILITY_TOPIC` are required and fail fast
  (no-config-fallback rule). Optional: `KAFKA_SECURITY_PROTOCOL`, `KAFKA_SASL_MECHANISM`,
  `KAFKA_SASL_USERNAME`, `KAFKA_SASL_PASSWORD`, `KAFKA_CLIENT_ID`,
  `KAFKA_PRODUCER_LINGER_MS`, `KAFKA_PRODUCER_BATCH_SIZE`, `KAFKA_QUEUE_MAXSIZE`,
  `KAFKA_PRODUCER_RETRIES`, `KAFKA_DELIVERY_TIMEOUT_MS`.
- Disabled by default: `startup()` is a no-op without `KAFKA_ENABLED=true`; no Kafka env
  var is read or required, and the tracer is never attached.
