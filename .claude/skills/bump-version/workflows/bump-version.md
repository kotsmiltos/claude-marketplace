# Workflow: bump-version

Refresh an embedded vendored library from a newer source and propagate the change. Five phases
with a hard approval gate after Phase 3. This is a repo-maintainer skill living at
`.claude/skills/bump-version/`; all plugin paths below are relative to the target's plugin root.

## Target libraries

| | `agent-step` (default) | `observability` |
|---|---|---|
| Plugin root | `plugins/agent-step-toolkit/` | `plugins/kafka-observability/` |
| Embedded copy | `skills/create-tool/templates/agent-step/` | `skills/add-kafka-observability/templates/observability/` |
| Source dir in a downstream repo | `src/agent-step/` | `src/observability/` |
| Core files (Phase 1 sanity check) | `types.ts`, `state.ts`, `runner.ts`, `runner.test.ts`, `paginate.ts`, `paginate.test.ts`, `define-config.ts`, `index.ts` | `index.ts`, `run-tracer.ts`, `event-emitter.ts`, `schemas.ts`, `kafka-producer.ts`, `bounded-queue.ts`, `redaction.ts`, `settings.ts`, `env.ts`, `registry.ts`, `event-producer.ts` (+ their `.test.ts` files, `README.md`) |
| Public surface (Phase 2 semver) | `index.ts` exports, `types.ts` signatures, `buildAgentStepTool` options | `index.ts` exports (`startup`/`shutdown`/re-exports), `schemas.ts` event envelope/data shape, `settings.ts` env-var keys |
| Blast-radius map | `references/tracked-assets.md` | `references/tracked-assets-observability.md` |
| Downstream upgrade skill (consumes the migration) | `/pull-library` | `/add-kafka-observability` (upgrade mode) |
| Phase 5 verification | bootstrap a throwaway project from templates | compile + run the library suite in a scratch dir (see Phase 5) |

Resolve the target from the user's words (which library / which plugin they name); when ambiguous,
ask. Read first: the target's blast-radius map (above) and the target plugin's
`migrations/README.md` (the migration file format).

---

## Phase 1 — Resolve & stage the source

Turn the user's reference into a local, read-only snapshot of the new source dir (per the target
table: `src/agent-step/` or `src/observability/`).

1. **Local path** — if it points at a project root, find the source dir under it; if it points
   directly at the library dir, use it as-is.
2. **Git repo URL + ref** — shallow-clone to a temp dir at the given ref (default branch if none),
   then locate the source dir:
   ```
   tmp=$(mktemp -d) && git clone --depth 1 [--branch <ref>] <url> "$tmp"
   ```
3. **Git ref in a local repo** — materialise the ref without disturbing the working tree:
   ```
   tmp=$(mktemp -d) && git -C <repo> archive <ref> <source-dir> | tar -x -C "$tmp"
   ```

Then:
- Confirm the target's core files exist (see the target table). (A `VERSION` in the source is
  informational — this skill assigns the embedded library's version, it doesn't inherit the
  source project's.)
- Capture the source project's `package.json` (for the dependency comparison in Phase 2/4).
- Note the staged path; everything below diffs against the target's embedded copy.

---

## Phase 2 — Diff & evaluate

1. **Diff** each staged file against the embedded copy (per the target table):
   ```
   diff -u <embedded-copy>/<f> "$staged/<f>"
   ```
   Include files that exist in one side only (added/removed library files).

2. **Classify the public surface.** The version bump is decided by the surface, not line count.
   Read the target's public surface (see the target table):
   - `agent-step`: `index.ts` exports and `types.ts` signatures, plus the `buildAgentStepTool`
     options type in `runner.ts`.
   - `observability`: `index.ts` exports (`startup`/`shutdown`/re-exports), the event
     envelope/data shape in `schemas.ts` (downstream sinks consume it — a removed/renamed field
     is breaking), and the env-var keys in `settings.ts`/`env.ts` (deployment configs depend on
     them).
   - **major** — an export/field/env key was removed or renamed, a signature changed, or a new
     required arg/config appeared.
   - **minor** — only additive (new export, new optional arg/field/env key), nothing existing broke.
   - **patch** — internal-only behaviour, comments, or tests changed with no surface delta.
   Compute the new version from the current `VERSION` accordingly.

3. **Diff dependencies.** Compare the source `package.json` deps against what the plugin
   prescribes — `agent-step`: `templates/project/package.json.template` (`@langchain/*`, `zod`,
   `tsx`, `typescript`, etc.); `observability`: the dependency the install workflow names
   (`@confluentinc/kafka-javascript` in `workflows/add-kafka-observability.md`). Note any that
   should bump.

