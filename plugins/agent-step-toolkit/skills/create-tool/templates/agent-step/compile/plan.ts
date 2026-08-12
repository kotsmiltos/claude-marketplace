// FILE: src/agent-step/compile/plan.ts
//
// The compile phase's product: a `CompiledPlan` — everything the run pipeline
// reads, normalized EXACTLY ONCE. Confirmation defaults, pageable resolution,
// the effective params schema (declared schema + injected page params), the
// control activation, the state-schema merger, and the resolved system
// messages are all computed here; no run-phase code ever re-derives them.
//
// `compilePlan` does NOT validate — `buildAgentStepTool` validates first
// (compile/validate.ts) and then compiles; the direct `runSteps` seam compiles
// leniently so tests can drive minimal configs.

import { z } from "zod";
import type {
  ActionDef,
  AgentStepConfig,
  ConfirmationOpts,
  ControllerHooks,
  ExecutorRegistry,
  ExecutorResult,
  Selector,
  VerifierRegistry,
} from "../types.js";
import type { LibraryManagedSlots } from "../state.js";
import type { SystemMessages } from "../messages.js";
import { resolveSystemMessages } from "../messages.js";
import { resolvePageable, type ResolvedPageable } from "../paginate.js";
import {
  deflectAsideActionDescription,
  deflectAsideEnabled,
  handoffParamsSchema,
  type HandoffSpec,
} from "../handoff/contract.js";
import type { BoundedChoiceRegistry } from "../interaction/bounded-choice.js";
import {
  normalizeConfirmation,
  repeatReadBackEnabled,
} from "../interaction/confirmation.js";
import {
  resolveAbortPolicy,
  type AbortPolicy,
  type ControlAction,
  type ControlActivation,
} from "../controls/contract.js";
import { activeControls } from "../controls/registry.js";
import {
  buildMergerFromStateSchema,
  type PatchMerger,
  type StateSchemaLike,
} from "./state-schema.js";

/** DEFAULT number of consecutive backend-failure batches before the runner
 *  triggers an automatic handoff. Overridable via
 *  `BuildAgentStepToolOptions.errorHandoffThreshold`. */
export const ERROR_HANDOFF_THRESHOLD = 3;

export interface BuildAgentStepToolOptions<
  T extends LibraryManagedSlots,
  ActionName extends string,
  PrereqName extends string,
  Selectors extends Record<ActionName, Selector<T>>,
