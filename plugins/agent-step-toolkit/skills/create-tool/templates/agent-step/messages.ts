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

  // ── Templated summaries ────────────────────────────────────────────────
  // The keys below may carry `{placeholder}` tokens, interpolated by the
  // runner via `formatMessage` with the step's runtime values. Available
  // placeholders are listed per key. Overrides are plain strings so they can
  // live in a host's JSON locale resources.

  /** Lockdown refusal: a confirmation is pending. `{action}` = the pending
   *  action, `{abort_action}` = the abort action name. */
  lockdown_confirmation: string;
  /** Lockdown refusal: an OTP is awaiting validation. `{action}`,
   *  `{abort_action}`. */
  lockdown_otp: string;
  /** Lockdown refusal: a double-entry match is pending. `{action}`,
   *  `{capturer}`, `{abort_action}`. */
  lockdown_match: string;
  /** `request_handoff` was batched with other steps. `{action}`. */
  handoff_must_be_sole_step: string;
  /** A `soleStep` mutation was batched with other steps. `{action}`. */
  mutation_must_be_sole_step: string;
  /** A `soleOnExecute` mutation resolving to EXECUTE was batched. `{action}`. */
  mutation_execute_must_be_sole: string;
  /** A `soleOnExecute` mutation rode a batch but not as the last step. `{action}`. */
  mutation_must_be_last_in_batch: string;
  /** A confirm-required mutation was stored as a proposal. `{action}`. */
  confirm_proposed: string;
  /** A pending proposal was overwritten with adjusted params. `{action}`. */
  confirm_reproposed: string;
  /** Confirmation attempts ran out; the pending action was dropped. `{action}`. */
  confirm_exhausted: string;
  /** A `requiresOtp` action ran with no OTP gate pending. `{action}`. */
  otp_not_pending: string;
  /** A `requiresMatch` action ran with no match gate at batch start.
   *  `{action}`, `{capturer}`. */
  match_not_pending: string;
  /** An `issuesOtp` action ran while a match gate is still pending.
   *  `{action}`, `{match_action}` = the match gate's consumer. */
  otp_blocked_match_pending: string;
  /** Double-entry match attempts ran out; the flow was aborted. `{action}`. */
  match_attempts_exhausted: string;
  /** A handoff step succeeded; the turn must end silently. `{reason}`. */
  handoff_requested: string;
  /** The `deflect_aside` control accepted the task's ONE free in-place
   *  deflection: the model must decline the aside in a single short sentence
   *  and repeat its pending question in the SAME turn — no handoff happened
   *  and every pending gate survives. Model-facing instruction, not
   *  caller-audible. */
  aside_deflected: string;
  /** The batch contained no steps. */
  no_steps: string;
  /** Instruction accompanying the synthetic `auto_handoff` result. The
   *  platform (host graph) delivers the closing — the model must NOT speak.
   *  `{message}` = the `auto_handoff` closing, for hosts whose graph does not
   *  deliver it and need the model to voice it. */
  auto_handoff_instruction: string;
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
  lockdown_confirmation:
    'A "{action}" is pending confirmation; only the same action with matching params or "{abort_action}" is allowed until it resolves.',
  lockdown_otp:
    'An OTP for "{action}" is awaiting validation; only that action or "{abort_action}" is allowed until it resolves.',
  lockdown_match:
    'A double-entry match for "{action}" is pending; only that action, the capturer "{capturer}", or "{abort_action}" is allowed until it resolves.',
  handoff_must_be_sole_step: '"{action}" must be the only step in the batch.',
  mutation_must_be_sole_step: 'Mutation "{action}" must be the only step in the batch.',
  mutation_execute_must_be_sole:
    'Mutation "{action}" is being executed (confirmed); it must be the only step in the batch.',
  mutation_must_be_last_in_batch:
    'Mutation "{action}" must be the last step in the batch (reads may precede it; nothing may follow).',
  confirm_proposed: 'Proposed "{action}"; awaiting confirmation.',
  confirm_reproposed: 'Re-proposed "{action}" with adjusted params; awaiting confirmation.',
  confirm_exhausted: 'Confirmation attempts exhausted for "{action}"; pending action dropped.',
  otp_not_pending:
    'Action "{action}" requires a pending OTP awaiting validation; none found.',
  match_not_pending:
    'Action "{action}" requires a pending double-entry match (opened in a prior turn); none found at batch start. The capturer "{capturer}" must run first, in a separate turn.',
  otp_blocked_match_pending:
    'Action "{action}" cannot issue an OTP while a double-entry match for "{match_action}" is still pending; the match must be consumed first.',
  match_attempts_exhausted: 'Match attempts exhausted for "{action}"; flow aborted.',
  handoff_requested:
    "Handoff requested ({reason}). The turn ends here — produce no further answer.",
  aside_deflected:
    "Aside noted — NOT handed off. Decline it in ONE short sentence (no details, no promises) and repeat your pending question in the SAME turn. If the caller pivots away from the task again, call deflect_aside again — the system will hand the conversation off then.",
  no_steps: "No steps executed.",
  auto_handoff_instruction:
    "Handoff triggered after repeated backend failures. The turn ends here — produce no further answer; the platform delivers the closing.",
};

/** Shallow-merge host overrides over the defaults. Returns the defaults object
 *  unchanged when no overrides are supplied (no allocation on the common path). */
export function resolveSystemMessages(
  overrides?: Partial<SystemMessages>,
): SystemMessages {
  return overrides ? { ...DEFAULT_SYSTEM_MESSAGES, ...overrides } : DEFAULT_SYSTEM_MESSAGES;
}

/** Interpolate `{placeholder}` tokens in a system-message template. Unknown
 *  placeholders are left verbatim (a host override naming a token the runner
 *  doesn't supply is visible rather than silently blanked). */
export function formatMessage(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{(\w+)\}/g, (token, key: string) =>
    key in vars ? vars[key] : token,
  );
}
