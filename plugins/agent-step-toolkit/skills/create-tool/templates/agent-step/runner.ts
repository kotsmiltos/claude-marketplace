/**
 * agent-step runner
 *
 * Compiles a `defineConfig({...})` description plus name-keyed executor /
 * verifier registries into a single LangChain `StructuredTool` whose schema is
 * `{ steps: Step[] }` — a discriminated union over the configured actions.
 *
 * One tool invocation = one batch of steps, executed in two stages:
 *
 *   1. Plan expansion (synchronous, no side effects). Tag each user-declared
 *      step with its confirmation mode (`propose` | `rePropose` | `execute` |
 *      `exhausted`) based on pending-confirmation state at batch-start. This
 *      decision is *frozen* before any executor runs, so a `propose` written
 *      by step N cannot satisfy an `execute` requested at step N+1 in the same
 *      batch — that's the same-batch bypass safety property.
 *
 *   2. Sequential execution. For each planned step: resolve prereqs against
 *      the running `view`, validate params with the action's Zod schema, call
 *      `executors[action_name](params, selectors[action_name](view))`, fold the
 *      executor's `stateUpdate` into both `view` (for downstream steps in this
 *      batch) and `committed` (for the LangGraph `Command` emitted at the
 *      end). Short-circuit on the first non-ok step.
 *
 * Patches from earlier successful steps land in `committed` even when a later
 * step fails (cumulative commit on partial failure). Mirrors today's
 * one-tool-call-per-Command model where each tool's `Command.update` is
 * applied independently.
 *
 * Mutations opt into a confirmation gate via `actions[name].controller.requiresConfirmation`.
 * The library handles the propose → execute handshake and a library-managed
 * `abort_pending_input` action; pre/post verification (e.g. read-back
 * after a write) is the executor's own concern — no auto-wrapping.
 */
import { tool } from "@langchain/core/tools";
import { Command, getCurrentTaskInput } from "@langchain/langgraph";
import { schemaMetaRegistry } from "@langchain/langgraph/zod";
import { ToolMessage } from "@langchain/core/messages";
import { z } from "zod";
import type {
  ActionDef,
  AgentStepConfig,
  ConfirmationOpts,
  ExecutorResult,
  ExecutorRegistry,
  Selector,
  ControllerHooks,
  VerifierRegistry,
  StepResult,
  RunnerResultBody,
} from "./types.js";
import type { AwaitingInput, CurrentFlow, HandoffRequest, LibraryManagedSlots } from "./state.js";
import {
  resolvePageable,
  applyPagination,
  tryPageFromCache,
  type ResolvedPageable,
  type PagedCache,
} from "./paginate.js";
import {
  HANDOFF_ACTION,
  HANDOFF_ACTION_DESCRIPTION,
  handoffParamsSchema,
  type HandoffSpec,
} from "./handoff.js";
import { formatMessage, resolveSystemMessages, type SystemMessages } from "./messages.js";

/** Internal adapter shape for confirmation gating. The runner reads/writes the
 *  canonical `awaitingInput.kind === "confirmation"` slot; this struct is just
 *  a convenience projection used between `getPending` and `setPendingPatch`. */
interface PendingConfirmation {
  action: string;
  params: Record<string, unknown>;
  attemptsLeft: number;
}

/** Selectors and executors are registered 1:1 under their action name — no name
 *  transformation. The registry key IS the action name.
 *
 *  Loosely-typed *supertypes* of the public, per-action-typed shapes, used
 *  inside the runner — which indexes actions/selectors/executors by a runtime
 *  string. They are deliberate supertypes (not casts-through-unknown): any
 *  precise `AgentStepConfig` / `SelectorRegistry` / `ExecutorRegistry` assigns to
 *  them directly. The executor `state` param and selector return are contravariant
 *  / covariant respectively, so `any` is the only param type to which every
 *  concrete slice is assignable — a real `unknown`/`{}` would reject the
 *  assignment and force an `as unknown as` double-cast. The `any` is confined to
 *  these dispatch-boundary aliases; per-action safety is enforced at the
 *  `BuildAgentStepToolOptions` construction boundary. */
type AnyActionDef = ActionDef<string>;
type AnySelector = (state: any) => unknown;
type AnyExecutor = (params: unknown, state: any) => Promise<ExecutorResult<any>>;
interface AnyConfig {
  tool: { name: string; description: string };
  actions: Record<string, AnyActionDef>;
}

/** Minimal shape of a LangGraph `Annotation.Root` we depend on: a `spec` map.
 *  Channels are typed as `unknown` because LangGraph's `BaseChannel` doesn't
 *  expose its operator in a structurally-typed way. The merger extracts the
 *  reducer at runtime via a cast — `BinaryOperatorAggregate` exposes
 *  `operator`, `LastValue` has none (replace-on-write). */
interface LangGraphAnnotationLike {
  spec: Record<string, unknown>;
}

/** The host's state schema, accepted in either supported form:
 *  - a LangGraph `Annotation.Root` (channels live on `.spec`), or
 *  - a Zod object schema whose fields carry reducer/default metadata via
 *    `withLangGraph` (channels are derived through the langgraph zod registry).
 *  Both resolve to the same channel classes, so the merger treats them
 *  uniformly. */
export type StateSchemaLike = LangGraphAnnotationLike | z.ZodObject<z.ZodRawShape>;

/** Get the `{ field: channel }` map for either schema form. An `Annotation.Root`
 *  exposes it directly on `.spec`; a Zod object is converted through the public
 *  langgraph zod registry, which yields the SAME channel classes
 *  (`BinaryOperatorAggregate` / `LastValue`). */
