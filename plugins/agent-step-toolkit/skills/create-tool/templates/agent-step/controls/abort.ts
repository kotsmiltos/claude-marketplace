// FILE: src/agent-step/controls/abort.ts
//
// The unified abort control: drop whatever the customer is currently being
// asked for (confirmation, OTP, match, or bounded choice) AND the active
// multi-turn flow, in one idempotent transition. Injected whenever any action
// opts into a library-managed lifecycle (or bounded choices are configured) —
// every gate needs an escape hatch the model can always reach.
//
// Unlike every other control, abort also EXECUTES when inactive (a no-op
// entry): the run loop dispatches on its name unconditionally, so a stray
// abort from the model degrades gracefully instead of crashing an executor
// lookup.

import { z } from "zod";
import type { StepResult } from "../types.js";
import type { LibraryManagedSlots } from "../state.js";
import type { ControlAction, ControlOutcome, ControlRunContext } from "./contract.js";
import {
  clearInteractionPatch,
  getAwaitingInput,
  getBoundedChoice,
  getCurrentFlow,
} from "../run/batch-state.js";

/** Reserved control name — always reserved, whatever the activation. */
export const ABORT_ACTION = "abort_pending_input";

export const abortControl: ControlAction = {
  name: ABORT_ACTION,
  activeWhen: (ctx) => ctx.hasLifecycleOpts || ctx.boundedChoicesEnabled,
  schemaVariant: () =>
    z
      .object({ action: z.literal(ABORT_ACTION), params: z.object({}) })
      .describe(
        "Abort whatever the customer is currently being asked for (confirmation, OTP, match, or bounded choice) and drop any active multi-turn flow. Idempotent — no-op when nothing is pending. Use when the customer pivots away from or explicitly cancels the in-progress flow.",
      ),
  descriptionLine: () =>
    `- \`${ABORT_ACTION}\`: abort pending confirmation/OTP/match/choice input and drop the active flow (idempotent).`,
  allowedDuringGateLockdown: true,
  allowedDuringChoicePending: true,
  sameTurnEscape: "sole",
  exclusivityGroup: null,
  execute<T extends LibraryManagedSlots>(
    _params: unknown,
    ctx: ControlRunContext<T>,
  ): ControlOutcome {
    const { state, msgs } = ctx;
    const priorAwaiting = getAwaitingInput(state.view);
    const priorFlow = getCurrentFlow(state.view);
    const priorChoice = ctx.activation.boundedChoicesEnabled
      ? getBoundedChoice(state.view)
      : null;
    const hadSomething =
      priorAwaiting != null || priorFlow != null || priorChoice != null;
    if (hadSomething) {
      state.apply(clearInteractionPatch<T>(ctx.activation.boundedChoicesEnabled));
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
    if (priorChoice) {
      entry.aborted_choice = priorChoice.name;
    }
    return { entry, failed: false };
  },
};
