# Workflow: Add (or upgrade) Kafka observability

Install or upgrade the vendored `src/observability/` library in the current repo and wire
it. Follow the steps in order; the approval gate is Step 3.

## Step 1: Detect

1. Resolve the plugin directory and read `templates/observability/VERSION` (the shipped
   library version).
2. Qualify the repo: `package.json` must depend on `@langchain/core` or
   `@langchain/langgraph`. If neither, stop and tell the user why.
3. **Existing-Kafka guard** (always, before Mode):
   - `src/observability/` non-empty with NO `VERSION` → foreign module on the canonical
     path.
   - Kafka producer usage elsewhere (`grep -rl "@confluentinc/kafka-javascript\|kafkajs\|node-rdkafka" src/ --include='*.ts'`
     outside `src/observability/`) → existing Kafka functionality, no path collision.

   When either fires: ask the user to CLASSIFY it per the SKILL.md intake (agent-flow
   observability → keep-both or replace-with-downstream-sign-off; unrelated
   functionality, e.g. liveness/business events → preserve untouched, relocation only;
   unsure → preserve). Never infer the module's purpose from its code shape. Also grep
   which `KAFKA_*`/`APPLICATION_NAME` keys the existing code reads — the overlap goes
   into the Step 3 plan verbatim. Execution is Step 4a.
4. Mode:
   - `src/observability/VERSION` absent → **first install**.
   - Present and older than shipped → **upgrade**: collect the applicable
     `<plugin>/migrations/<from>-to-<to>.md` files (in version order). Their
     `<transforms>` cover project-level integration edits only — the library files are
     always replaced wholesale.
   - Present and equal → report "already current: <version>" and STOP.
5. Locate the integration points:
   - **Graph entry module**: the module `langgraph.json` points at (e.g. `src/graph.ts`),
     falling back to the module that builds/exports the compiled graph.
   - **Env example**: `.env.example` (or equivalent).
   - **Deployment settings**: `configuration/**/settings.*.json` if present.
   - **Docker**: `Dockerfile` if present (native-module check, Step 7).
   - **Existing LangSmith config**: note `LANGSMITH_*` usage for the parallel-run report.

## Step 2: Gather inputs

Per the SKILL.md intake: `APPLICATION_NAME` (propose snake_cased package name), brokers +
topic (per environment where deployment settings exist), security mode (PLAINTEXT vs SASL
+ Key Vault secret name for the password), enable-now-or-ship-disabled (default disabled),
and which settings files to touch.

For brokers/topic/security defaults, first scan sibling repos in the parent directory for
an existing install (`src/observability/VERSION` present) and read their `.env.example` +
`configuration/**/settings.*.json` `KAFKA_*` values; propose those as per-environment
defaults for the user to confirm. Read-only — never write outside the target repo.

## Step 3: Plan + approval gate (mandatory before any project-file write)

Present:

```
# Kafka observability — <install|upgrade to> <version>: <repo name>

## Vendored (replaced wholesale, safe)
- src/observability/  (28 files: library + tests + README + VERSION)

## Project edits (need your OK)
- package.json         + "@confluentinc/kafka-javascript", + "test:observability" script
                       (+ fold into "test:all" if the repo has one)
- <graph entry module> + import + startup() call at module load
                       (+ contentMask policy, if one is being wired — say which)
- [existing-Kafka guard only] <classification the user gave>:
  <keep-both: git mv src/observability → src/observability-legacy + N call-site import
   updates | replace (downstream sign-off confirmed): delete module + remove M call
   sites | unrelated: relocate only, functionality untouched>
  env-key overlap: <which KAFKA_*/APPLICATION_NAME keys the existing code reads;
  "KAFKA_ENABLED=true activates BOTH stacks" when shared> topic sharing: <same topic?
  consumers discriminate by data.type>
- .env.example         + KAFKA_* block (disabled by default)
- configuration/<app>/settings.<ENV>.json   + KAFKA_* entries (SASL password as
                       @Microsoft.KeyVault(...) reference), KAFKA_ENABLED "<false|true>"
- [upgrade only] transforms from migrations/: <list>

## Values
APPLICATION_NAME=<...>  brokers/topic per env: <...>  security: <...>
```

Wait for approval. On rejection, adjust or stop.

## Step 4a: Existing-Kafka handling (only when Step 1's guard fired; after approval)

Per the user's classification and decision (all shown concretely in the Step 3 plan):

**Keep-both (agent-flow observability, coexistence) — or unrelated functionality that
occupies `src/observability/`:**
1. `git mv src/observability src/observability-legacy` (history preserved; pick a more
   descriptive name if the user offers one, e.g. `src/liveness-events/`). Its internal
   imports are relative and keep working unchanged.
