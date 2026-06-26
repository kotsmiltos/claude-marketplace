// FILE: src/agent-step/messages.ts
//
// System (runner-emitted) message strings, self-contained in the library. The
// runner emits these `summary` strings for its own structured refusals/errors
// (executor crash, invalid params, abort, flow gates). They ship as neutral
// ENGLISH defaults so the library has ZERO dependency on any host project.
//
// A host that wants different wording (e.g. a localized, voice-safe phrasing for
// a TTS agent) passes `messages` to `buildAgentStepTool` / `runSteps`; the
// overrides are shallow-merged over the defaults. The library never imports a
// project file to obtain these.

export interface SystemMessages {
  /** An executor threw / a hard failure was caught. Raw cause is carried in `_debug`. */
  executor_error: string;
  /** Step params failed schema validation. Raw detail is carried in `_debug`. */
  invalid_params: string;
  /** A hallucinated/typo'd action name reached the runner. */
  unknown_action: string;
  /** A step tried to open a flow while a different flow is active. */
  flow_already_active: string;
  /** A flow-scoped step ran with no flow active. */
  no_flow: string;
  /** A flow-scoped step ran against the wrong flow. */
  wrong_flow: string;
  /** `abort_pending_input` cleared a pending gate / active flow. */
  abort_done: string;
  /** `abort_pending_input` ran with nothing pending (idempotent no-op). */
  abort_nothing: string;
  /** Spoken to the caller when the auto-handoff threshold is reached after
   *  repeated backend failures. Delivered as the handoff `context` and
   *  repeated in the synthetic `auto_handoff` result body. */
  auto_handoff: string;
}

/** Neutral English defaults. Overridable per-host via `BuildAgentStepToolOptions.messages`. */
export const DEFAULT_SYSTEM_MESSAGES: SystemMessages = {
  executor_error:
    "An unexpected error occurred while processing the request. Please try again.",
  invalid_params: "The request could not be understood. Please rephrase it.",
  unknown_action:
    "An unexpected error occurred while processing the request. Please try again.",
  flow_already_active:
    "Another operation is already in progress. Complete or cancel it first.",
  no_flow: "No active operation was found. Please start again.",
  wrong_flow: "Something went wrong with the operation. Let's start over.",
  abort_done: "Okay, the operation has been cancelled.",
  abort_nothing: "There is no operation in progress.",
  auto_handoff:
    "I'm sorry, due to a technical issue I was unable to complete the operation. Can I help you with something else?",
};

/** Shallow-merge host overrides over the defaults. Returns the defaults object
 *  unchanged when no overrides are supplied (no allocation on the common path). */
export function resolveSystemMessages(
  overrides?: Partial<SystemMessages>,
): SystemMessages {
  return overrides ? { ...DEFAULT_SYSTEM_MESSAGES, ...overrides } : DEFAULT_SYSTEM_MESSAGES;
}
