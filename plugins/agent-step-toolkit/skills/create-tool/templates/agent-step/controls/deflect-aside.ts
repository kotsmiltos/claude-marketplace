// FILE: src/agent-step/controls/deflect-aside.ts
//
// The trigger-happy-handoff damper: a built-in control for a NON-BANKING aside
// mid-task («τι καιρό έχει;», small talk — something no agent in the fleet
// serves, so an immediate `off_topic` re-route buys the caller nothing but a
// lost turn and a dangling question). Policy is engine-owned and uniform
// across agents; only the classification (banking topic → real `off_topic`
// handback vs chit-chat → this control) stays with the model:
//
//   - FIRST use in a task: no handoff. The task-scoped `deflectedAside` latch
//     is set, every pending gate/flow survives untouched, and the result
//     instructs the model to decline in ONE short sentence and repeat its
//     pending question in the SAME turn (the «Με ακούτε;» shape).
//   - SECOND use in the same task: the free deflection is spent — the control
//     escalates ATOMICALLY into the `off_topic` handback (the same
//     `requestHandoffPatch` the handoff control applies), with the aside as
//     the routing `context`. One-shot, like the bounded-choice overlay: a
//     caller who keeps pivoting away still re-routes deterministically.
//
// The latch is task-scoped (agentStepTaskScopedSlots): a task-ENDING handback
// clears it, so the next task on the thread gets its own free deflection. An
// `off_topic` resolution deliberately does NOT clear it — a mid-task aside
// roundtrip that comes back must not re-arm the freebie.
//
// Misclassification is benign in both directions: a banking ask wrongly
// deflected hands off one turn later on persistence; chit-chat wrongly sent
// through `request_handoff` is exactly the pre-control behaviour.

import { z } from "zod";
import type { StepResult } from "../types.js";
import type { LibraryManagedSlots } from "../state.js";
import type {
  ControlAction,
  ControlOutcome,
  ControlRunContext,
} from "./contract.js";
import { requestHandoffPatch } from "../run/batch-state.js";
import { formatMessage } from "../messages.js";

export const DEFLECT_ASIDE_ACTION = "deflect_aside";

const deflectAsideParamsSchema = z.object({
  aside: z
    .string()
    .min(1, "aside must carry the caller's request")
    .describe(
      "The caller's off-task request, verbatim or tightly summarized, in Greek. If the caller keeps pivoting and the system hands the conversation off, this becomes the routing context the receiving agent sees.",
    ),
});

export const DEFLECT_ASIDE_ACTION_DESCRIPTION =
  "Handle a NON-BANKING aside mid-task (weather, sports, small talk, any chit-chat NO bank service could serve) WITHOUT ending the task. Call it as the ONLY step. The FIRST time in a task the system does not hand off: decline the aside in ONE short sentence — no details, no promises — and repeat your pending question in the SAME turn; every pending confirmation or code stays exactly where it was. If the caller pivots away from the task AGAIN, call this action again — the system then hands the conversation off itself (produce NO text after that result). NEVER use it for a BANKING topic this agent does not serve (balances, transfers, cards other than this activation, a request for a human) — those go to request_handoff with off_topic so the right agent can take over, and never for a question about THIS task (just answer those).";

export const deflectAsideControl: ControlAction = {
  name: DEFLECT_ASIDE_ACTION,
  activeWhen: (ctx) => ctx.deflectAsideEnabled,
  schemaVariant: (ctx) =>
    z
      .object({
        action: z.literal(DEFLECT_ASIDE_ACTION),
        params: deflectAsideParamsSchema,
      })
      // The default below is written in the vocabulary of the domain this
      // control was measured on; a host in another domain overrides it via
      // `HandoffSpec.deflectAsideDescription`, exactly as `request_handoff`
      // allows through `actionDescription`. Mechanics stay the library's.
      .describe(ctx.deflectAsideDescription ?? DEFLECT_ASIDE_ACTION_DESCRIPTION),
  descriptionLine: () =>
    `- \`${DEFLECT_ASIDE_ACTION}\`: deflect a non-banking aside without ending the task (sole step, no prereqs); a repeat hands off.`,
  // The whole point is a mid-gate aside: the pending confirmation/OTP must
  // survive the deflection, so the control leads locked batches like the
  // handoff does.
  allowedDuringGateLockdown: true,
  allowedDuringChoicePending: true,
  sameTurnEscape: "sole",
  exclusivityGroup: "deflect",
  execute<T extends LibraryManagedSlots>(
    params: unknown,
    ctx: ControlRunContext<T>,
  ): ControlOutcome {
    const { state, msgs } = ctx;
    let aside: string;
    try {
      aside = deflectAsideParamsSchema.parse(params).aside;
    } catch (err) {
      const message =
        err instanceof z.ZodError
          ? err.issues.map((iss) => iss.message).join("; ")
          : String(err);
      const entry: StepResult = {
        action: DEFLECT_ASIDE_ACTION,
        ok: false,
        summary: msgs.invalid_params,
        error: "invalid_params",
        _debug: `Invalid params for "${DEFLECT_ASIDE_ACTION}": ${message}`,
      };
      return { entry, failed: true };
    }

    if (state.view.deflectedAside === true) {
      // The free deflection is spent — escalate atomically into the off_topic
      // handback, exactly as request_handoff would (no window where the model
      // must issue a second call).
      state.apply(
        requestHandoffPatch<T>(
          { reason: "off_topic", context: aside },
          ctx.activation.boundedChoicesEnabled,
        ),
      );
      const entry: StepResult = {
        action: DEFLECT_ASIDE_ACTION,
        ok: true,
        summary: formatMessage(msgs.handoff_requested, { reason: "off_topic" }),
        deflect_exhausted: true,
        handoff_requested: true,
        reason: "off_topic",
      };
      return { entry, failed: false };
    }

    // First aside this task: latch it, touch nothing else — the pending
    // gate/flow the caller pivoted away from is exactly what the model must
    // steer back to.
    state.apply({ deflectedAside: true } as Partial<T>);
    const entry: StepResult = {
      action: DEFLECT_ASIDE_ACTION,
      ok: true,
      summary: msgs.aside_deflected,
      deflected: true,
    };
    return { entry, failed: false };
  },
};
