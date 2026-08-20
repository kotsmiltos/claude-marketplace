// FILE: src/agent-step/interaction/dictation.ts
//
// The `dictation` awaiting-input kind: the engine's record of the STANDING
// QUESTION — "the customer owes a fresh value". Set declaratively per verdict
// (`ActionDef.asks`), applied by the batch finalizer, and made visible to the
// model on the final entry (`standing_ask` + `ask_contract`, run/finalize.ts).
// Non-locking by design: it is a record, not a gate — the caller may pivot.
//
// WHY the final entry decides: `ok:false` short-circuits a batch, so the last
// entry is exactly what the model relays to the caller — the conversational
// standing question. Mid-batch asks are transient by construction.
//
// NOTE (owner decision 2026-08-14): deterministic caller-turn INTERCEPTION —
// a graph node synthesizing the capture tool-call when the utterance is
// purely digit content — was built here, measured live, and REMOVED: the
// engine must never fabricate assistant turns, and real dictation arrives in
// too many part-utterance shapes (multi-breath, framed) for a syntactic
// answer test to own the turn. Captures remain the model's job; this state
// exists so results can tell the model what is owed (and so future
// engine-owned repeats/ladders have an authoritative anchor).

import type { StepResult } from "../types.js";
import type { AwaitingInput, LibraryManagedSlots } from "../state.js";
import type { CompiledPlan } from "../compile/plan.js";
import { setDictationPatch } from "../run/batch-state.js";

/** Compute the awaiting-input transition the batch's FINAL entry implies, or
 *  `undefined` for "leave the slot as it stands". Returns `null` to clear a
 *  serviced dictation. Never returns a transition over a live gate — a
 *  confirmation/OTP/match set or left standing by the batch IS the standing
 *  question; asks never stomp it. */
/** The ask the batch's FINAL entry maps to via `ActionDef.asks`, or undefined.
 *  Shared by the transition below and the finalizer's `ask_text` stamping so
 *  the two can never key differently. */
export function askOfFinalEntry<T extends LibraryManagedSlots>(
  plan: CompiledPlan<T>,
  results: StepResult[],
): import("../types.js").DictationAsk | undefined {
  const last = results[results.length - 1];
  if (!last) return undefined;
  const verdict = (last as Record<string, unknown>).verdict;
  const code =
    typeof verdict === "string"
      ? verdict
      : typeof last.error === "string"
        ? (last.error as string)
        : undefined;
  return code !== undefined ? plan.actions[last.action]?.asks[code] : undefined;
}

export function dictationAfterBatch<T extends LibraryManagedSlots>(
  plan: CompiledPlan<T>,
  results: StepResult[],
  awaiting: AwaitingInput | null,
): Partial<T> | null | undefined {
  if (awaiting && awaiting.kind !== "dictation") return undefined;
  const last = results[results.length - 1];
  if (!last) return undefined;
  const ask = askOfFinalEntry(plan, results);
  if (ask) {
    return setDictationPatch<T>(ask.action, ask.param, ask.expects);
  }
  // No ask on the final entry: a dictation standing FOR the acting action was
  // serviced by this very entry — clear it. A dictation for a DIFFERENT action
  // (an unrelated read ran) still stands: the caller still owes the value.
  if (awaiting?.kind === "dictation" && awaiting.for_action === last.action) {
    return null;
  }
  return undefined;
}
