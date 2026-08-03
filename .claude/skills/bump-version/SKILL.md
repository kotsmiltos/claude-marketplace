---
name: bump-version
description: Refresh an embedded vendored library — the agent-step runner (agent-step-toolkit) or the Kafka observability library (kafka-observability) — from a newer source (a local path, a git repo + ref, or a git ref in a local repo), then propagate the change. Diffs the new source against the embedded copy, evaluates the change (additive/breaking/internal) and picks a semver bump, updates every tracked plugin asset that mirrors the library contract (templates, references, workflows, SKILL prose), bumps the library VERSION, appends a CHANGELOG entry, and writes a version-keyed migration guide (prose + machine-actionable transforms) that the downstream upgrade skill (/pull-library or /add-kafka-observability) applies to downstream projects. Use when a new version of either vendored library exists and its plugin should adopt it.
---

<objective>
This skill is the **maintainer side** of vendored-library versioning for this marketplace. It lives
at the repo level (`.claude/skills/bump-version/`), NOT in a published plugin — it edits plugin
source trees, which only exist in this repo checkout.

It maintains TWO libraries (the target is resolved at intake; plugin-relative paths resolve against
the target's plugin root):
- **`agent-step`** (default) — the runner library at
  `plugins/agent-step-toolkit/skills/create-tool/templates/agent-step/`.
- **`observability`** — the Kafka run-tracing library at
  `plugins/kafka-observability/skills/add-kafka-observability/templates/observability/`.

Each plugin ships its vendored copy plus a layer of dependent assets that encode its contract. When
a newer library exists somewhere (typically improved in place inside a downstream agent repo), this
skill absorbs it: refresh the copy, propagate the contract change across every dependent asset,
version it, and record how downstream projects should upgrade.

The complement runs INSIDE a downstream project to pull the refreshed library out of the (updated)
plugin: `/pull-library` for agent-step, `/add-kafka-observability` (upgrade mode) for observability.
This skill writes the migration guide those skills consume — so the migration's `<transforms>`
section is a deliverable, not an afterthought.

The skill is generic (works for any future bump). Its evaluation discovers what changed; it does not
hard-code any particular library version's shape.
</objective>

<essential_principles>
**1. The embedded copy is the source of truth.** The target's embedded copy is what new projects
install/bootstrap from AND what the downstream upgrade skill upgrades to. Replacing it is the core
of the bump; everything else (refs, templates, prose) exists to keep the plugin's *instructions*
honest about the new contract.

**2. Library version ≠ plugin version.** Bump only the library `VERSION` marker inside the
embedded copy. Never touch `.claude-plugin/plugin.json` — that is `/publish-release`'s job.

**3. Verbatim copy, hand-merged contract.** When absorbing an external source, Tier-1 library files
are replaced byte-for-byte — never hand-merged with local edits. Every OTHER tracked asset is
hand-updated to match the new contract. The two are different operations; don't blur them.
(The embedded copy is itself the canonical source; a release may instead be authored directly in it
— e.g. doc-comment corrections — with no external source to copy from. The same version bookkeeping
applies either way: bump `VERSION`, write the CHANGELOG entry and the migration file.)

**4. Evaluate before you touch anything.** Classify the diff (additive / breaking / internal),
pick the semver bump from the target's PUBLIC surface (agent-step: `index.ts` exports + `types.ts`
signatures + `buildAgentStepTool` options; observability: `index.ts` exports + the `schemas.ts`
event shape + the `settings.ts` env keys), and compute the blast radius from the target's
tracked-assets reference BEFORE editing. Surface it for approval — this is the cheap review surface.

**5. The migration guide is machine-actionable.** For any breaking or contract-changing release,
the `migrations/<from>-to-<to>.md` file MUST carry a `<transforms>` section of ordered, specific
edit rules the downstream upgrade skill (`/pull-library` / `/add-kafka-observability`) can apply to
a consumer project — not just prose. See the target plugin's `migrations/README.md` for the format.

**6. Verify by instantiation.** The templates aren't a standalone TS project. Prove the bump by
compiling + testing them in a real dependency context (agent-step: bootstrap a throwaway project;
observability: scratch-dir compile + the library's test suite — see the workflow's Phase 5). The
source library is known-good; this catches drift in the hand-edited assets.
</essential_principles>

