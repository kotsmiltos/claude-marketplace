// FILE: src/agent-step/run/admission.ts
//
// Batch admission: every whole-batch precondition, checked in a FIXED order
// before plan expansion. Each rule either refuses the batch (a single result
// entry, `failed_at: 0`, nothing committed) or passes to the next. The order
// is behavior — later rules assume earlier ones passed:
//
//   1. unknown action           — hallucinated/typo'd names, structured refusal
//   2. choice same-turn lock    — a resolved bounded choice locks domain work
//                                 until the caller speaks again
//   3. choice pending lockdown  — a pending bounded choice admits only its
//                                 controls / abort / handoff / direct inputs
//   4. gate lockdown            — a pending confirmation/OTP/match admits only
//                                 its target action / abort / handoff / choice
//                                 controls (+ the capturer, for match)
//   5. flow mutex               — opening a DIFFERENT flow while one is active
//   6. control exclusivity      — sole-step control families (handoff,
//                                 bounded-choice), in registry-group order
//   7. abort policy             — optional host source/follower allow-lists
//   8. soleStep / soleOnExecute — per-action batch-isolation opts
//
// Lockdown (cross-turn, "the customer owes an answer") and exclusivity
// (within-batch, "this transition cannot share a batch") are distinct rules
// on purpose — see the individual rule comments.

import type { StepResult } from "../types.js";
import type { LibraryManagedSlots } from "../state.js";
import { formatMessage } from "../messages.js";
import type { CompiledPlan } from "../compile/plan.js";
import {
  ABORT_ACTION,
  EXCLUSIVITY_GROUPS,
  RESOLVE_BOUNDED_CHOICE_ACTION,
} from "../controls/registry.js";
import {
  paramsMatchPending,
  pendingConfirmationOf,
} from "../interaction/confirmation.js";
import {
  getAwaitingInput,
  getBoundedChoice,
  getCurrentFlow,
} from "./batch-state.js";
import type { UserStep } from "./planning.js";

/** A refused batch: one result entry; the runner shapes it into the standard
 *  `{ summary, results: [entry], failed_at: 0 }` body with nothing committed. */
export interface BatchRefusal {
  entry: StepResult;
}

