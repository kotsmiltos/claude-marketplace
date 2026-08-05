// FILE: src/agent-step/controls/registry.ts
//
// The ordered control registry. ORDER IS MODEL-FACING SURFACE: it fixes the
// sequence of injected schema variants and description lines (abort → handoff
// → bounded-choice request → bounded-choice resolve). Do not reorder without
// re-verifying the model-facing golden.
//
// Exclusivity groups are likewise evaluated in their declared order at
// admission: a batch mixing a handoff with a choice control is attributed to
// the handoff group.

import type { SystemMessages } from "../messages.js";
import { formatMessage } from "../messages.js";
import type { ControlAction, ControlActivation, ExclusivityGroup } from "./contract.js";
import { abortControl, ABORT_ACTION } from "./abort.js";
import { requestHandoffControl } from "./request-handoff.js";
import {
  requestBoundedChoiceControl,
  resolveBoundedChoiceControl,
  REQUEST_BOUNDED_CHOICE_ACTION,
  RESOLVE_BOUNDED_CHOICE_ACTION,
} from "./bounded-choice.js";
import { HANDOFF_ACTION } from "../handoff/contract.js";

export const CONTROL_REGISTRY: readonly ControlAction[] = [
  abortControl,
  requestHandoffControl,
  requestBoundedChoiceControl,
  resolveBoundedChoiceControl,
];

export const EXCLUSIVITY_GROUPS: readonly ExclusivityGroup[] = [
  {
    name: "handoff",
    memberNames: [HANDOFF_ACTION],
    errorCode: "handoff_must_be_sole_step",
    // A handoff abandons the turn, so a batch mixing it with anything else is
    // incoherent ([list_x, request_handoff] would half-execute work whose
    // result nobody will see).
    summary: (foundAction: string, msgs: SystemMessages) =>
      formatMessage(msgs.handoff_must_be_sole_step, { action: foundAction }),
  },
  {
    name: "bounded-choice",
    memberNames: [REQUEST_BOUNDED_CHOICE_ACTION, RESOLVE_BOUNDED_CHOICE_ACTION],
    errorCode: "bounded_choice_must_be_sole_step",
    // Both controls are meta-transitions: a same-batch domain call could
    // otherwise turn "continue" into consent for a suspended mutation.
    summary: (foundAction: string) =>
      `"${foundAction}" must be the only step in the batch.`,
  },
];

/** The controls injected for this activation, in registry order. */
export function activeControls(ctx: ControlActivation): ControlAction[] {
  return CONTROL_REGISTRY.filter((c) => c.activeWhen(ctx));
}

/** Names reserved against user-defined actions for this activation. The abort
 *  control's name is ALWAYS reserved (it executes even when inactive). */
export function reservedControlNames(ctx: ControlActivation): string[] {
  const names = activeControls(ctx).map((c) => c.name);
  return names.includes(ABORT_ACTION) ? names : [ABORT_ACTION, ...names];
}

export { ABORT_ACTION, REQUEST_BOUNDED_CHOICE_ACTION, RESOLVE_BOUNDED_CHOICE_ACTION };
