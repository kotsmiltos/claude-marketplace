// FILE: src/agent-step/controls/repeat-question.ts
//
// Repeat the engine-stored exact presentation of the pending question — the
// one control for the whole cursor (renamed from repeat_pending_confirmation
// when it generalized to choices, 2026-08-15):
//
//   - a pending CONFIRMATION on an eligible (repeatable) action: re-present
//     its stored `read_back` bytes. No executor runs, no re-render from
//     mutable state, no params/attempts change, and the gate is not consumed.
//   - a pending BOUNDED CHOICE with a configured `renderRequest`: re-present
//     the engine-rendered request and re-emit its `reply_contract`. Without
//     this path a channel check («Με ακούτε;») while a choice pends had NO
//     legal move: the choice contract demands a tool call, and a re-call of
//     `request_bounded_choice` falsely fires the repeat-escalation handoff.
//
// Both shapes advance only the pending interaction's presentation-turn
// provenance: the repeated question is now the question the caller must
// answer on a LATER turn. Admission makes it a sole step, and the re-stamp
// prevents a second ReAct call from answering the freshly spoken question on
// the caller's behalf.

import { z } from "zod";
import type { StepResult } from "../types.js";
import type { LibraryManagedSlots } from "../state.js";
import {
  getAwaitingInput,
  setConfirmationPatch,
} from "../run/batch-state.js";
import { formatMessage } from "../messages.js";
import type {
  ControlAction,
  ControlOutcome,
  ControlRunContext,
} from "./contract.js";

export const REPEAT_PENDING_QUESTION_ACTION = "repeat_pending_question";

/** The repeatable shapes for this activation, in model-facing words. */
function repeatableShapes(ctx: {
  repeatableConfirmationActions: readonly string[];
}): string[] {
  const shapes: string[] = [];
  if (ctx.repeatableConfirmationActions.length > 0) {
    const repeatable = ctx.repeatableConfirmationActions
      .map((name) => `\`${name}\``)
      .join(", ");
    shapes.push(`a pending ${repeatable} confirmation's read-back`);
  }
  return shapes;
}

export const repeatPendingQuestionControl: ControlAction = {
  name: REPEAT_PENDING_QUESTION_ACTION,
  activeWhen: (ctx) => repeatableShapes(ctx).length > 0,
  schemaVariant: (ctx) => {
    const shapes = repeatableShapes(ctx).join(", or ");
    return z
      .object({
        action: z.literal(REPEAT_PENDING_QUESTION_ACTION),
        params: z.object({}),
      })
      .describe(
        "Repeat the engine-stored exact presentation of the pending question as the ONLY step: " +
          `${shapes}. Nothing else has stored bytes — at a standing value ask or any other pending ` +
          "question, do NOT call this: re-ask in your own words with no call. " +
          "Use when the caller has not answered the pending question and needs it repeated. " +
          "This never confirms, resolves, or executes anything, changes params, or spends an attempt. " +
          "After success, speak the returned `read_back` verbatim.",
      );
  },
  descriptionLine: (ctx) => {
    const shapes = repeatableShapes(ctx).join(", or ");
    return `- \`${REPEAT_PENDING_QUESTION_ACTION}\`: repeat the exact stored presentation of ${shapes}, without resolving it (sole step).`;
  },
  allowedDuringGateLockdown: true,
  sameTurnEscape: "none",
  exclusivityGroup: "repeat-confirmation",
  execute<T extends LibraryManagedSlots>(
    _params: unknown,
    ctx: ControlRunContext<T>,
  ): ControlOutcome {
    const awaiting = getAwaitingInput(ctx.state.view);


    // ── Pending confirmation on a repeatable action: re-present read_back. ──
    const eligible =
      awaiting?.kind === "confirmation" &&
      ctx.activation.repeatableConfirmationActions.includes(
        awaiting.for_action,
      ) &&
      typeof awaiting.read_back === "string" &&
      awaiting.read_back.length > 0;
    if (!eligible) {
      const entry: StepResult = {
        action: REPEAT_PENDING_QUESTION_ACTION,
        ok: false,
        summary:
          "No eligible pending question has an exact stored presentation to repeat.",
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
        action: REPEAT_PENDING_QUESTION_ACTION,
        ok: false,
        summary:
          "The pending question cannot be repeated without stable caller-turn identity.",
        error: "repeat_confirmation_turn_identity_unavailable",
      };
      return { entry, failed: true };
    }
    if (proposedTurnId === ctx.currentCallerTurnId) {
      const entry: StepResult = {
        action: REPEAT_PENDING_QUESTION_ACTION,
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
        action: REPEAT_PENDING_QUESTION_ACTION,
        ok: true,
        summary: `Repeated the exact stored confirmation read-back for "${awaiting.for_action}"; the gate remains pending.`,
        confirmation_repeated: true,
        for_action: awaiting.for_action,
        needs_confirmation: true,
        read_back: awaiting.read_back,
        // Framing for the stored bytes: complete, ends the turn.
        read_back_directive: ctx.msgs.read_back_directive_repeat,
      },
      failed: false,
    };
  },
};