2. Update every call-site import outside the moved directory
   (`grep -rn "observability/" src/ --include='*.ts'`) to the new path. If the existing
   module exports its own `startup`/`shutdown` and a call site will also import the
   tracer's, alias one (e.g. `startup as startupLegacyObservability`).
3. `npx tsc --noEmit` must pass BEFORE vendoring — isolates move breakage from
   install breakage.
4. Report the runtime consequence: both stacks run their own producer (one extra broker
   connection) and share whatever env keys the grep found — when `KAFKA_ENABLED` is
   shared, enabling the tracer enables the legacy emitter too.

**Replace (only ever for user-classified agent-flow observability, with confirmed
downstream sign-off):**
1. Delete the module directory.
2. Remove every emitter import and call site — including observability-only wrapper
   helpers around node functions/conditional edges — listing each removal file:line.
3. `npx tsc --noEmit` must pass BEFORE vendoring.

**Unrelated functionality with no path collision:** nothing to execute here — the plan's
env-overlap note is the deliverable; the module is not touched.

## Step 4: Vendor the library

Copy every file from `templates/observability/` into `src/observability/`, replacing
existing library files on upgrade. Never merge — the library is vendored, local edits are
not expected (if a diff against the old vendored copy shows hand-edits, STOP and surface
them to the user before overwriting).

## Step 5: Wire