function channelsOf(stateSchema: StateSchemaLike): Record<string, unknown> {
  if ("spec" in stateSchema && (stateSchema as LangGraphAnnotationLike).spec) {
    return (stateSchema as LangGraphAnnotationLike).spec;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return schemaMetaRegistry.getChannelsForSchema(stateSchema as any) as Record<string, unknown>;
}

/** Derive a `(a, b) => merged` patch merger from a host state schema by invoking
 *  each channel's reducer (`BinaryOperatorAggregate.operator`). Channels without
 *  an operator (e.g. `LastValue`) get replace-on-write. The `messages` field is
 *  explicitly skipped — the runner emits its own `ToolMessage` at commit time;
 *  merging intermediate messages would double-count. The channel map is resolved
 *  ONCE here (not per merge) and closed over. */
function buildMergerFromStateSchema<T>(
  stateSchema: StateSchemaLike,
): (a: Partial<T>, b: Partial<T>) => Partial<T> {
  const channels = channelsOf(stateSchema);
  return (a, b) => {
    const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
    for (const [field, channel] of Object.entries(channels)) {
      if (field === "messages") continue;
      const bv = (b as Record<string, unknown>)[field];
      if (bv === undefined) continue;
      const av = (a as Record<string, unknown>)[field];
      const operator = (channel as { operator?: (a: unknown, b: unknown) => unknown })
        .operator;
      out[field] = typeof operator === "function" ? operator(av, bv) : bv;
    }
    return out as Partial<T>;
  };
}

/** Reserved action name auto-injected by the library when any action declares
 *  a library-managed gate (`requiresConfirmation`, `requiresOtp`, `issuesOtp`,
 *  `startsFlow`, `endsFlow`, `requiresFlow`). Clears both `awaitingInput` and
 *  `currentFlow`. Disallowed in user-defined `config.actions`. */
const ABORT_ACTION = "abort_pending_input";

/** DEFAULT number of consecutive backend-failure batches before the runner
 *  triggers an automatic handoff. Overridable per-call via
 *  `BuildAgentStepToolOptions.errorHandoffThreshold`. Resets to zero on any
 *  batch that does not end in a backend failure. */
const ERROR_HANDOFF_THRESHOLD = 3;

/** Applied when `requiresConfirmation: true` is set bare (no opts object) and
 *  as the fill-in for any field omitted from an explicit opts object. */
const CONFIRMATION_DEFAULTS: Required<ConfirmationOpts> = {
  maxAttempts: 3,
  ttlMs: 300_000,   // unused — the runner never reads this; see ConfirmationOpts.ttlMs (inert)
  lockdown: true,
};

function normalizeConfirmation(
  v: boolean | ConfirmationOpts | undefined,
): Required<ConfirmationOpts> | null {
  if (!v) return null;
  if (v === true) return { ...CONFIRMATION_DEFAULTS };
  return {
    maxAttempts: v.maxAttempts ?? CONFIRMATION_DEFAULTS.maxAttempts,
    ttlMs: v.ttlMs ?? CONFIRMATION_DEFAULTS.ttlMs,
    lockdown: v.lockdown ?? CONFIRMATION_DEFAULTS.lockdown,
  };
}

/** Read the awaiting confirmation as a `PendingConfirmation` (drops the
 *  discriminator + max_attempts, retains the fields plan-expansion needs).
 *  Returns null if no confirmation is awaiting. */
function getPending<T>(view: Partial<T>): PendingConfirmation | null {
  const awaiting = getAwaitingInput(view);
  if (!awaiting || awaiting.kind !== "confirmation") return null;
  return {
    action: awaiting.for_action,
    params: awaiting.params,
    attemptsLeft: awaiting.attempts_left,
  };
}

function getAwaitingInput<T>(view: Partial<T>): AwaitingInput | null {
  return ((view as { awaitingInput?: AwaitingInput | null }).awaitingInput) ?? null;
}

function getCurrentFlow<T>(view: Partial<T>): CurrentFlow | null {
  return (
    ((view as { currentFlow?: CurrentFlow | null }).currentFlow) ?? null
  );
}

// Slot-patch helpers: each returns `Partial<T>` where `T extends
// LibraryManagedSlots`. The literal-to-Partial<T> conversion uses the
// up-cast variant `as Partial<T>` (legitimate per the codebase rule —
// the source is structurally a subset of the target; the up-cast is
// needed only because TypeScript can't verify generic variance over
// `Partial<>`).

/** Phase 2: `awaitingInput` is the sole source of truth for confirmation
 *  gating. The legacy `pendingConfirmation` field is gone. */
function clearPendingPatch<T extends LibraryManagedSlots>(): Partial<T> {
  return { awaitingInput: null } as Partial<T>;
}

function setPendingPatch<T extends LibraryManagedSlots>(
  pending: PendingConfirmation,
  max_attempts: number,
): Partial<T> {
  const awaitingInput: AwaitingInput = {
    kind: "confirmation",
    for_action: pending.action,
    params: pending.params,
    attempts_left: pending.attemptsLeft,
    max_attempts,
  };
  return { awaitingInput } as Partial<T>;
}

/** Drop both library-managed slots together. Used by the unified abort
 *  action and by `lifecycle.abortFlow` (terminal failure). */
function clearAllPatch<T extends LibraryManagedSlots>(): Partial<T> {
  return { awaitingInput: null, currentFlow: null } as Partial<T>;
}

/** Build a patch that sets `currentFlow` to `{ name, data }`. If a flow is
 *  already active with the same name, the patch deep-merges `data` into
 *  existing data (caller is responsible for passing the merged map). */
function setCurrentFlowPatch<T extends LibraryManagedSlots>(
  name: string,
  data: Record<string, unknown>,
): Partial<T> {
  const flow: CurrentFlow = { name, data };
  return { currentFlow: flow } as Partial<T>;
}

function setAwaitingOtpPatch<T extends LibraryManagedSlots>(
  forAction: string,
  flowRef: string,
): Partial<T> {
  const awaitingInput: AwaitingInput = {
    kind: "otp",
    for_action: forAction,
    flow_ref: flowRef,
  };
  return { awaitingInput } as Partial<T>;
}

function setAwaitingMatchPatch<T extends LibraryManagedSlots>(
  forAction: string,
  attemptsLeft: number,
  maxAttempts: number,
  flowRef?: string,
): Partial<T> {
  const awaitingInput: AwaitingInput = {
    kind: "match",
    for_action: forAction,
    attempts_left: attemptsLeft,
    max_attempts: maxAttempts,
    ...(flowRef ? { flow_ref: flowRef } : {}),
  };
  return { awaitingInput } as Partial<T>;
}

function clearAwaitingInputPatch<T extends LibraryManagedSlots>(): Partial<T> {
  return { awaitingInput: null } as Partial<T>;
}

/** Default match-attempts budget when `requiresMatch.maxAttempts` is omitted. */
const MATCH_DEFAULT_MAX_ATTEMPTS = 3;

/** Deep recursive copy that sorts every object's keys. Used to make
 *  `JSON.stringify` order-stable so two params payloads with the same
 *  field values but different insertion order compare equal. */
function canonicalize(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(canonicalize);
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = canonicalize(obj[k]);
  return out;
}

/** Deep value equality over canonicalized JSON shapes. Used for the
 *  propose→execute params match and for `invalidatesOnChange` change
 *  detection (a fresh-but-value-equal object write is NOT a change —
 *  reference identity must never count). */
function paramsEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
}

/** Drives the "did the customer re-call with the SAME params?" decision —
 *  matching params means propose → execute; drifted params means re-propose
 *  (decrement attemptsLeft). The pending side was stored PARSED (schema
 *  preprocess applied), so the incoming RAW params are parsed with the same
 *  schema before comparing — value normalization (e.g. a `z.preprocess`
 *  stripping STT separators: "70,76" ≡ "7076") must never read as drift.
 *  A failed parse counts as drift; the re-propose branch then surfaces
 *  `invalid_params`. */
function paramsMatchPending(
  action: AnyActionDef,
  pendingParams: unknown,
  rawIncoming: unknown,
): boolean {
  const parsed = effectiveParamsSchema(action).safeParse(rawIncoming);
  if (!parsed.success) return false;
  return paramsEqual(pendingParams, parsed.data);
}

export interface BuildAgentStepToolOptions<
  T extends LibraryManagedSlots,
  ActionName extends string,
  PrereqName extends string,
  Selectors extends Record<ActionName, Selector<T>>,
> {
  config: AgentStepConfig<ActionName, PrereqName>;
  /** The host's state schema — a LangGraph `Annotation.Root` OR a Zod object
   *  whose fields carry reducer/default metadata via `withLangGraph`. The library
   *  derives the intra-batch merger from each channel's reducer; `messages` is
   *  skipped. Exactly one of `stateSchema` / `stateAnnotation` must be set. */
  stateSchema?: StateSchemaLike;
  /** @deprecated since 1.7.0 — use `stateSchema` (which also accepts a Zod
   *  object). Retained as an accepted alias; the runner reads whichever is set. */
  stateAnnotation?: StateSchemaLike;
  /** State selectors keyed 1:1 by action name. The runner runs the selector for
   *  the step's action and hands its return to the executor as `state`. */
  selectors: Selectors;
  /** Executors keyed 1:1 by action name. Each entry's `state` param is typed
   *  from its selector's return, so an executor that doesn't match what its
   *  selector produces fails to compile here, at the construction boundary. */
  executors: ExecutorRegistry<T, Selectors>;
  verifiers: VerifierRegistry<T>;
  /** Opt into the library-managed handoff: auto-injects the built-in
   *  `request_handoff` action (sole-step, no prereqs) whose only effect is
   *  writing the `handoff` state slot. The slot is RESOLVED by the host
   *  graph's handoff node (`createHandoffNode(spec)` from handoff.ts) — the
   *  runner never performs the terminate/delegate I/O itself. */
  handoff?: HandoffSpec<T>;
  /** Optional overrides for the runner's own system `summary` strings (executor
   *  error, invalid params, abort, flow gates). Shallow-merged over
   *  `DEFAULT_SYSTEM_MESSAGES` (neutral English). A host with localized /
   *  voice-safe wording (e.g. a TTS agent) injects it here; omit to use the
   *  defaults. The library never imports host strings — see messages.ts. */
  messages?: Partial<SystemMessages>;
  /** Called when the consecutive backend-failure counter reaches the threshold
   *  (`errorHandoffThreshold`, default 3). The host uses this to inject its
   *  preferred handoff signal into `update` (e.g. write a custom slot). Runs in
   *  addition to the library-managed `handoff` slot write when `handoff` is also
   *  provided — projects that use only a custom mechanism omit `handoff` and
   *  rely solely on this callback. */
  onErrorThreshold?: (update: Record<string, unknown>, state: T) => void;
  /** Executor-returned verdict `error` codes that count as a backend/network
   *  failure for the auto-handoff counter, IN ADDITION to the runner-raised
   *  `executor_error` (which always counts). List only true backend/network
   *  failures — user mistakes and business-logic refusals must NOT be listed,
   *  or the counter will escalate recoverable situations. */
  backendFailureCodes?: string[];
  /** Consecutive backend-failure batches before the runner auto-triggers a
   *  handoff. Default `ERROR_HANDOFF_THRESHOLD` (3). */
  errorHandoffThreshold?: number;
}

