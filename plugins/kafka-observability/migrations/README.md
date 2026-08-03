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

No migrations yet — 1.0.0 is the initial release.
