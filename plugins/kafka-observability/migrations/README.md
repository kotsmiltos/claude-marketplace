# observability library migrations

Version-keyed upgrade guides consumed by `/add-kafka-observability` when it finds an
older `src/observability/VERSION` in a target project (the skill handles both first
install and upgrade).

Format (same as agent-step-toolkit's `migrations/`): one file per version step, named
`<from>-to-<to>.md`, containing:

- a summary of what changed in the library,
- an ordered `<transforms>` section — the concrete, idempotent edits to apply to the
  PROJECT's own files (wiring, env examples, deployment settings). The library files
  themselves are always replaced wholesale (vendored, never hand-edited), so transforms
  only ever cover project-level integration points.

For multi-step jumps, apply the files in version order. A project with no
`src/observability/VERSION` is a fresh install — no migrations apply; the skill vendors
the current library directly.

| Step | Summary |
|------|---------|
| `1.0.0-to-1.1.0.md` | Connection diagnostics (connected log, never-connected watchdog, startup reword). Pure file refresh — no project-level transforms. |
| `1.1.0-to-1.2.0.md` | Attachment robustness (INC-2026-0045): configure-slot wrap alongside the ALS-scoped configure hook, `KAFKA_ATTACH_MODE`, attachment/break diagnostics. One transform: `.env.example` gains the commented `KAFKA_ATTACH_MODE` line. |
| `1.2.0-to-1.3.0.md` | Opt-in run filtering (`KAFKA_RUN_FILTER_MODE`/`KAFKA_RUN_FILTER_PATTERNS`, default off = every run emitted; root run always survives). One transform: `.env.example` gains the commented filter lines. |
| `1.3.0-to-1.4.0.md` | Redaction precision: LLM usage counters/containers survive (scalar type guard + anchored usage-container exemption); credential masking unchanged. Pure file refresh — no transforms. |
| `1.4.0-to-1.4.1.md` | Documentation-only re-sync (comment/fixture/README wording); no behaviour, exports, or env change. Pure file refresh — no transforms. |
| `1.4.1-to-1.5.0.md` | Opt-in backend HTTP call tracing (`traceBackendCall` / `withAttemptContext` in new `backend-trace.ts`; `http:<endpoint>` child runs, caller-side pre-masking contract). No mandatory transforms; conditional swap for projects with a pre-1.5.0 hand-rolled module. |
| `1.5.0-to-1.6.0.md` | Host-supplied content masking (`startup({ contentMask })` + `content-mask.ts` primitives; applied to `inputs`/`outputs`/`error`/`events[].kwargs` at the emit funnel). No env key — masking is code. No mandatory transforms; optional wiring, with composition guidance for projects that already own a domain masker. |
| `1.6.0-to-1.7.0.md` | Spoken-digit-word masking (`maskSpokenDigitsInText`, Greek + English packs, minRun 3, no tail; `digitContentMask({ spokenLanguages })` opt-in) — the voice-channel counterpart of the digit pass. No env key. No mandatory transforms; optional extension of an already-wired policy, with the two composition ORDER rules. |
| `1.7.0-to-1.8.0.md` | Numeral parity for spoken runs: `keepLast`/`keepLastMinRun` (defaults 4/7) on the spoken pass — 7+-digit word runs (dictated cards, tax ids) keep a TRANSLATED `***<last4>` tail; PIN/OTP (3–6) unchanged. Default-behaviour change for policies that wired the spoken pass on 1.7.0 (`keepLast: 0` restores whole-mask). No mandatory transforms — file refresh, plus a stated decision point. |