<intake>
**Resolve the TARGET library first**: `agent-step` (default when the user talks about the runner /
agent-step-toolkit) or `observability` (when they talk about the Kafka observability library /
kafka-observability plugin). If genuinely ambiguous, ask. The target fixes every path via the
workflow's target table.

**Then resolve the library source from the user's reference.** Accept any of:

1. **Local filesystem path** — to a project root (auto-find the target's source dir under it —
   `src/agent-step/` or `src/observability/`) or directly to the library directory. The primary
   case: a local checkout of a downstream agent project whose vendored library was improved in
   place and should now be absorbed back into the plugin.
2. **Git repo URL + ref** — `<url>` plus an optional branch/tag/commit. Shallow-clone to a temp dir,
   then locate the target's source dir.
3. **Git ref in a local repo** — a tag/commit/branch of an already-local repo. Materialise that ref
   (temp worktree or `git archive`) and locate the target's source dir.

**If the reference is ambiguous or missing,** ask for it before proceeding. Otherwise go straight to
the workflow.
</intake>

<routing>
Follow `workflows/bump-version.md` exactly — the 5 phases (resolve & stage → diff & evaluate →
propose → apply → verify). It has a hard approval gate after Phase 3; do not edit toolkit files
before approval.
</routing>

<quick_reference>
**What the bump produces (all paths per the workflow's target table):**
- The target's embedded copy refreshed verbatim + new `VERSION`.
- Every affected tracked asset (target's tracked-assets reference) hand-updated.
- `CHANGELOG.md` (target plugin root) — new entry prepended.
- `migrations/<from>-to-<to>.md` (target plugin root) — prose + `<transforms>`.

**Semver rule (from the target's public surface):**
- **major** — removed/renamed export/field/env key, changed signature, new required arg/config.
- **minor** — additive export / optional arg / new optional env key, no break.
- **patch** — internal-only (behaviour, comments, tests) with no surface change.

**Blast-radius maps:** `references/tracked-assets.md` (agent-step, 6 tiers) /
`references/tracked-assets-observability.md` (observability, 4 tiers).

**Migration file format:** the target plugin's `migrations/README.md` — prose + `<transforms>`
contract with the downstream upgrade skill (`/pull-library` / `/add-kafka-observability`).
</quick_reference>

<reference_index>
- **references/tracked-assets.md** — agent-step: the inventory of plugin assets that mirror the library contract, by tier, with "what touches it." The blast-radius map for Phase 2 and the edit list for Phase 4.
- **references/tracked-assets-observability.md** — the same inventory for the observability library (kafka-observability plugin).
- **plugins/agent-step-toolkit/migrations/README.md** / **plugins/kafka-observability/migrations/README.md** — the migration file format (prose + `<transforms>`) this skill writes, per target.
- **plugins/agent-step-toolkit/skills/create-tool/references/agent-step-api.md** — agent-step's current written contract; the highest-fidelity Tier-4 asset to reconcile.
- **plugins/kafka-observability/skills/add-kafka-observability/templates/observability/README.md** — the observability library's written contract (in-library, ships to consumers); reconcile it the same way.
</reference_index>

<workflows_index>
| Workflow | Purpose |
|----------|---------|
| workflows/bump-version.md | Resolve & stage the source → diff & evaluate → propose (gate) → apply → verify by instantiation. |
</workflows_index>

<success_criteria>
- [ ] The target's embedded copy matches the new source byte-for-byte; `VERSION` holds the new version.
- [ ] Every asset named in the approved blast radius is updated; no reference doc still describes the old contract.
- [ ] Prescribed deps match the source project (agent-step: `templates/project/package.json.template`; observability: the dep named in the install workflow).
- [ ] The target plugin's `CHANGELOG.md` has a new top entry (version, date, Added/Changed/Breaking, migration link).
- [ ] `migrations/<from>-to-<to>.md` exists with prose + a `<transforms>` section (for breaking/contract changes).
- [ ] Phase 5 verification passed (agent-step: throwaway bootstrap + runner tests; observability: scratch compile + library suite).
- [ ] The target plugin's `.claude-plugin/plugin.json` is untouched.
</success_criteria>