interface PlannedStep {
  action: string;
  params: unknown;
}

export interface RunResult<T> {
  body: RunnerResultBody;
  committed: Partial<T>;
}

function validateConfig(opts: {
  config: AnyConfig;
  stateSchema?: unknown;
  stateAnnotation?: unknown;
  selectors: Record<string, unknown>;
  executors: Record<string, unknown>;
  verifiers: Record<string, unknown>;
  handoff?: unknown;
}): void {
  const { config, selectors, executors, verifiers } = opts;
  // Fail at CONSTRUCTION, not on the first tool call — since 1.7.0 made both
  // options optional in the type, this is the only guard, and a miswired tool
  // must surface at startup. (runSteps re-checks for direct callers.)
  if (!opts.stateSchema && !opts.stateAnnotation) {
    throw new Error(
      "agent-step: buildAgentStepTool requires `stateSchema` (the deprecated `stateAnnotation` is also accepted).",
    );
  }
  const actionNames = Object.keys(config.actions);
  // `abort_pending_input` is always reserved. `request_handoff` is reserved
  // ONLY when the library handoff is opted into — a tool that does NOT pass
  // `handoff` may define its own action under that name (the scaffold
  // tool-action mechanism predates the built-in and uses it).
  const reservedNames = opts.handoff ? [ABORT_ACTION, HANDOFF_ACTION] : [ABORT_ACTION];
  for (const reserved of reservedNames) {
    if (actionNames.includes(reserved)) {
      throw new Error(
        `agent-step: "${reserved}" is a reserved action name auto-injected by the library; remove it from config.actions.`,
      );
    }
  }
  for (const a of actionNames) {
    const action = config.actions[a];
    // Selectors and executors are registered 1:1 under the action name.
    if (typeof selectors[a] !== "function") {
      throw new Error(
        `agent-step: action "${a}" expects a state selector at selectors["${a}"] but none was found.`,
      );
    }
    if (typeof executors[a] !== "function") {
      throw new Error(
        `agent-step: action "${a}" expects an executor at executors["${a}"] but none was found.`,
      );
    }
    if (typeof action.description !== "string" || action.description.length === 0) {
      throw new Error(
        `agent-step: action "${a}" is missing a non-empty description.`,
      );
    }
    for (const p of action.prereqs) {
      if (!verifiers[p]) {
        throw new Error(
          `agent-step: action "${a}" lists prereq "${p}" but verifiers["${p}"] was not provided.`,
        );
      }
    }
  }
  if (actionNames.length === 0) {
    throw new Error("agent-step: at least one action must be defined.");
  }
}

/** True if any action opts into a library-managed gate or flow lifecycle —
 *  triggers the auto-inject of `abort_pending_input` into the schema. */
function hasAnyLifecycleOpt(config: AnyConfig): boolean {
  for (const action of Object.values(config.actions)) {
    const opt = (action as { controller?: ControllerHooks }).controller;
    if (!opt) continue;
    if (
      opt.requiresConfirmation ||
      opt.requiresOtp ||
      opt.issuesOtp ||
      opt.startsFlow ||
      opt.endsFlow ||
      opt.requiresFlow ||
      opt.requiresMatch ||
      opt.startsMatchFor
    ) {
      return true;
    }
  }
  return false;
}

/** Page params the runner injects into a `pageable` action's schema, so the
 *  consumer never declares them. */
const PAGE_PARAMS = {
  page: z.number().int().positive().optional(),
  pageSize: z.number().int().positive().optional(),
};

/** The params schema actually validated for an action — its declared schema,
 *  plus `page`/`pageSize` when the action is `pageable`. Pageable actions must
 *  use a `z.object` schema so the page params can be merged in. */
function effectiveParamsSchema(action: ActionDef<string>): z.ZodTypeAny {
  if (!resolvePageable(action.pageable)) return action.paramsSchema;
  const schema = action.paramsSchema;
  if (!(schema instanceof z.ZodObject)) {
    throw new Error(
      `agent-step: pageable action's paramsSchema must be a z.object (got ${schema?.constructor?.name ?? typeof schema}).`,
    );
  }
  return (schema as z.ZodObject<z.ZodRawShape>).extend(PAGE_PARAMS);
}

function buildStepSchema(
  config: AnyConfig,
  handoffEnabled: boolean,
  handoffActionDescription?: string,
) {
  const actionNames = Object.keys(config.actions);
  const stepVariants = actionNames.map((name) => {
    const action = config.actions[name];
    return z
      .object({ action: z.literal(name), params: effectiveParamsSchema(action) })
      .describe(action.description);
  });
  if (hasAnyLifecycleOpt(config)) {
    stepVariants.push(
      z
        .object({ action: z.literal(ABORT_ACTION), params: z.object({}) })
        .describe(
          "Abort whatever the customer is currently being asked for (confirmation, OTP) and drop any active multi-turn flow. Idempotent — no-op when nothing is pending. Use when the customer pivots away from a pending confirmation/OTP or explicitly cancels the in-progress flow.",
        ) as (typeof stepVariants)[number],
    );
  }
  if (handoffEnabled) {
    stepVariants.push(
      z
        .object({ action: z.literal(HANDOFF_ACTION), params: handoffParamsSchema })
        .describe(
          handoffActionDescription ?? HANDOFF_ACTION_DESCRIPTION,
        ) as (typeof stepVariants)[number],
    );
  }
  const StepSchema =
    stepVariants.length === 1
      ? stepVariants[0]
      : z.discriminatedUnion(
          "action",
          stepVariants as [
            (typeof stepVariants)[number],
            ...(typeof stepVariants)[number][],
          ],
        );
  // NOTE: no `.min(1)` — `minItems` is not permitted under OpenAI strict
  // structured outputs. An empty batch is handled gracefully by `runSteps`
  // (the step loops are length-guarded and simply produce no results).
  return z.object({
    steps: z.array(StepSchema),
  });
}

/** Compose the LangChain tool's `description` field from the config's lead
 *  paragraph plus a bulleted list of per-action summaries. The Zod schema
 *  carries the same per-action descriptions via `.describe()`. */
function composeToolDescription(config: AnyConfig, handoffEnabled: boolean): string {
  const lead = config.tool.description.trim();
  const lines = [lead, "", "Actions:"];
  // Index of actions only. The full per-action mechanics (`description`) reach
  // the model through the schema variant's `.describe()` (see buildStepSchema),
  // so we never repeat it here — at most a one-line `summary`.
  for (const [name, action] of Object.entries(config.actions) as [
    string,
    { summary?: string },
  ][]) {
    const summary = action.summary?.trim();
    lines.push(summary ? `- \`${name}\`: ${summary}` : `- \`${name}\``);
  }
  if (hasAnyLifecycleOpt(config)) {
    lines.push(
      `- \`${ABORT_ACTION}\`: abort any pending confirmation/OTP and drop the active flow (idempotent).`,
    );
  }
  if (handoffEnabled) {
    lines.push(
      `- \`${HANDOFF_ACTION}\`: hand the conversation off instead of answering (sole step, no prereqs).`,
    );
  }
  return lines.join("\n");
}

/** Confirm-mode state machine assigned during plan expansion:
 *  - `propose`: no pending exists for this action → store params, return
 *    needs_confirmation, do NOT call executor.
 *  - `rePropose`: pending exists with different params → overwrite params,
 *    decrement attemptsLeft, return needs_confirmation.
 *  - `execute`: pending exists with matching params → clear pending, run
 *    the executor (standard prereq + params + invoke flow).
 *  - `exhausted`: pending exists with `attemptsLeft <= 0` → clear pending,
 *    return error. Customer must restart the operation.
 *
 *  Mutations without `requiresConfirmation` skip this machine entirely —
 *  they run as a normal single step (subject to `soleStep`). */
type ConfirmMode = "propose" | "rePropose" | "execute" | "exhausted";

interface ConfirmAwarePlannedStep extends PlannedStep {
  confirmMode?: ConfirmMode;
  proposeAttemptsLeft?: number;
}

/** Pure execution of a planned/declared batch given an explicit initial state.
 *  Tool-binding wraps this with the LangGraph state-input read and the Command
 *  emission. */