1. `npm install @confluentinc/kafka-javascript` (let npm pick the compatible version;
   `zod` and `@langchain/core` are already agent dependencies — verify, don't duplicate).
2. In the graph entry module, immediately after env/dotenv initialization and before the
   graph is built/exported:

   ```ts
   import { startup as startupObservability } from "./observability/index.js";
   startupObservability();
   ```

   Do NOT wrap the graph export and do NOT add per-node/tool instrumentation — the global
   attachment (configure hook + configure-slot wrap, both installed by `startup()`)
   covers every run.
3. If the repo has a CLI with a quit path, add a best-effort
   `await shutdown()` there (import from the same module). Do NOT install process signal
   handlers — an added SIGTERM handler would suppress the default terminate in processes
   that don't otherwise handle it.
4. `package.json`: add `"test:observability": "tsc && node --test dist/observability/*.test.js"`;
   fold into `test:all` when one exists.
5. **Optional — backend HTTP call tracing (1.5.0+).** If the project routes its backend
   HTTP calls through a single chokepoint (a `postBackend`-style helper), OFFER to wrap
   it in `traceBackendCall` so every outgoing call becomes a traced `http:<endpoint>`
   run (and its retry wrapper, if any, in `withAttemptContext`). This is a project-code
   edit behind the same approval as the rest of Step 5, and it carries a hard
   precondition: the values passed as `input`/`logged` must already be masked by the
   project's OWN domain redaction — audit that redaction against the real backend
   response shapes first (the library redactor is credential-only and will happily ship
   a full card number or customer name; see the library README "Backend HTTP call
   tracing"). Skip silently when there is no chokepoint — never instrument individual
   call sites.
6. **Optional — content masking (1.6.0+).** The library masks credentials only; the
   conversation itself (prompts, completions, graph state, tool params) reaches the topic
   verbatim unless the project supplies a policy. ASK whether to wire one, and lead with
   what the project already has — search for an existing domain masker before proposing
   new code:

   ```bash
   ls src/**/redact*.ts src/**/*redaction*.ts 2>/dev/null
   grep -rln "mask\|redact" src --include=*.ts | grep -v src/observability
   ```

   - **A domain masker exists** (the common case in the voice agents — e.g.
     `src/tools/<tool>/backend/redact.ts`): propose composing it, digit pass INSIDE the
     key-based one, because every key tier trims a tail and the digit pass preserves
     tails — and for a voice-channel agent, the spoken-digit pass too (1.7.0+; word-form
     is how dictated PINs/OTPs actually arrive), AFTER `maskDigitsInText` because the
     spoken pass counts the numeral pass's `#` tokens as run members:

     ```ts
     startupObservability({
       contentMask: (value) =>
         redactValue(
           mapStringsDeep(value, (s) => maskSpokenDigitsInText(maskDigitsInText(s)), { keys: true }),
         ),
     });
     ```

     (Text channel / no spoken-word need: keep the plain
     `mapStringsDeep(value, maskDigitsInText, { keys: true })` form.)

     Check two things before proposing it, and say what you found: whether it masks a bare
     `name` key (inside run content that also hits LangChain's own `ToolMessage.name` /
     `tool_calls[].name`), and whether any rule strips digits from a WHOLE string (which
     collapses model prose instead of the numbers inside it).
   - **No masker exists**: offer `digitContentMask()` as-is — with
     `spokenLanguages: ["el", "en"]` for a voice agent — and name its rules out loud:
     runs of 7+ digits become `***<last4>`, shorter runs are masked digit-for-digit, so
     four real digits of every long identifier still reach the topic (`keepLast: 0`
     removes even those); and with `spokenLanguages`, runs of 3+ spoken digit words are
     masked (a lone «ένα» in prose survives), with the numeral pass's length rule (1.8.0+):
     PIN/OTP shapes of 4–6 words mask whole, one `#` per word, while 7+-word dictated
     identifiers (cards, tax ids) keep a TRANSLATED `***<last4>` tail — same digits the
     typed form would keep (`keepLast: 0` blankets both passes).
   - **Either way**, state the scope: `keys: true` is what reaches a slot keyed BY a
     sensitive value, `metadata` is never masked (so no PII in `configurable`), and the
     spoken pass covers word digits 0–9 in Greek and English only — composed number words
     («σαράντα οκτώ», "forty-eight") and other languages cannot be caught. See the
     library README "Content masking".

   Wiring nothing is a valid answer — it keeps 1.5.0 behaviour exactly — but it must be
   the user's choice, not a default that goes unmentioned.

## Step 6: Configure

1. `.env.example` — append (values from intake; keep the disabled default unless the user
   chose otherwise):

   ```
   # Kafka observability (LangSmith-parity run events; see src/observability/README.md)
   # KAFKA_ENABLED must be exactly "true" to activate.
   KAFKA_ENABLED=false
   APPLICATION_NAME=<application_name>
   KAFKA_BOOTSTRAP_SERVERS=<brokers>
   KAFKA_OBSERVABILITY_TOPIC=<topic>
   # KAFKA_SECURITY_PROTOCOL=SASL_SSL
   # KAFKA_SASL_MECHANISM=PLAIN
   # KAFKA_SASL_USERNAME=
   # KAFKA_SASL_PASSWORD=
   # Tracer attachment path: hook | patch | both (default both; see src/observability/README.md "Attachment")
   # KAFKA_ATTACH_MODE=both
   # Opt-in run filtering: off | allow | deny (default off = every run emitted; see src/observability/README.md "Run filtering")
   # KAFKA_RUN_FILTER_MODE=off
   # KAFKA_RUN_FILTER_PATTERNS=
   ```

2. Each approved `configuration/**/settings.<ENV>.json` — add the same keys with that
   environment's values; SASL password as
   `@Microsoft.KeyVault(VaultName=<vault>;SecretName=<secret>)`. `KAFKA_ENABLED` per the
   intake decision (default `"false"`).
3. [Upgrade only] Apply each migration's `<transforms>` in version order; they are
   idempotent. Surface anything that cannot be applied cleanly as an explicit manual
   follow-up with file:line.

## Step 7: Docker / native module check

`@confluentinc/kafka-javascript` wraps librdkafka (native). If the repo has a Dockerfile:
confirm the base image is covered by a node-pre-gyp prebuild (glibc and musl are) or that
a C/C++ toolchain is present during `npm ci` for the source-build fallback. Report the
finding; only edit the Dockerfile with explicit approval.

## Step 8: Verify

```bash
npm run typecheck || npx tsc --noEmit   # whole project still compiles
npm run test:observability              # library suite (no broker needed)
npm test                                # existing suites still green
```

Optional (offer, don't assume): live smoke against a local broker — set
`KAFKA_ENABLED=true` + local broker values in `.env`, run one conversation (project CLI or
dev server), consume the topic with `kafka-console-consumer` and confirm request/response
events per run arrive with the right `thread_id`.

## Step 9: Report

- Mode + library version installed; files vendored/edited; verification results (exact
  test counts).
- **Parallel-run note**: LangSmith is untouched; with both enabled the team can diff the
  sinks, then unset `LANGSMITH_*`/set `LANGSMITH_TRACING=false` to unplug — no code change.
- **Data note**: events carry full prompts/transcripts (incl. caller identifiers);
  redaction masks secrets, not PII. The topic/sink must be treated with the same
  confidentiality as the LangSmith instance it replaces.
- **Ops note**: fire-and-forget — sustained broker unavailability or queue saturation
  drops events (logged with running counts); size events/retention for roughly 10–20
  events per caller turn, KBs each (LLM run events repeat the full prompt).