4. **Compute blast radius.** Walk the target's blast-radius map tier by tier and, for each concrete
   change found in the diff, list the specific assets that must be hand-updated. Be exact — name
   files, and for reference docs/SKILL prose name the sections.

5. **Write the evaluation report** (in your response, not a file yet): the per-file diff summary, the
   surface classification + chosen version, the dependency deltas, and the blast-radius list. Call out
   anything you're unsure how to propagate.

---

## Phase 3 — Propose (APPROVAL GATE)

Present a proposal and **stop for approval**. Do not edit any toolkit file before the user approves.

The proposal contains:
- The evaluation report from Phase 2.
- The proposed new version string.
- An **ordered planned-edit list**: Tier-1 verbatim replacements first, then each dependent asset
  with a one-line description of the edit.
- A **draft CHANGELOG entry**.
- A **migration outline**: the prose headings + the intended `<transforms>` (the actual edit rules
  the target's downstream upgrade skill will run — `/pull-library` or `/add-kafka-observability`).
  For an additive-only bump, state that no transforms are needed.

If the user requests changes, revise and re-present. Only proceed to Phase 4 on explicit approval.

---

## Phase 4 — Apply

In dependency order:

1. **Verbatim replace** every Tier-1 file from the staged source into the target's embedded copy
   (per the target table). Mirror any added/removed library files into the docs that enumerate
   them — `agent-step`: the bootstrap copy list (`workflows/bootstrap-project.md` Step 5 +
   file-list) and `create-tool/SKILL.md` `templates_index`; `observability`: the vendored-file
   count/inventory in `workflows/add-kafka-observability.md` and the library `README.md`.

2. **Write the new `VERSION`** into the embedded copy's `VERSION` file.

3. **Hand-update each dependent asset** in the approved blast radius (per the target's map).
   Match the new contract exactly — for `agent-step`, e.g. an executor-signature change touches
   every executor template, the `tool-index.ts.template` wire-up, `agent-step-api.md`,
   `tool-directory-layout.md`, `executor-patterns.md`, the create-tool workflow's file-creation
   order, and the SKILL `essential_principles`/`quick_reference`. For `observability`, e.g. a new
   env var touches `add-kafka-observability` SKILL.md `<quick_reference>`, the workflow's
   `.env.example` block + settings guidance, and the library `README.md` tables.

4. **Bump deps** where the plugin prescribes them — `agent-step`:
   `templates/project/package.json.template`; `observability`: the dependency named in
   `workflows/add-kafka-observability.md`.

5. **Prepend the CHANGELOG entry** to the target plugin's `CHANGELOG.md` (newest first): version,
   date, Added / Changed / Breaking sections, and a link to the migration file.

6. **Write `migrations/<from>-to-<to>.md`** (target plugin root) per that plugin's
   `migrations/README.md` — prose + a `<transforms>` section of ordered, specific, idempotent edit
   rules the downstream upgrade skill (`/pull-library` or `/add-kafka-observability`) applies to a
   consumer project, each with a `check`. (Additive-only: library replacement only; say so.)

---

## Phase 5 — Verify by instantiation

The templates aren't a standalone TS project, so prove the bump by compiling and testing them
in a real dependency context:

**`agent-step`** — bootstrap a throwaway project from the updated `create-tool` templates into a
temp dir (follow `skills/create-tool/workflows/bootstrap-project.md`, or copy the project +
agent-step templates and substitute placeholders), then:
```
npm install
npm run typecheck
npx tsc && node --test dist/agent-step/runner.test.js
```

**`observability`** — copy the updated `templates/observability/` into a scratch dir whose module
resolution reaches a real `node_modules` providing `@langchain/core`, `zod`, and
`@confluentinc/kafka-javascript` (e.g. a subdirectory of an agent repo checkout — Node resolves
upward), add a minimal `tsconfig.json` + `{"type":"module"}` package.json, then:
```
npx tsc
node --test dist/observability/*.test.js
```
Delete the scratch dir afterwards.

Expected either way: zero typecheck errors, all library tests pass. Failures here mean drift
between the new library and a hand-edited asset — fix the asset, not the library.

Report results: version old→new, files changed, dep bumps, the migration file written, and the
verification outcome. Remind the user that downstream projects upgrade via the target's skill
(`/pull-library` or `/add-kafka-observability`).
