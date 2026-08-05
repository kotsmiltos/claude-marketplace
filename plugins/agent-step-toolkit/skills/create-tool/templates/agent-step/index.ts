// FILE: src/agent-step/index.ts
//
// The library's public surface. Hosts import ONLY from here; the phase
// modules (compile/, run/, interaction/, controls/, handoff/) are internal
// layout, free to move without breaking consumers.

export type {
  ExecutorEffect,
  ExecutorResult,
  Executor,
  ExecutorRegistry,
  Selector,
  SelectorRegistry,
  Verifier,
  VerifierRegistry,
  ActionDef,
  ControllerHooks,
  ConfirmationOpts,
  AgentStepConfig,
  StepResult,
  RunnerResultBody,
} from "./types.js";
export { defineConfig } from "./define-config.js";
export {
  buildAgentStepTool,
  runSteps,
  REQUEST_BOUNDED_CHOICE_ACTION,
  RESOLVE_BOUNDED_CHOICE_ACTION,
} from "./runner.js";
export type {
  BuildAgentStepToolOptions,
  RunResult,
  StateSchemaLike,
} from "./runner.js";

// The one-shot conversational-choice overlay: authoring types live with the
// policy (interaction/bounded-choice.ts); the two controls are auto-injected
// when `BuildAgentStepToolOptions.boundedChoices` is provided.
export type {
  BoundedChoiceDef,
  BoundedChoiceRegistry,
} from "./interaction/bounded-choice.js";

// Runner-emitted system `summary` strings. Neutral English defaults live in the
// library; a host overrides them via `BuildAgentStepToolOptions.messages` (e.g.
// localized / voice-safe wording). The library never imports host strings.
export { DEFAULT_SYSTEM_MESSAGES, resolveSystemMessages } from "./messages.js";
export type { SystemMessages } from "./messages.js";

// Library-managed state slots. Consumers spread `agentStepStateSpec` into their
// `Annotation.Root` and `agentStepZodShape` into their Zod state schema rather
// than hand-rolling storage for the slots the runner mutates.
export {
  AwaitingInputSchema,
  CurrentFlowSchema,
  BoundedChoiceSchema,
  PagedCacheSchema,
  HandoffRequestSchema,
  agentStepStateSpec,
  agentStepZodShape,
  agentStepInternalSlotMask,
} from "./state.js";
export type {
  AwaitingInput,
  CurrentFlow,
  BoundedChoice,
  HandoffRequest,
  LibraryManagedSlots,
} from "./state.js";

// Handoff: the built-in `request_handoff` control is auto-injected by the
// runner when `BuildAgentStepToolOptions.handoff` is provided. It abandons
// transient runner state and writes the `handoff` slot atomically. The host
// graph resolves the slot with a node built by `createHandoffNode(spec)`, wired
// after the tool node behind the `handoffRequested` edge predicate, with a
// direct edge to END.
export {
  HANDOFF_ACTION,
  HANDOFF_NODE,
  HANDOFF_ACTION_DESCRIPTION,
  HANDBACK_SIGNALS,
  handoffParamsSchema,
  handoffRequested,
} from "./handoff/contract.js";
export type {
  HandoffSpec,
  HandoffOffTopicSpec,
  HandoffDelegateTarget,
} from "./handoff/contract.js";
export { createHandoffNode } from "./handoff/node.js";

// Read-pagination primitives. Pure, domain-agnostic helpers for tool read
// executors — the runner does not use them. A tool's list reads use these to
// present one uniform paginated envelope (delegate to a paging backend, or
// self-paginate via a consumer-declared cache slot of shape `PagedCache`).
export {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  clampPageSize,
  querySignature,
  pageRows,
  buildPageEnvelope,
} from "./paginate.js";
export type { PageEnvelope, PagedCache, PageableSpec } from "./paginate.js";