export function admitBatch<T extends LibraryManagedSlots>(
  plan: CompiledPlan<T>,
  userSteps: UserStep[],
  view: Partial<T>,
  currentCallerTurnId: string | undefined,
): BatchRefusal | null {
  const { msgs, activation } = plan;
  const first = userSteps[0];

  // ── 1. Unknown-action defense. The LangChain wrapper validates input against
  //    the Zod discriminated union before the run starts, so production traffic
  //    can't reach here. But `runSteps` is also the public test seam and is
  //    callable directly by non-LangChain consumers — guard against
  //    hallucinated/typo'd action names with a structured refusal instead of a
  //    crash (executor lookup would otherwise dereference undefined). The abort
  //    control is accepted even when inactive (it executes as a no-op).
  for (const s of userSteps) {
    if (s.action === ABORT_ACTION) continue;
    if (plan.controlNames.has(s.action)) continue;
    if (plan.actions[s.action]) continue;
    return {
      entry: {
        action: s.action,
        ok: false,
        summary: msgs.unknown_action,
        error: "unknown_action",
      },
    };
  }

  // ── 2. Bounded-choice same-turn lock: a nonterminal resolution recorded on
  //    THIS caller turn keeps domain work locked until the caller speaks again,
  //    so a second ReAct loop in the same turn cannot execute suspended work.
  //    An unknown current identity fails closed (locked). Safe escapes come
  //    from control metadata: abort only as the batch's single step, handoff /
  //    choice controls as the first step.
  const choiceAtStart = activation.boundedChoicesEnabled
    ? getBoundedChoice(view)
    : null;
  if (
    activation.boundedChoicesEnabled &&
    choiceAtStart?.status === "resolved" &&
    choiceAtStart.resolved_on_caller_turn_id !== undefined &&
    (currentCallerTurnId === undefined ||
      currentCallerTurnId === choiceAtStart.resolved_on_caller_turn_id) &&
    userSteps.length > 0
  ) {
    const escaped = plan.controls.some((control) => {
      if (control.sameTurnEscape === "sole") {
        return userSteps.length === 1 && first?.action === control.name;
      }
      if (control.sameTurnEscape === "first") {
        return first?.action === control.name;
      }
      return false;
    });
    if (!escaped) {
      const action = first?.action ?? "(empty)";
      const summary =
        `Bounded choice "${choiceAtStart.name}" was resolved on the current caller turn; ` +
        "wait for the caller's next reply before running another step.";
      return {
        entry: {
          action,
          ok: false,
          summary,
          error: "bounded_choice_resume_turn_locked",
          choice: choiceAtStart.name,
        },
      };
    }
  }

  // ── 3. Bounded-choice pending lockdown: while the meta-choice awaits a
  //    selection, no consequential domain action may run unless the host
  //    explicitly marks it as a direct-input continuation. In particular, a
  //    suspended confirm-required mutation is NOT allowed: a model mistake
  //    cannot turn the caller's "continue" into execution. Abort is admitted
  //    even if somehow inactive (defense for handcrafted state).
  if (activation.boundedChoicesEnabled && choiceAtStart?.status === "pending") {
    // Offered-this-turn lock: until the caller has actually HEARD the fork
    // and replied (a later turn), nothing may count as their selection — not
    // `resolve_bounded_choice`, not a direct-input action. Only the terminal
    // escapes (abort, handoff) and the request control (whose repeat path is
    // the configured atomic handoff) may lead the batch. Enforced only when
    // both turn identities exist; a same-turn resolve would otherwise let a
    // second ReAct loop answer the choice on the caller's behalf. Abort may
    // escape this lock only as a sole step: an abort+domain batch would let the
    // same pre-offer caller utterance both discard the choice and supply its
    // replacement input.
    const offeredThisTurn =
      choiceAtStart.requested_on_caller_turn_id !== undefined &&
      currentCallerTurnId !== undefined &&
      choiceAtStart.requested_on_caller_turn_id === currentCallerTurnId;
    const choice = activation.boundedChoices[choiceAtStart.name];
    const directInputActions = new Set(choice?.directInputActions ?? []);
    const abortAllowed =
      first?.action === ABORT_ACTION &&
      (!offeredThisTurn || userSteps.length === 1);
    const allowed =
      !!first &&
      (abortAllowed ||
        (offeredThisTurn
          ? plan.controls.some(
              (c) =>
                c.allowedDuringChoicePending &&
                c.name === first.action &&
                c.name !== ABORT_ACTION &&
                c.name !== RESOLVE_BOUNDED_CHOICE_ACTION,
            )
          : plan.controls.some(
              (c) => c.allowedDuringChoicePending && c.name === first.action,
            ) || directInputActions.has(first.action)));
    if (!allowed) {
      const action = first?.action ?? "(empty)";
      if (offeredThisTurn) {
        const summary =
          `Bounded choice "${choiceAtStart.name}" was offered on the current caller turn; ` +
          "wait for the caller's reply before consuming it.";
        return {
          entry: {
            action,
            ok: false,
            summary,
            error: "bounded_choice_same_turn_locked",
            choice: choiceAtStart.name,
          },
        };
      }
      const summary =
        `Bounded choice "${choiceAtStart.name}" is awaiting a selection; ` +
        `domain action "${action}" is locked until the choice is resolved.`;
      return {
        entry: {
          action,
          ok: false,
          summary,
          error: "bounded_choice_pending_locked",
          choice: choiceAtStart.name,
        },
      };
    }
  }

  // ── 4. Gate lockdown: if anything is awaiting customer input, the batch's
  //    first step must be the targeted `for_action` (plan expansion / the gate
  //    check resolves what happens next), an allowed control, or — for match —
  //    the capturer, so the customer can re-capture (e.g. enter a different
  //    first PIN) without aborting the flow. Abort may lead a multi-step
  //    batch: subsequent steps run after the gate is cleared.
  //
  //    No library-side TTL on any slot — confirmation and OTP are both
  //    conversation-driven. Stale state is cleared by `abort_pending_input` or
  //    executor effects; the runner doesn't time anything out on its own.
  const awaiting = getAwaitingInput(view);
  if (awaiting) {
    // Confirmation lockdown defaults to true and is overridable per action;
    // OTP and match lockdown are always on — no opt to disable.
    const isLocked =
      awaiting.kind === "confirmation"
        ? plan.actions[awaiting.for_action]?.confirmation?.lockdown !== false
        : true;
    if (isLocked) {
      let capturer: string | null = null;
      if (awaiting.kind === "match") {
        capturer =
          plan.actions[awaiting.for_action]?.controller?.requiresMatch?.capturer ?? null;
      }
      const allowed =
        !!first &&
        (first.action === awaiting.for_action ||
          first.action === ABORT_ACTION ||
          // A handoff abandons the conversation path entirely; bounded-choice
          // controls are an overlay that may suspend or resume the spoken
          // question without consuming this gate. Both must work while locked.
          plan.controls.some(
            (c) => c.allowedDuringGateLockdown && c.name === first.action,
          ) ||
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
        return {
          entry: {
            action: first?.action ?? "(empty)",
            ok: false,
            summary,
            error: errorCode,
            awaiting: { kind: awaiting.kind, for_action: awaiting.for_action },
          },
        };
      }
    }
  }

  // ── 5. Flow mutex: if the first step opens a flow (`startsFlow`) but a
  //    DIFFERENT flow is already active, refuse. `startsFlow` is idempotent
  //    within the same flow — the executor will re-run (e.g. to re-issue an
  //    OTP) without resetting `currentFlow.data`.
  const currentFlow = getCurrentFlow(view);
  if (currentFlow && first) {
    const starts = plan.actions[first.action]?.controller?.startsFlow;
    if (starts && starts.name !== currentFlow.name) {
      return {
        entry: {
          action: first.action,
          ok: false,
          summary: msgs.flow_already_active,
          error: "flow_already_active",
          active_flow: currentFlow.name,
        },
      };
    }
  }

  // ── 6. Control exclusivity, in group order: a sole-step control mixed into
  //    a larger batch refuses the whole batch. Only groups with an ACTIVE
  //    member are evaluated (an inactive control name was already refused as
  //    unknown above).
  if (userSteps.length > 1) {
    for (const group of EXCLUSIVITY_GROUPS) {
      const activeMembers = group.memberNames.filter((n) => plan.controlNames.has(n));
      if (activeMembers.length === 0) continue;
      const found = userSteps.find((s) => activeMembers.includes(s.action));
      if (!found) continue;
      // Narrow relaxation (2026-08-11): a LEADING `resolve_bounded_choice` may
      // be followed by the pending choice's own direct-input actions — the
      // batch a model naturally emits when one caller reply both selects
      // "continue" and supplies the suspended detail. Every follower is an
      // action the config already trusts to consume caller input while the
      // choice is pending (the confirm-required mutation is never among
      // them), so the shape this group exists to prevent — "continue" turning
      // into consent for a suspended mutation — stays impossible. The
      // offered-this-turn lock (section 3) still refuses the same-turn form.
      if (found.action === RESOLVE_BOUNDED_CHOICE_ACTION) {
        const pendingChoice = getBoundedChoice(view);
        if (
          userSteps[0].action === RESOLVE_BOUNDED_CHOICE_ACTION &&
          pendingChoice?.status === "pending"
        ) {
          const directInputs = new Set(
            activation.boundedChoices[pendingChoice.name]?.directInputActions ?? [],
          );
          if (userSteps.slice(1).every((s) => directInputs.has(s.action))) continue;
        }
      }
      return {
        entry: {
          action: found.action,
          ok: false,
          summary: group.summary(found.action, msgs),
          error: group.errorCode,
        },
      };
    }
  }

  // ── 7. Optional abort policy. Omission preserves the legacy permissive
  //    behavior. Once configured, abort is an explicit in-domain transition:
  //    it leads the batch, clears something real when required, and has at
  //    most one declared domain follower. Control followers are never legal;
  //    in particular request_handoff was already refused by the sole-step
  //    exclusivity rule above.
  const abortPolicy = activation.abortPolicy;
  const abortIndex = userSteps.findIndex((step) => step.action === ABORT_ACTION);
  if (abortPolicy && abortIndex !== -1) {
    if (abortIndex !== 0) {
      return {
        entry: {
          action: ABORT_ACTION,
          ok: false,
          summary: `"${ABORT_ACTION}" must be the first step in the batch.`,
          error: "abort_must_be_first",
        },
      };
    }

    const hasActiveTarget =
      awaiting != null ||
      currentFlow != null ||
      (activation.boundedChoicesEnabled && choiceAtStart?.status === "pending");
    if (abortPolicy.requireActive && !hasActiveTarget) {
      return {
        entry: {
          action: ABORT_ACTION,
          ok: false,
          summary: `"${ABORT_ACTION}" requires pending input, an active flow, or a pending bounded choice.`,
          error: "abort_requires_active_input",
        },
      };
    }

    if (
      abortPolicy.allowedPendingTargets !== null &&
      (awaiting == null ||
        !abortPolicy.allowedPendingTargets.includes(awaiting.for_action))
    ) {
      const allowed = abortPolicy.allowedPendingTargets
        .map((name) => `"${name}"`)
        .join(", ");
      const summary =
        awaiting == null
          ? `"${ABORT_ACTION}" requires pending input targeting one of: ${allowed}.`
          : `"${ABORT_ACTION}" cannot clear pending input for "${awaiting.for_action}"; allowed targets: ${allowed}.`;
      return {
        entry: {
          action: ABORT_ACTION,
          ok: false,
          summary,
          error: "abort_pending_target_not_allowed",
          ...(awaiting
            ? {
                awaiting: {
                  kind: awaiting.kind,
                  for_action: awaiting.for_action,
                },
              }
            : {}),
        },
      };
    }

    const followers = userSteps.slice(1);
    if (followers.length === 0 && !abortPolicy.allowStandalone) {
      return {
        entry: {
          action: ABORT_ACTION,
          ok: false,
          summary: `"${ABORT_ACTION}" must be followed by exactly one allowed domain action.`,
          error: "abort_follower_required",
        },
      };
    }
    if (followers.length > 1) {
      return {
        entry: {
          action: ABORT_ACTION,
          ok: false,
          summary: `"${ABORT_ACTION}" may be followed by at most one domain action.`,
          error: "abort_too_many_followers",
        },
      };
    }
    const follower = followers[0];
    if (follower) {
      const isDomainAction = plan.actions[follower.action] != null;
      const isAllowed =
        abortPolicy.allowedFollowers === null ||
        abortPolicy.allowedFollowers.includes(follower.action);
      if (!isDomainAction || !isAllowed) {
        return {
          entry: {
            action: follower.action,
            ok: false,
            summary: `"${follower.action}" is not an allowed follower of "${ABORT_ACTION}".`,
            error: "abort_follower_not_allowed",
          },
        };
      }
    }
  }

  // ── 8. soleStep / soleOnExecute. Distinct from lockdown — lockdown bars
  //    unrelated actions ACROSS turns while pending; these opts bar them
  //    WITHIN a single batch.
  //    - `soleStep`: strict — refuse any batch larger than 1 containing this
  //      action, regardless of confirm-mode.
  //    - `soleOnExecute`: relaxed — propose/re-propose modes may ride along
  //      (but only as the last step); execute mode must be alone. Lets the
  //      LLM batch `[reads..., propose-mutation]` in one tool call. Uses
  //      batch-start pending to predict execute-vs-propose, matching plan
  //      expansion's freeze.
  const soleCheckPending = pendingConfirmationOf(awaiting);
  let sawAbort = false;
  for (let i = 0; i < userSteps.length; i++) {
    const s = userSteps[i];
    if (s.action === ABORT_ACTION) {
      sawAbort = true;
      continue;
    }
    const m = plan.actions[s.action]?.controller;
    if (!m) continue;
    if (m.soleStep && userSteps.length > 1) {
      return {
        entry: {
          action: s.action,
          ok: false,
          summary: formatMessage(msgs.mutation_must_be_sole_step, { action: s.action }),
          error: "mutation_must_be_sole_step",
        },
      };
    }
    if (m.soleOnExecute && !m.soleStep && userSteps.length > 1) {
      // Abort-aware, mirroring plan expansion: a preceding abort destroys the
      // gate, so a later matching step is a fresh PROPOSE (rideable at the
      // tail), not an execute.
      const isExecute =
        !sawAbort &&
        !!soleCheckPending &&
        soleCheckPending.action === s.action &&
        paramsMatchPending(plan.actions[s.action], soleCheckPending.params, s.params);
      if (isExecute) {
        return {
          entry: {
            action: s.action,
            ok: false,
            summary: formatMessage(msgs.mutation_execute_must_be_sole, {
              action: s.action,
            }),
            error: "mutation_must_be_sole_step",
          },
        };
      }
      if (i !== userSteps.length - 1) {
        return {
          entry: {
            action: s.action,
            ok: false,
            summary: formatMessage(msgs.mutation_must_be_last_in_batch, {
              action: s.action,
            }),
            error: "mutation_must_be_last_in_batch",
          },
        };
      }
    }
  }

  return null;
}
