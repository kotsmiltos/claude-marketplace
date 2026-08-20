// FILE: src/agent-step/compile/gate-contract.ts
//
// Composes a confirmation gate's reply contract from the host's declared
// spec (ConfirmationOpts.replyContract as a GateContractSpec). The ENGINE
// owns the clauses it enforces — that the next reply answers the pending
// question, that a clear yes is an exact-params re-call (sole when the
// action declares soleOnExecute), and that the action is never re-called
// without a clear answer. The HOST owns everything in between: the measured
// reply categories only the domain knows (third-party speech, re-selection
// routing), joined verbatim in declaration order.
//
// The composer must never force a wording change: a clause that resists the
// frame stays a host category (host bytes), and the frame templates were
// extracted byte-for-byte from the reference host's measured closure
// contract (2026-08-08 category set).

import type { GateContractSpec } from "../types.js";

/** The action facts the frame clauses cite — supplied by compilation, never
 *  by the host (the spec cannot fork from the action it rides on). */
export interface GateContractContext {
  /** The gated action's name, as the model calls it. */
  action: string;
  /** Whether the execute re-call must be the batch's only step
   *  (`ControllerHooks.soleOnExecute`). */
  soleOnExecute: boolean;
}

/** Compose the full reply contract: engine frame (lead, yes clause, closing
 *  guard) around the host's categories. Every clause is one sentence ending
 *  in a period; clauses join with single spaces. */
export function composeGateContract(
  spec: GateContractSpec,
  ctx: GateContractContext,
): string {
  for (const [field, value] of Object.entries({
    subject: spec.subject,
    subjectNoun: spec.subjectNoun,
    executesLabel: spec.executesLabel,
  })) {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(
        `agent-step: composeGateContract requires a non-empty "${field}" (action "${ctx.action}").`,
      );
    }
  }
  if (!Array.isArray(spec.categories) || spec.categories.length === 0) {
    throw new Error(
      `agent-step: composeGateContract requires at least one reply category (action "${ctx.action}") — ` +
        "a gate with only yes/no answers keeps the generic contract instead.",
    );
  }
  const clauses = [
    `The caller's NEXT reply answers ${spec.subject}.`,
    `A clear yes addressed to this ${spec.subjectNoun} → re-call "${ctx.action}" with exactly the proposed params${
      ctx.soleOnExecute ? " as the ONLY step" : ""
    } (that executes ${spec.executesLabel}).`,
    ...spec.categories,
    `Never re-call "${ctx.action}" without a clear answer to the ${spec.subjectNoun}.`,
  ];
  return clauses.join(" ");
}
