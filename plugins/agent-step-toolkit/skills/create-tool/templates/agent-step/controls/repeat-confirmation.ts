// FILE: src/agent-step/controls/repeat-confirmation.ts
//
// Repeat the exact engine-stored caller-audible recap for an eligible pending
// confirmation. This control does not invoke a domain executor, re-render from
// mutable state, alter params/attempts, or consume the confirmation gate. It
// advances only the gate's presentation-turn provenance: the repeated recap is
// now the consent question the caller must answer on a later turn. Admission
// makes it a sole step, and that provenance prevents a second ReAct call from
// either repeating again or executing the mutation on this caller turn.

import { z } from "zod";
import type { StepResult } from "../types.js";
import type { LibraryManagedSlots } from "../state.js";
import {
  getAwaitingInput,
  setConfirmationPatch,
} from "../run/batch-state.js";
import type {
  ControlAction,
  ControlOutcome,
  ControlRunContext,
} from "./contract.js";

export const REPEAT_PENDING_CONFIRMATION_ACTION =
  "repeat_pending_confirmation";

export const repeatPendingConfirmationControl: ControlAction = {
  name: REPEAT_PENDING_CONFIRMATION_ACTION,
  activeWhen: (ctx) => ctx.repeatableConfirmationActions.length > 0,
  schemaVariant: (ctx) => {
    const repeatable = ctx.repeatableConfirmationActions
      .map((name) => `\`${name}\``)
      .join(", ");
    return z
      .object({
        action: z.literal(REPEAT_PENDING_CONFIRMATION_ACTION),
        params: z.object({}),
      })
      .describe(
        "Repeat the engine-stored exact read-back for the pending confirmation as the ONLY step. " +
          `ONLY a pending ${repeatable} confirmation is repeatable; any other pending gate's question is re-asked in your own words without this action. ` +
          "Use when the caller has not answered the confirmation and needs its recap repeated. " +
          "This never confirms or executes the action, changes its params, or spends an attempt. " +
          "After success, speak the returned `read_back` verbatim.",
      );
  },
  descriptionLine: (ctx) => {
    const repeatable = ctx.repeatableConfirmationActions
      .map((name) => `\`${name}\``)
      .join(", ");
    return `- \`${REPEAT_PENDING_CONFIRMATION_ACTION}\`: repeat a pending ${repeatable} confirmation's exact stored read-back without resolving its gate (sole step).`;
  },
  allowedDuringGateLockdown: true,
  allowedDuringChoicePending: false,
  sameTurnEscape: "none",
  exclusivityGroup: "repeat-confirmation",
  execute<T extends LibraryManagedSlots>(
    _params: unknown,
    ctx: ControlRunContext<T>,
  ): ControlOutcome {
    const awaiting = getAwaitingInput(ctx.state.view);
    const eligible =
      awaiting?.kind === "confirmation" &&
      ctx.activation.repeatableConfirmationActions.includes(
        awaiting.for_action,
      ) &&
      typeof awaiting.read_back === "string" &&
      awaiting.read_back.length > 0;
    if (!eligible) {
      const entry: StepResult = {
        action: REPEAT_PENDING_CONFIRMATION_ACTION,
        ok: false,
        summary:
          "No eligible pending confirmation has an exact stored read-back to repeat.",
        error: "repeat_confirmation_not_available",
      };
      return { entry, failed: true };
    }

    // A repeat is meaningful only after the caller has heard the proposal and
    // replied. Fail closed when provenance is unavailable: otherwise a second
    // ReAct loop could cause the model to answer its own just-proposed gate.
    const proposedTurnId = awaiting.proposed_on_caller_turn_id;
    if (!proposedTurnId || !ctx.currentCallerTurnId) {
      const entry: StepResult = {
        action: REPEAT_PENDING_CONFIRMATION_ACTION,
        ok: false,
        summary:
          "The pending confirmation read-back cannot be repeated without stable caller-turn identity.",
        error: "repeat_confirmation_turn_identity_unavailable",
      };
      return { entry, failed: true };
    }
    if (proposedTurnId === ctx.currentCallerTurnId) {
      const entry: StepResult = {
        action: REPEAT_PENDING_CONFIRMATION_ACTION,
        ok: false,
        summary:
          "The confirmation was proposed on the current caller turn; wait for the caller's reply before repeating it.",
        error: "repeat_confirmation_same_turn_locked",
      };
      return { entry, failed: true };
    }

    // Re-presenting the recap resets the consent boundary. Preserve the exact
    // pending proposal while stamping this caller turn, so neither another
    // repeat nor a matching mutation call in a later ReAct loop can treat the
    // caller's pre-repeat utterance as an answer to the newly spoken question.
    ctx.state.apply(
      setConfirmationPatch<T>(
        awaiting.for_action,
        awaiting.params,
        awaiting.attempts_left,
        awaiting.max_attempts,
        ctx.currentCallerTurnId,
        awaiting.read_back,
      ),
    );

    return {
      entry: {
        action: REPEAT_PENDING_CONFIRMATION_ACTION,
        ok: true,
        summary: `Repeated the exact stored confirmation read-back for "${awaiting.for_action}"; the gate remains pending.`,
        confirmation_repeated: true,
        for_action: awaiting.for_action,
        needs_confirmation: true,
        read_back: awaiting.read_back,
      },
      failed: false,
    };
  },
};
