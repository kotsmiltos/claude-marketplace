# kafka-observability plugin changelog

Version history for the **plugin package** (`.claude-plugin/plugin.json` + the marketplace entry) —
the skills, templates, references, and workflows the plugin ships.

This is distinct from [`CHANGELOG.md`](CHANGELOG.md), which tracks only the **vendored observability
library** version (`skills/add-kafka-observability/templates/observability/VERSION`, bumped by
`/bump-version`). A plugin release may or may not include a library bump.

Format follows [Keep a Changelog](https://keepachangelog.com/); newest first. Semver on the plugin:
**major** = removed/renamed skill or breaking workflow change, **minor** = new skill / capability /
template, **patch** = doc or fix with no new surface.

## [0.2.0] — 2026-08-04

Library unchanged (**1.0.0**). No downstream upgrade needed — changes affect the
`/add-kafka-observability` intake behavior only.

### Added
- Intake now scans sibling repos in the parent directory for an existing
  `src/observability/` install (detected via `src/observability/VERSION`) and proposes
  their `KAFKA_*` values — brokers, topic naming convention, security mode, Key Vault
  secret names — as per-environment defaults. Propose-only: the user confirms every
  value; the scan is read-only outside the target repo.

### Fixed
- Workflow plan template: vendored-directory file count corrected (~17 → 20).

## [0.1.0] — 2026-08-03

Initial release. Ships observability library **1.0.0**.

### Added
- **`add-kafka-observability`** skill — install OR upgrade a vendored `src/observability/`
  library in a LangGraph.js / LangChain.js agent repo: a `BaseTracer` subclass attached
  globally via `registerConfigureHook` (the same mechanism LangSmith's tracer uses) that
  publishes every traced run — graph invocation, LangGraph nodes, LLM calls with full
  prompts/outputs/token usage, tool runs, errors, trace hierarchy — as start/end events
  to a Kafka topic. Bank-standard envelope keyed by event id with `thread_id`
  correlation, zod-validated, secret-redacted, 512KB-truncated, over a bounded
  non-blocking fire-and-forget producer (librdkafka, `acks=all`, idempotent, bounded
  shutdown). Disabled by default (`KAFKA_ENABLED`); runs alongside LangSmith for
  parallel validation. The skill wires the `@confluentinc/kafka-javascript` dependency,
  one `startup()` call at the graph entrypoint, `.env.example`, deployment settings with
  Key Vault refs, a `test:observability` script, and verifies with typecheck + the
  library's unit suite.