export async function runSteps<
  T extends LibraryManagedSlots,
  ActionName extends string,
  PrereqName extends string,
  Selectors extends Record<ActionName, Selector<T>>,
>(
  opts: BuildAgentStepToolOptions<T, ActionName, PrereqName, Selectors>,
  userSteps: { action: string; params: unknown }[],
  initialState: T,
): Promise<RunResult<T>> {
  const { verifiers } = opts;
  const stateSchema = opts.stateSchema ?? opts.stateAnnotation;
  if (!stateSchema) {
    throw new Error(
      "agent-step: buildAgentStepTool requires `stateSchema` (the deprecated `stateAnnotation` is also accepted).",
    );
  }
  // Widen to the erased supertypes for the execution loop, which indexes
  // actions, selectors and executors by a runtime string. Plain assignments (no
  // cast) — the precise typing already did its job at the construction boundary;
  // here we build each executor's slice dynamically by running its selector.
  const config: AnyConfig = opts.config;
  const selectors: Record<string, AnySelector> = opts.selectors;
  const executors: Record<string, AnyExecutor> = opts.executors;
  const handoffEnabled = opts.handoff != null;
  const mergeState = buildMergerFromStateSchema<T>(stateSchema);
  // Runner-emitted `summary` strings: host overrides shallow-merged over the
  // neutral English defaults (see messages.ts). No host import in the library.
  const msgs = resolveSystemMessages(opts.messages);

  // `view` is the in-batch threaded snapshot: each step's `stateUpdate` folds
  // into it so the next step sees a fresh state. `committed` accumulates the
  // same patches and becomes the LangGraph `Command.update` returned to the
  // graph. Splitting them means earlier successful updates land even when a
  // later step in the batch fails (cumulative commit on partial failure).
  let view: Partial<T> = mergeState({}, (initialState ?? {}) as Partial<T>);
  let committed: Partial<T> = {};

  // ─── Unknown-action defense. The LangChain wrapper validates input against
  //     the Zod discriminated-union before runSteps runs, so production
  //     traffic can't reach here. But runSteps is also the public test seam
  //     and is callable directly by non-LangChain consumers — guard against
  //     hallucinated/typo'd action names with a structured refusal instead of
  //     a crash (executor lookup would otherwise dereference undefined).
  for (let i = 0; i < userSteps.length; i++) {
    const name = userSteps[i].action;
    if (name === ABORT_ACTION) continue;
    if (name === HANDOFF_ACTION && handoffEnabled) continue;
    if (config.actions[name]) continue;
    const summary = msgs.unknown_action;
    const body: RunnerResultBody = {
      summary,
      results: [
        {
          action: name,
          ok: false,
          summary,
          error: "unknown_action",
        },
      ],
      failed_at: 0,
    };
    return { body, committed };
  }

  // Pre-flight check order: input lockdown → flow mutex → soleStep → plan
  // expansion → sequential execution. Each phase is a separate refusal /
  // transformation that can short-circuit the rest.
  //
  // No library-side TTL on any slot — confirmation and OTP are both
  // conversation-driven. Stale state is cleared by `abort_pending_input` or
  // backend signals; the runner doesn't time anything out on its own.

  // ─── Input lockdown: if anything is awaiting customer input, the batch's
  //     first step must be either the targeted `for_action` (which the per-
  //     step branching will resolve to execute / re-propose / exhausted for
  //     confirmation, or just run the validator for OTP / match) or the
  //     unified `abort_pending_input` action. Match additionally allows the
  //     capturer of the consumer so the customer can re-capture (e.g. enter
  //     a different first PIN). Abort may be the first step of a multi-step
  //     batch — subsequent steps run after the gate is cleared.
  const awaiting = getAwaitingInput(view);
  if (awaiting) {
    let isLocked = true;
    if (awaiting.kind === "confirmation") {
      const m = config.actions[awaiting.for_action]?.controller;
      const confirm = normalizeConfirmation(m?.requiresConfirmation);
      // Confirmation lockdown defaults to true and is overridable by opts.
      isLocked = confirm?.lockdown !== false;
    }
    // OTP and match lockdown are always on — no opt to disable.
    if (isLocked) {
      const first = userSteps[0];
      // For match: also allow the capturer (the action whose startsMatchFor
      // targets this consumer) so the customer can re-capture the first
      // entry without aborting the flow.
      let capturer: string | null = null;
      if (awaiting.kind === "match") {
        const consumer = config.actions[awaiting.for_action]?.controller;
        if (consumer?.requiresMatch) {
          capturer = consumer.requiresMatch.capturer;
        }
      }
      const allowed =
        !!first &&
        (first.action === awaiting.for_action ||
          first.action === ABORT_ACTION ||
          // A handoff abandons the conversation path entirely — it must work
          // even while a confirmation/OTP/match is pending.
          (handoffEnabled && first.action === HANDOFF_ACTION) ||
          (capturer !== null && first.action === capturer));
      if (!allowed) {
        const errorCode =
          awaiting.kind === "confirmation"
            ? "pending_confirmation_locked"
            : awaiting.kind === "otp"
              ? "otp_pending_locked"
              : "match_pending_locked";
        const lockdownVars = {
          action: awaiting.for_action,
          abort_action: ABORT_ACTION,
          capturer: capturer ?? "",
        };
        const summary =
          awaiting.kind === "confirmation"
            ? formatMessage(msgs.lockdown_confirmation, lockdownVars)
            : awaiting.kind === "otp"
              ? formatMessage(msgs.lockdown_otp, lockdownVars)
              : formatMessage(msgs.lockdown_match, lockdownVars);
        const body: RunnerResultBody = {
          summary,
          results: [
            {
              action: first?.action ?? "(empty)",
              ok: false,
              summary,
              error: errorCode,
              awaiting: { kind: awaiting.kind, for_action: awaiting.for_action },
            },
          ],
          failed_at: 0,
        };
        return { body, committed };
      }
    }
  }

  // ─── Flow mutex: if the first step opens a flow (`startsFlow`) but a
  //     different flow is already active, refuse. `startsFlow` is idempotent
  //     within the same flow — the executor will re-run (e.g. to re-issue an
  //     OTP via `request_*`) without resetting `currentFlow.data`.
  const currentFlow = getCurrentFlow(view);
  if (currentFlow && userSteps[0]) {
    const m0 = config.actions[userSteps[0].action]?.controller;
    if (m0?.startsFlow && m0.startsFlow.name !== currentFlow.name) {
      const summary = msgs.flow_already_active;
      const body: RunnerResultBody = {
        summary,
        results: [
          {
            action: userSteps[0].action,
            ok: false,
            summary,
            error: "flow_already_active",
            active_flow: currentFlow.name,
          },
        ],
        failed_at: 0,
      };
      return { body, committed };
    }
  }

  // ─── Handoff exclusivity: `request_handoff` abandons the turn, so a batch
  //     mixing it with anything else is incoherent (`[list_x, request_handoff]`
  //     would half-execute work whose result nobody will see). Refuse.
  if (handoffEnabled && userSteps.length > 1) {
    const handoffIdx = userSteps.findIndex((s) => s.action === HANDOFF_ACTION);
    if (handoffIdx >= 0) {
      const summary = formatMessage(msgs.handoff_must_be_sole_step, {
        action: HANDOFF_ACTION,
      });
      const body: RunnerResultBody = {
        summary,
        results: [
          {
            action: HANDOFF_ACTION,
            ok: false,
            summary,
            error: "handoff_must_be_sole_step",
          },
        ],
        failed_at: 0,
      };
      return { body, committed };
    }
  }

  // ─── soleStep / soleOnExecute refusal. Distinct from lockdown — lockdown
  //     bars unrelated actions *across turns* while pending; these opts bar
  //     them *within a single batch*.
  //     - `soleStep`: strict — refuse any batch larger than 1 containing this
  //       action, regardless of confirm-mode.
  //     - `soleOnExecute`: relaxed — propose/re-propose modes may ride along
  //       (but only as the last step); execute mode must be alone. Lets the
  //       LLM batch `[reads..., propose-mutation]` in one tool call.
  //     We use batch-start pending to predict execute-vs-propose since plan
  //     expansion freezes confirm-mode at batch-start anyway.
  const soleCheckPending = getPending(view);
  for (let i = 0; i < userSteps.length; i++) {
    const s = userSteps[i];
    const m = config.actions[s.action]?.controller;
    if (!m) continue;
    if (m.soleStep && userSteps.length > 1) {
      const summary = formatMessage(msgs.mutation_must_be_sole_step, { action: s.action });
      const body: RunnerResultBody = {
        summary,
        results: [
          {
            action: s.action,
            ok: false,
            summary,
            error: "mutation_must_be_sole_step",
          },
        ],
        failed_at: 0,
      };
      return { body, committed };
    }
    if (m.soleOnExecute && !m.soleStep && userSteps.length > 1) {
      const isExecute =
        !!soleCheckPending &&
        soleCheckPending.action === s.action &&
        paramsMatchPending(config.actions[s.action], soleCheckPending.params, s.params);
      if (isExecute) {
        const summary = formatMessage(msgs.mutation_execute_must_be_sole, {
          action: s.action,
        });
        const body: RunnerResultBody = {
          summary,
          results: [
            {
              action: s.action,
              ok: false,
              summary,
              error: "mutation_must_be_sole_step",
            },
          ],
          failed_at: 0,
        };
        return { body, committed };
      }
      if (i !== userSteps.length - 1) {
        const summary = formatMessage(msgs.mutation_must_be_last_in_batch, {
          action: s.action,
        });
        const body: RunnerResultBody = {
          summary,
          results: [
            {
              action: s.action,
              ok: false,
              summary,
              error: "mutation_must_be_last_in_batch",
            },
          ],
          failed_at: 0,
        };
        return { body, committed };
      }
    }
  }

  // ─── Plan expansion: tag each user step with its confirmation mode based
  //     on pending state RIGHT NOW (i.e. at batch-start). We deliberately do
  //     not re-read pending after each step is planned — that's what blocks
  //     the same-batch propose-then-execute bypass: a propose written by
  //     step 0 cannot be observed by step 1's planning, so step 1 also gets
  //     `propose` rather than `execute`. The model must wait for a NEW tool
  //     call (next turn) to see the pending and re-call with matching params.
  //
  //     Mutations without `requiresConfirmation` skip this branch entirely
  //     and run as a normal single step. There is no library-side pre/post
  //     wrapping — read-back verification (if any) is the executor's concern.
  const planned: ConfirmAwarePlannedStep[] = [];
  for (const s of userSteps) {
    if (s.action === ABORT_ACTION || (handoffEnabled && s.action === HANDOFF_ACTION)) {
      planned.push({ action: s.action, params: s.params });
      continue;
    }
    const m = config.actions[s.action]?.controller;
    const confirm = normalizeConfirmation(m?.requiresConfirmation);
    if (m && confirm) {
      const p = getPending(view);
      if (!p || p.action !== s.action) {
        planned.push({
          action: s.action,
          params: s.params,
          confirmMode: "propose",
          proposeAttemptsLeft: confirm.maxAttempts,
        });
        continue;
      }
      if (paramsMatchPending(config.actions[s.action], p.params, s.params)) {
        planned.push({ action: s.action, params: s.params, confirmMode: "execute" });
        continue;
      }
      if (p.attemptsLeft > 0) {
        planned.push({
          action: s.action,
          params: s.params,
          confirmMode: "rePropose",
          proposeAttemptsLeft: p.attemptsLeft - 1,
        });
      } else {
        planned.push({ action: s.action, params: s.params, confirmMode: "exhausted" });
      }
      continue;
    }
    planned.push({ action: s.action, params: s.params });
  }

  // ─── Sequential execution. Each iteration may short-circuit the rest:
  //     non-ok executor, prereq denial, param validation failure, or the
  //     `exhausted` confirm-mode all set `failedAt` and break the loop.
  //     The final `summary` on the result body is the last step's summary
  //     (success path) or the failing step's summary (failure path).
  const results: StepResult[] = [];
  let failedAt: number | undefined;
  let lastSummary = "";

  // Snapshot the awaiting-input gate as it stood at BATCH START (before any step
  // in this batch runs). Used to freeze the `requiresMatch` consumer check: a
  // match gate is a human re-affirmation (double-entry), so — like the
  // confirmation gate's same-batch-bypass protection — the repeat must arrive in
  // a SEPARATE turn. A match gate opened by the capturer earlier in this same
  // batch must NOT be consumable by the consumer in the same batch. (The OTP gate
  // is deliberately left in-batch-threadable; see the requiresOtp check, which
  // reads the live view.)
  const batchStartAwaiting = getAwaitingInput(view);

  for (let i = 0; i < planned.length; i++) {
    const step = planned[i];

    // ─── Abort action (library-handled, no executor). Clears any pending
    //     confirmation, awaiting OTP, AND the active flow — unified
    //     "drop whatever the customer was being asked + drop the in-progress
    //     flow." True no-op (no state writes) when nothing was active.
    if (step.action === ABORT_ACTION) {
      const priorAwaiting = getAwaitingInput(view);
      const priorFlow = getCurrentFlow(view);
      const hadSomething = priorAwaiting != null || priorFlow != null;
      if (hadSomething) {
        view = mergeState(view, clearAllPatch<T>());
        committed = mergeState(committed, clearAllPatch<T>());
      }
      const entry: StepResult = {
        action: ABORT_ACTION,
        ok: true,
        summary: hadSomething ? msgs.abort_done : msgs.abort_nothing,
      };
      if (priorAwaiting) {
        entry.aborted_awaiting = {
          kind: priorAwaiting.kind,
          for_action: priorAwaiting.for_action,
        };
      }
      if (priorFlow) {
        entry.aborted_flow = priorFlow.name;
      }
      results.push(entry);
      lastSummary = entry.summary as string;
      continue;
    }

    // ─── Handoff action (library-handled, no user executor). Pure slot write:
    //     validate params, patch the library-managed `handoff` slot, return ok.
    //     No prereqs by design — "transfer me" must work before any data is
    //     loaded. The host graph's handoff node resolves the slot after the
    //     batch commits (event emission + terminate/delegate I/O live there;
    //     the runner stays side-effect-free).
    if (handoffEnabled && step.action === HANDOFF_ACTION) {
      let params: HandoffRequest;
      try {
        params = handoffParamsSchema.parse(step.params);
      } catch (err) {
        const message =
          err instanceof z.ZodError
            ? err.issues.map((iss) => iss.message).join("; ")
            : String(err);
        const entry: StepResult = {
          action: HANDOFF_ACTION,
          ok: false,
          summary: msgs.invalid_params,
          error: "invalid_params",
          _debug: `Invalid params for "${HANDOFF_ACTION}": ${message}`,
        };
        results.push(entry);
        lastSummary = entry.summary as string;
        failedAt = results.length - 1;
        break;
      }
      const patch = {
        handoff: { reason: params.reason, context: params.context },
      } as Partial<T>;
      view = mergeState(view, patch);
      committed = mergeState(committed, patch);
      const summary = formatMessage(msgs.handoff_requested, { reason: params.reason });
      const entry: StepResult = {
        action: HANDOFF_ACTION,
        ok: true,
        summary,
        handoff_requested: true,
        reason: params.reason,
      };
      results.push(entry);
      lastSummary = summary;
      continue;
    }

    const action = config.actions[step.action];
    const stepMutationEarly = config.actions[step.action]?.controller;

    // ─── Library-managed prereqs run BEFORE confirm-mode resolution. A
    //     confirm-required mutation that also `requiresFlow` would otherwise
    //     propose despite the flow being absent, leaving the LLM with a
    //     `needs_confirmation` recap on a doomed action.
    if (stepMutationEarly?.requiresFlow) {
      const flow = getCurrentFlow(view);
      if (!flow) {
        const summary = msgs.no_flow;
        const entry: StepResult = {
          action: step.action,
          ok: false,
          summary,
          error: "no_flow_active",
        };
        results.push(entry);
        lastSummary = summary;
        failedAt = results.length - 1;
        break;
      }
      if (flow.name !== stepMutationEarly.requiresFlow) {
        const summary = msgs.wrong_flow;
        const entry: StepResult = {
          action: step.action,
          ok: false,
          summary,
          error: "wrong_flow",
          active_flow: flow.name,
        };
        results.push(entry);
        lastSummary = summary;
        failedAt = results.length - 1;
        break;
      }
    }

    // ─── User-declared prereqs run BEFORE confirm-mode resolution too. A
    //     confirm-required mutation whose prereqs are not satisfied would
    //     otherwise propose despite being doomed at execute time, leaving the
    //     LLM with a `needs_confirmation` recap on an action the runner will
    //     refuse. Gate propose, re-propose, and execute identically.
    let prereqDeniedEarly = false;
    for (const p of action.prereqs) {
      const verifier = verifiers[p];
      if (!verifier.check(view as T)) {
        const { denial } = verifier;
        const entry: StepResult = {
          action: step.action,
          ok: false,
          summary: denial.summary,
          error: denial.error,
        };
        results.push(entry);
        lastSummary = denial.summary;
        failedAt = results.length - 1;
        prereqDeniedEarly = true;
        break;
      }
    }
    if (prereqDeniedEarly) break;

    // ─── Confirm-required propose / re-propose: validate params, store pending,
    // ─── return needs_confirmation without invoking the executor.
    if (step.confirmMode === "propose" || step.confirmMode === "rePropose") {
      // Parse with the SAME schema the execute-decision compares against
      // (paramsMatchPending) so stored pending params and re-fired params are
      // normalized identically. Raw Zod detail goes to `_debug`, never the
      // summary — mirrors the execute-path invalid_params handling.
      let params: unknown;
      try {
        params = effectiveParamsSchema(action).parse(step.params);
      } catch (err) {
        const message =
          err instanceof z.ZodError
            ? err.issues.map((iss) => iss.message).join("; ")
            : String(err);
        const entry: StepResult = {
          action: step.action,
          ok: false,
          summary: msgs.invalid_params,
          error: "invalid_params",
          _debug: `Invalid params for "${step.action}": ${message}`,
        };
        results.push(entry);
        lastSummary = entry.summary as string;
        failedAt = results.length - 1;
        break;
      }
      const m = config.actions[step.action]?.controller;
      const confirm = normalizeConfirmation(m?.requiresConfirmation);
      const maxAttempts = confirm?.maxAttempts ?? CONFIRMATION_DEFAULTS.maxAttempts;
      const attemptsLeft = step.proposeAttemptsLeft ?? maxAttempts;
      const newPending: PendingConfirmation = {
        action: step.action,
        params: params as Record<string, unknown>,
        attemptsLeft,
      };
      view = mergeState(view, setPendingPatch<T>(newPending, maxAttempts));
      committed = mergeState(committed, setPendingPatch<T>(newPending, maxAttempts));
      const summary =
        step.confirmMode === "propose"
          ? formatMessage(msgs.confirm_proposed, { action: step.action })
          : formatMessage(msgs.confirm_reproposed, { action: step.action });
      const entry: StepResult = {
        action: step.action,
        ok: true,
        summary,
        needs_confirmation: true,
        proposed_params: params as object,
        attempts_left: attemptsLeft,
      };
      results.push(entry);
      lastSummary = summary;
      continue;
    }

    // ─── Confirm-required attempts exhausted: clear pending, return error.
    if (step.confirmMode === "exhausted") {
      view = mergeState(view, clearPendingPatch<T>());
      committed = mergeState(committed, clearPendingPatch<T>());
      const summary = formatMessage(msgs.confirm_exhausted, { action: step.action });
      const entry: StepResult = {
        action: step.action,
        ok: false,
        summary,
        error: "confirmation_attempts_exhausted",
      };
      results.push(entry);
      lastSummary = summary;
      failedAt = results.length - 1;
      break;
    }

    // ─── Execute mode (confirm-required): clear pending atomically before
    // ─── running the executor.
    if (step.confirmMode === "execute") {
      view = mergeState(view, clearPendingPatch<T>());
      committed = mergeState(committed, clearPendingPatch<T>());
    }

    // ─── Library-managed `requiresOtp` prereq (requiresFlow was checked
    //     above before confirm-mode resolution).
    const stepMutation = stepMutationEarly;

    // requiresOtp — refuse if no OTP is awaiting for this action.
    if (stepMutation?.requiresOtp) {
      const awaiting = getAwaitingInput(view);
      const gated =
        !!awaiting &&
        awaiting.kind === "otp" &&
        awaiting.for_action === step.action;
      if (!gated) {
        const summary = formatMessage(msgs.otp_not_pending, { action: step.action });
        const entry: StepResult = {
          action: step.action,
          ok: false,
          summary,
          error: "otp_not_pending",
        };
        results.push(entry);
        lastSummary = summary;
        failedAt = results.length - 1;
        break;
      }
    }

    // requiresMatch — refuse unless a match gate for this action was pending at
    // BATCH START. Frozen to batch-start (not the live view) so a match gate the
    // capturer opens earlier in THIS batch cannot be consumed in the same batch —
    // the double-entry repeat must arrive in a separate turn (mirrors the
    // confirmation same-batch-bypass protection). The legitimate [consumer,
    // issuer] batch is unaffected: the consumer's match gate was opened in a
    // PRIOR turn, so it IS present at batch start.
    if (stepMutation?.requiresMatch) {
      const awaiting = batchStartAwaiting;
      const gated =
        !!awaiting &&
        awaiting.kind === "match" &&
        awaiting.for_action === step.action;
      if (!gated) {
        const summary = formatMessage(msgs.match_not_pending, {
          action: step.action,
          capturer: stepMutation.requiresMatch.capturer,
        });
        const entry: StepResult = {
          action: step.action,
          ok: false,
          summary,
          error: "match_not_pending",
        };
        results.push(entry);
        lastSummary = summary;
        failedAt = results.length - 1;
        break;
      }
    }

    // issuesOtp — refuse to OPEN an OTP gate while a double-entry match is still
    // pending in the LIVE view. Enforces the ordering invariant "at most one input
    // gate at a time, match THEN otp": the match consumer must clear the match
    // before any OTP is issued. Without this, a single batch like [capturer,
    // issuer] would open+send the OTP and OVERWRITE the still-pending match gate,
    // skipping the consumer (the second entry) entirely. Uses the LIVE view (not
    // batch-start) so the legitimate [consumer, issuer] batch still works — the
    // consumer clears the match earlier in the same batch, so by the time the
    // issuer runs no match is pending. Checked PRE-execution so the executor's
    // side effect (e.g. sending a code) never fires on refusal.
    if (stepMutation?.issuesOtp) {
      const awaiting = getAwaitingInput(view);
      if (awaiting && awaiting.kind === "match") {
        const summary = formatMessage(msgs.otp_blocked_match_pending, {
          action: step.action,
          match_action: awaiting.for_action,
        });
        const entry: StepResult = {
          action: step.action,
          ok: false,
          summary,
          error: "otp_blocked_match_pending",
        };
        results.push(entry);
        lastSummary = summary;
        failedAt = results.length - 1;
        break;
      }
    }

    // ─── User-declared prereqs were already checked above (before confirm-
    //     mode resolution) so propose and execute share the same gate.

    // ─── Params. Pageable actions validate against the schema with the
    //     library-injected page/pageSize merged in.
    const pageable: ResolvedPageable | null = resolvePageable(action.pageable);
    let params: unknown;
    try {
      params = effectiveParamsSchema(action).parse(step.params);
    } catch (err) {
      const message =
        err instanceof z.ZodError
          ? err.issues.map((iss) => iss.message).join("; ")
          : String(err);
      const entry: StepResult = {
        action: step.action,
        ok: false,
        summary: msgs.invalid_params,
        error: "invalid_params",
        _debug: `Invalid params for "${step.action}": ${message}`,
      };
      results.push(entry);
      lastSummary = entry.summary as string;
      failedAt = results.length - 1;
      break;
    }

    // ─── Pageable self-paginate cache hit: re-page from the library-managed
    //     `pagedRead` slot WITHOUT calling the executor (no backend re-fetch).
    //     A same-query (same action + signature) call serves the requested page
    //     straight from the cached full set.
    if (pageable?.mode === "self") {
      const cache = (view as { pagedRead?: PagedCache<unknown> | null }).pagedRead ?? null;
      const cachedBody = tryPageFromCache(step.action, pageable, params, cache);
      if (cachedBody) {
        const entry: StepResult = { action: step.action, ok: true, ...cachedBody };
        results.push(entry);
        lastSummary = (cachedBody.summary as string | undefined) ?? lastSummary;
        continue;
      }
    }

    // ─── Snapshot watched-slot values BEFORE the executor runs. Used by the
    //     `invalidatesOnChange` mechanism below to detect post-step changes
    //     and cascade-clear downstream slots.
    const watchMap = action.invalidatesOnChange ?? {};
    const watchedKeys = Object.keys(watchMap);
    const preWatched: Record<string, unknown> = {};
    if (watchedKeys.length > 0) {
      const viewRec = view as Record<string, unknown>;
      for (const k of watchedKeys) preWatched[k] = viewRec[k];
    }

    // ─── Execute. Selector + executor are registered 1:1 under the action
    //     name. The selector projects the running `view` down to the slice this
    //     executor needs, so the executor never sees the whole state — it can't
    //     read anything the selector didn't hand it.
    const selector = selectors[step.action];
    const executor = executors[step.action];
    const slice = selector(view);
    let result: Awaited<ReturnType<typeof executor>>;
    try {
      result = await executor(params, slice);
    } catch (err) {
      // Executors — and the fetchers / backend client they call — throw on hard
      // failures (backend 5xx, non-JSON, a required URL missing). Convert the
      // throw into an ok:false step and short-circuit, exactly like a returned
      // ok:false: the LLM still receives the { summary, results, failed_at }
      // envelope, and every earlier step's stateUpdate stays in `committed`
      // (cumulative commit on partial failure). Without this the throw escapes
      // runSteps, no Command is emitted, and those earlier commits are lost.
      const message = err instanceof Error ? err.message : String(err);
      const entry: StepResult = {
        action: step.action,
        ok: false,
        summary: msgs.executor_error,
        error: "executor_error",
        _debug: `Action "${step.action}" failed: ${message}`,
      } as StepResult;
      results.push(entry);
      lastSummary = entry.summary as string;
      failedAt = results.length - 1;
      break;
    }

    // ─── Pageable transform: turn the executor's result into the uniform page
    //     envelope. SELF slices `resultBody.items` (the full set) and emits a
    //     cache patch; DELEGATE wraps the backend's page using `totalCount`.
    let pageCachePatch: Partial<T> | null = null;
    let entryBody = result.resultBody as Record<string, unknown>;
    if (result.ok && pageable) {
      const outcome = applyPagination(
        step.action,
        pageable,
        params,
        result.resultBody as Record<string, unknown>,
      );
      entryBody = outcome.body;
      pageCachePatch = outcome.cachePatch as Partial<T> | null;
    }

    const entry: StepResult = {
      action: step.action,
      ok: result.ok,
      ...entryBody,
    };
    results.push(entry);

    // ─── Post-execution lifecycle merge. Order matters:
    //     0. `invalidatesOnChange` cascade (applied regardless of ok — clears
    //        declared downstream slots BEFORE the executor's stateUpdate
    //        lands, so the executor's own re-writes (e.g. opportunistic match
    //        on the new amount) overwrite the nulls cleanly.
    //     1. `stateUpdate` (host-state patch — applied regardless of ok).
    //     2. `startsFlow` + `flowData` (ok only — creates/merges currentFlow).
    //     3. `lifecycle.issuesOtp` (ok only — sets awaitingInput=otp).
    //     4. `requiresOtp` / `requiresMatch` auto-clear (ok only — gate
    //        consumed).
    //     5. `startsMatchFor` (ok only — sets awaitingInput=match for
    //        consumer with fresh attempts counter).
    //     6. `endsFlow` (ok only — clears currentFlow + awaitingInput).
    //     7. `lifecycle.clearAwaitingInput` (always — drops awaitingInput).
    //     8. `lifecycle.abortFlow` (always — drops currentFlow + awaitingInput).
    //     On ok:false, the runner additionally handles requiresMatch
    //     mismatch: decrement attempts and abort flow on exhaustion.

    // ─── invalidatesOnChange cascade. For each watched slot the executor's
    //     stateUpdate is changing (pre != null AND pre !== post), clear the
    //     declared downstream slots to null. Applied BEFORE stateUpdate so
    //     the executor's own writes for the same downstream slots win.
    //     First-time set (null → value) does NOT fire. Same-value writes
    //     (no real change) do not fire either.
    if (watchedKeys.length > 0) {
      const stateUpdateRec = (result.stateUpdate ?? {}) as Record<string, unknown>;
      const invalidationPatch: Record<string, unknown> = {};
      for (const watched of watchedKeys) {
        const pre = preWatched[watched];
        if (pre == null) continue;
        if (!(watched in stateUpdateRec)) continue;
        const post = stateUpdateRec[watched];
        // Canonical VALUE equality — executors write fresh objects each run,
        // so reference identity (Object.is) would read a same-value re-write
        // of an object slot as a change and fire a spurious cascade.
        if (paramsEqual(pre, post)) continue;
        for (const downstream of watchMap[watched]) {
          invalidationPatch[downstream] = null;
        }
      }
      if (Object.keys(invalidationPatch).length > 0) {
        view = mergeState(view, invalidationPatch as Partial<T>);
        committed = mergeState(committed, invalidationPatch as Partial<T>);
      }
    }

    if (result.stateUpdate) {
      view = mergeState(view, result.stateUpdate);
      committed = mergeState(committed, result.stateUpdate);
    }

    // Self-paginate cache miss: persist the full set under its query signature
    // so a same-query re-page next turn hits the cache and skips the executor.
    if (pageCachePatch) {
      view = mergeState(view, pageCachePatch);
      committed = mergeState(committed, pageCachePatch);
    }

    if (result.ok) {
      // Determine target flow (existing or new from startsFlow).
      const existingFlow = getCurrentFlow(view);
      let targetFlow: CurrentFlow | null = existingFlow;
      if (stepMutation?.startsFlow) {
        const flowName = stepMutation.startsFlow.name;
        if (!existingFlow) {
          targetFlow = { name: flowName, data: {} };
        } else if (existingFlow.name === flowName) {
          // Idempotent within the same flow — keep existing data.
          targetFlow = existingFlow;
        }
        // else: flow-mutex check above already refused the batch.
      }

      // Merge flowData into the target flow's data (shallow merge).
      if (result.flowData) {
        if (!targetFlow) {
          throw new Error(
            `agent-step: action "${step.action}" returned flowData but no flow is active and the action doesn't declare startsFlow.`,
          );
        }
        targetFlow = {
          name: targetFlow.name,
          data: { ...targetFlow.data, ...result.flowData },
        };
      }

      // Apply currentFlow patch when the target differs from existing.
      if (targetFlow && targetFlow !== existingFlow) {
        const patch = setCurrentFlowPatch<T>(targetFlow.name, targetFlow.data);
        view = mergeState(view, patch);
        committed = mergeState(committed, patch);
      }

      // issuesOtp: set awaitingInput=otp bound to the named consumer action.
      if (result.lifecycle?.issuesOtp) {
        const finalFlow = getCurrentFlow(view);
        if (!finalFlow) {
          throw new Error(
            `agent-step: action "${step.action}" reported lifecycle.issuesOtp but no flow is active.`,
          );
        }
        if (!stepMutation?.issuesOtp) {
          throw new Error(
            `agent-step: action "${step.action}" reported lifecycle.issuesOtp but config lacks issuesOtp opt.`,
          );
        }
        const patch = setAwaitingOtpPatch<T>(
          stepMutation.issuesOtp.consumer_action,
          finalFlow.name,
        );
        view = mergeState(view, patch);
        committed = mergeState(committed, patch);
      }

      // requiresOtp on ok:true → the OTP was consumed; auto-drop awaitingInput.
      if (stepMutation?.requiresOtp) {
        view = mergeState(view, clearAwaitingInputPatch<T>());
        committed = mergeState(committed, clearAwaitingInputPatch<T>());
      }

      // requiresMatch on ok:true → match succeeded; auto-drop awaitingInput.
      if (stepMutation?.requiresMatch) {
        view = mergeState(view, clearAwaitingInputPatch<T>());
        committed = mergeState(committed, clearAwaitingInputPatch<T>());
      }

      // startsMatchFor on ok:true → initialise (or reset) match awaiting for
      // the named consumer with a fresh attempts counter pulled from the
      // consumer's config. Idempotent: re-running the capturer while a match
      // is already awaiting replaces the awaiting slot.
      if (stepMutation?.startsMatchFor) {
        const consumerName = stepMutation.startsMatchFor.consumer_action;
        const consumer = config.actions[consumerName]?.controller;
        if (!consumer?.requiresMatch) {
          throw new Error(
            `agent-step: action "${step.action}" declares startsMatchFor "${consumerName}" but that consumer doesn't declare requiresMatch.`,
          );
        }
        const maxAttempts =
          consumer.requiresMatch.maxAttempts ?? MATCH_DEFAULT_MAX_ATTEMPTS;
        const finalFlow = getCurrentFlow(view);
        const patch = setAwaitingMatchPatch<T>(
          consumerName,
          maxAttempts,
          maxAttempts,
          finalFlow?.name,
        );
        view = mergeState(view, patch);
        committed = mergeState(committed, patch);
      }

      // endsFlow: clear both slots.
      if (stepMutation?.endsFlow) {
        view = mergeState(view, clearAllPatch<T>());
        committed = mergeState(committed, clearAllPatch<T>());
      }
    } else {
      // ok:false path — handle requiresMatch mismatch lifecycle.
      // The executor signals mismatch via `verdict: "match_mismatch"` in the
      // result body (host owns the comparison; library owns the counter).
      // Decrement attempts; on exhaustion, clear awaiting + abort flow.
      if (stepMutation?.requiresMatch) {
        const rb = result.resultBody as { verdict?: string };
        if (rb.verdict === "match_mismatch") {
          const aw = getAwaitingInput(view);
          // The requiresMatch prereq above ensures awaiting is set, but
          // defend defensively in case of unusual call paths.
          if (aw && aw.kind === "match" && aw.for_action === step.action) {
            const remaining = aw.attempts_left - 1;
            if (remaining <= 0) {
              // Exhausted — clear awaiting + abort flow.
              view = mergeState(view, clearAllPatch<T>());
              committed = mergeState(committed, clearAllPatch<T>());
              // Re-shape the result entry to surface exhaustion to the LLM.
              const entryIndex = results.length - 1;
              results[entryIndex] = {
                ...results[entryIndex],
                summary: formatMessage(msgs.match_attempts_exhausted, {
                  action: step.action,
                }),
                error: "match_attempts_exhausted",
                verdict: "match_attempts_exhausted",
                attempts_left: 0,
              };
              lastSummary = results[entryIndex].summary as string;
            } else {
              const patch = setAwaitingMatchPatch<T>(
                aw.for_action,
                remaining,
                aw.max_attempts,
                aw.flow_ref,
              );
              view = mergeState(view, patch);
              committed = mergeState(committed, patch);
              // Enrich the result entry with the decremented counter so the
              // LLM can quote attempts_left to the customer.
              const entryIndex = results.length - 1;
              results[entryIndex] = {
                ...results[entryIndex],
                attempts_left: remaining,
              };
            }
          }
        }
      }
    }

    // Apply regardless of ok — executor-driven gate clearing.
    if (result.lifecycle?.clearAwaitingInput) {
      view = mergeState(view, clearAwaitingInputPatch<T>());
      committed = mergeState(committed, clearAwaitingInputPatch<T>());
    }
    if (result.lifecycle?.abortFlow) {
      view = mergeState(view, clearAllPatch<T>());
      committed = mergeState(committed, clearAllPatch<T>());
    }

    const summary = (result.resultBody as { summary?: string }).summary;
    if (typeof summary === "string") lastSummary = summary;

    if (!result.ok) {
      failedAt = results.length - 1;
      break;
    }
  }

  const body: RunnerResultBody = {
    summary: lastSummary || msgs.no_steps,
    results,
  };
  if (failedAt !== undefined) body.failed_at = failedAt;

  // ─── Error counter + auto-handoff ──────────────────────────────────────
  // Counts consecutive batches whose failing step is a backend/network failure
  // and auto-triggers a handoff once the count reaches the threshold, so a
  // customer is never trapped in an unrecoverable error loop. The runner-raised
  // `executor_error` (an executor threw, uncaught) ALWAYS counts; a host adds
  // its own executor-returned verdict codes via `opts.backendFailureCodes`.
  // List only true backend/network failures there — user mistakes (wrong OTP,
  // value mismatch) and business-logic refusals are recoverable and must NOT be
  // listed. The counter resets to 0 on any batch that does not end in a backend
  // failure. The feature is inert unless a handoff mechanism is available (the
  // `handoff` opt or an `onErrorThreshold` callback).
  const autoHandoffEnabled = handoffEnabled || opts.onErrorThreshold != null;
  if (autoHandoffEnabled) {
    const prevErrorCount =
      ((initialState as Record<string, unknown>).errorCount as number | null | undefined) ?? 0;
    const backendFailureCodes = new Set<string>([
      "executor_error",
      ...(opts.backendFailureCodes ?? []),
    ]);
    const threshold = opts.errorHandoffThreshold ?? ERROR_HANDOFF_THRESHOLD;
    const failedError =
      body.failed_at !== undefined ? body.results[body.failed_at]?.error : undefined;
    const isBackendFailure =
      typeof failedError === "string" && backendFailureCodes.has(failedError);
    const committedRec = committed as Record<string, unknown>;
    if (isBackendFailure) {
      const newErrorCount = prevErrorCount + 1;
      if (newErrorCount >= threshold) {
        // Threshold reached → escalate. Write the library `handoff` slot (when
        // handoff is enabled) and/or let the host inject a custom signal.
        if (handoffEnabled && !committedRec.handoff) {
          committedRec.handoff = {
            reason: "abandon",
            context: msgs.auto_handoff,
          } satisfies HandoffRequest;
        }
        opts.onErrorThreshold?.(committedRec, initialState);
        committedRec.errorCount = 0;
        // Platform-delivers wording: the host graph's handoff resolver speaks
        // the closing (possibly overriding `auto_handoff` from state), so
        // instructing the model to voice it invites double-speaking. Hosts
        // whose graph does NOT deliver it can override the template and use
        // the `{message}` placeholder.
        const handoffInstruction = formatMessage(msgs.auto_handoff_instruction, {
          message: msgs.auto_handoff,
        });
        body.results.push({
          action: "auto_handoff",
          ok: true,
          isHandoff: true,
          signal: "abandon",
          successMessage: msgs.auto_handoff,
          summary: handoffInstruction,
        });
        body.summary = handoffInstruction;
        delete body.failed_at;
      } else {
        committedRec.errorCount = newErrorCount;
      }
    } else if (prevErrorCount > 0) {
      committedRec.errorCount = 0;
    }
  }

  return { body, committed };
}