> {
  config: AgentStepConfig<ActionName, PrereqName>;
  /** The host's state schema — a LangGraph `Annotation.Root` OR a Zod object
   *  whose fields carry reducer/default metadata via `withLangGraph`. The
   *  library derives the intra-batch merger from each channel's reducer;
   *  `messages` is skipped. */
  stateSchema: StateSchemaLike;
  /** State selectors keyed 1:1 by action name. The runner runs the selector for
   *  the step's action and hands its return to the executor as `state`. */
  selectors: Selectors;
  /** Executors keyed 1:1 by action name. Each entry's `state` param is typed
   *  from its selector's return, so an executor that doesn't match what its
   *  selector produces fails to compile here, at the construction boundary. */
  executors: ExecutorRegistry<T, Selectors>;
  verifiers: VerifierRegistry<T>;
  /** Opt into the library-managed handoff: auto-injects the built-in
   *  `request_handoff` control (sole-step, no prereqs), which atomically clears
   *  transient interaction/flow/page state and writes the `handoff` slot. The
   *  slot is RESOLVED by the host graph's handoff node
   *  (`createHandoffNode(spec)` from handoff/node.ts) — the runner never
   *  performs the terminate/delegate I/O itself. */
  handoff?: HandoffSpec<T>;
  /** Optionally narrow the built-in abort control to an engine-enforced
   * in-domain transition. Omit for the legacy permissive/idempotent behavior. */
  abortPolicy?: AbortPolicy<Extract<keyof Selectors, string>>;
  /** Opt into the library's one-shot bounded-choice overlay. This injects the
   *  `request_bounded_choice` and `resolve_bounded_choice` controls without
   *  adding domain actions or replacing a pending confirmation/OTP/match.
   *  The host prompt decides WHEN the configured choice applies; the runner
   *  owns its persisted pending/resolved state and repeat fallback. */
  boundedChoices?: BoundedChoiceRegistry;
  /** Resolve a stable identity for the latest caller turn. Three protections
   *  key on it: bounded-choice resolution records it (fails closed without
   *  one), the choice's offered-this-turn lock compares against it, and the
   *  confirmation gate stamps proposals with it so a matching re-call on the
   *  SAME turn is refused instead of executed (the caller must actually
   *  answer the read-back). By default the runner uses the latest human/user
   *  message id assigned by LangGraph's MessagesAnnotation. Hosts that
   *  compact or replace messages must provide a stable non-compacted turn
   *  token. */
  getCallerTurnId?: (state: T) => string | null | undefined;
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

/** Selectors and executors are registered 1:1 under their action name — no name
 *  transformation. The registry key IS the action name.
 *
 *  Loosely-typed *supertypes* of the public, per-action-typed shapes, used by
 *  the run pipeline — which indexes actions/selectors/executors by a runtime
 *  string. They are deliberate supertypes (not casts-through-unknown): any
 *  precise `SelectorRegistry` / `ExecutorRegistry` assigns to them directly.
 *  The executor `state` param and selector return are contravariant /
 *  covariant respectively, so `any` is the only param type to which every
 *  concrete slice is assignable — a real `unknown`/`{}` would reject the
 *  assignment and force an `as unknown as` double-cast. The `any` is confined
 *  to these dispatch-boundary aliases; per-action safety is enforced at the
 *  `BuildAgentStepToolOptions` construction boundary. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnySelector = (state: any) => unknown;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyExecutor = (params: unknown, state: any) => Promise<ExecutorResult<any>>;

/** One action with every per-action derivation resolved. */
export interface CompiledAction {
  name: string;
  description: string;
  summary?: string;
  prereqs: string[];
  controller: ControllerHooks | undefined;
  /** Normalized confirmation opts, or null when not confirm-gated. */
  confirmation: Required<ConfirmationOpts> | null;
  /** Normalized pagination spec, or null when not pageable. */
  pageable: ResolvedPageable | null;
  /** The params schema actually validated — the declared schema, plus
   *  `page`/`pageSize` when the action is pageable. */
  effectiveSchema: z.ZodTypeAny;
  invalidatesOnChange: Record<string, string[]>;
}

export interface CompiledPlan<T extends LibraryManagedSlots> {
  toolName: string;
  toolLeadDescription: string;
  /** Compiled actions, plus the config's declaration order (the model-facing
   *  variant order). */
  actions: Record<string, CompiledAction>;
  actionOrder: string[];
  selectors: Record<string, AnySelector>;
  executors: Record<string, AnyExecutor>;
  verifiers: VerifierRegistry<T>;
  /** Which library features are on — drives control injection everywhere. */
  activation: ControlActivation;
  /** The injected controls, in registry order. */
  controls: ControlAction[];
  /** Names the run pipeline dispatches to a control instead of an executor.
   *  Always includes `abort_pending_input` (it executes even when inactive). */
  controlNames: Set<string>;
  /** Whether any feature needs the caller-turn identity (bounded choices, or
   *  a confirm-gated action's same-turn protection). When false, the host's
   *  `getCallerTurnId` hook is never consulted. */
  needsCallerTurnId: boolean;
  msgs: SystemMessages;
  merge: PatchMerger<T>;
  getCallerTurnId?: (state: T) => string | null | undefined;
  backendFailureCodes: Set<string>;
  errorHandoffThreshold: number;
  onErrorThreshold?: (update: Record<string, unknown>, state: T) => void;
}

/** Page params the runner injects into a `pageable` action's schema, so the
 *  consumer never declares them. */
const PAGE_PARAMS = {
  page: z.number().int().positive().optional(),
  pageSize: z.number().int().positive().optional(),
};

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

/** True if any action opts into a library-managed gate or flow lifecycle —
 *  activates the abort control. */
function hasAnyLifecycleOpt(actions: Record<string, ActionDef<string>>): boolean {
  for (const action of Object.values(actions)) {
    const opt = action.controller;
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

export function compilePlan<
  T extends LibraryManagedSlots,
  ActionName extends string,
  PrereqName extends string,
  Selectors extends Record<ActionName, Selector<T>>,
>(opts: BuildAgentStepToolOptions<T, ActionName, PrereqName, Selectors>): CompiledPlan<T> {
  if (!opts.stateSchema) {
    throw new Error("agent-step: buildAgentStepTool requires `stateSchema`.");
  }
  const rawActions = opts.config.actions as Record<string, ActionDef<string>>;
  const boundedChoices = opts.boundedChoices ?? {};
  const repeatableConfirmationActions = Object.entries(rawActions)
    .filter(([, action]) =>
      repeatReadBackEnabled(action.controller?.requiresConfirmation),
    )
    .map(([name]) => name);
  const activation: ControlActivation = {
    hasLifecycleOpts: hasAnyLifecycleOpt(rawActions),
    handoffEnabled: opts.handoff != null,
    handoffActionDescription: opts.handoff?.actionDescription,
    handoffModelRequestSchema:
      opts.handoff?.modelRequestSchema ?? handoffParamsSchema,
    abortPolicy: resolveAbortPolicy(opts.abortPolicy),
    repeatableConfirmationActions,
    boundedChoices,
    boundedChoicesEnabled: Object.keys(boundedChoices).length > 0,
    // Requires the handoff by construction — the repeat path escalates into it.
    deflectAsideEnabled: deflectAsideEnabled(opts.handoff),
    deflectAsideActionDescription: deflectAsideActionDescription(opts.handoff),
  };
  const controls = activeControls(activation);
  const controlNames = new Set(controls.map((c) => c.name));
  // The abort control executes as a graceful no-op even when inactive.
  controlNames.add("abort_pending_input");

  const actionOrder = Object.keys(rawActions);
  const actions: Record<string, CompiledAction> = {};
  for (const name of actionOrder) {
    const def = rawActions[name];
    actions[name] = {
      name,
      description: def.description,
      summary: def.summary,
      prereqs: def.prereqs,
      controller: def.controller,
      confirmation: normalizeConfirmation(def.controller?.requiresConfirmation),
      pageable: resolvePageable(def.pageable),
      effectiveSchema: effectiveParamsSchema(def),
      invalidatesOnChange: def.invalidatesOnChange ?? {},
    };
  }

  return {
    toolName: opts.config.tool.name,
    toolLeadDescription: opts.config.tool.description,
    actions,
    actionOrder,
    needsCallerTurnId:
      activation.boundedChoicesEnabled ||
      actionOrder.some((name) => actions[name].confirmation !== null),
    selectors: opts.selectors as Record<string, AnySelector>,
    executors: opts.executors as Record<string, AnyExecutor>,
    verifiers: opts.verifiers,
    activation,
    controls,
    controlNames,
    msgs: resolveSystemMessages(opts.messages),
    merge: buildMergerFromStateSchema<T>(opts.stateSchema),
    getCallerTurnId: opts.getCallerTurnId,
    backendFailureCodes: new Set<string>([
      "executor_error",
      ...(opts.backendFailureCodes ?? []),
    ]),
    errorHandoffThreshold: opts.errorHandoffThreshold ?? ERROR_HANDOFF_THRESHOLD,
    onErrorThreshold: opts.onErrorThreshold,
  };
}