/** Public entry point. Validates the wiring at construction time, builds the
 *  Zod schema from the action variants, and returns a LangChain tool whose
 *  invocation reads state from LangGraph via `getCurrentTaskInput`, runs the
 *  batch, and emits a `Command` carrying the cumulative state patch plus one
 *  `ToolMessage` with the JSON-stringified result body. */
export function buildAgentStepTool<
  T extends LibraryManagedSlots,
  ActionName extends string,
  PrereqName extends string,
  Selectors extends Record<ActionName, Selector<T>>,
>(opts: BuildAgentStepToolOptions<T, ActionName, PrereqName, Selectors>) {
  validateConfig(opts);
  const InputSchema = buildStepSchema(
    opts.config,
    opts.handoff != null,
    opts.handoff?.actionDescription,
  );

  return tool(
    async (
      input: z.infer<typeof InputSchema>,
      runtime: { toolCall?: { id?: string } } = {},
    ): Promise<Command> => {
      const toolCallId = runtime.toolCall?.id ?? "";
      const userSteps: { action: string; params: unknown }[] = (
        input.steps as Array<{ action: string; params?: unknown }>
      ).map((s) => ({ action: s.action, params: s.params ?? {} }));

      // Snapshot from LangGraph rather than threading the model's view of
      // state. Plan expansion reads pending from this snapshot; this is the
      // same-batch bypass safety net (see comment on plan-expansion phase).
      const initialState = getCurrentTaskInput<T>() as T;
      const { body, committed } = await runSteps(opts, userSteps, initialState);

      // The `Command.update` carries two things: the cumulative state patch
      // accumulated across successful steps, AND exactly one ToolMessage tied
      // to this tool call id. The state annotation's `messages` reducer
      // appends; we never merge intermediate ToolMessages from individual
      // steps because there's only one tool call from LangGraph's POV.
      const update: Record<string, unknown> = { ...committed };
      update.messages = [
        new ToolMessage({ content: JSON.stringify(body), tool_call_id: toolCallId }),
      ];
      return new Command({ update });
    },
    {
      name: opts.config.tool.name,
      description: composeToolDescription(opts.config, opts.handoff != null),
      schema: InputSchema,
    },
  );
}
