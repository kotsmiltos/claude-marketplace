// FILE: src/agent-step/interaction/bounded-choice.ts
//
// The bounded-choice OVERLAY: one host-configured, engine-owned, one-shot
// conversational choice that SUSPENDS the spoken question without clearing or
// unlocking whatever domain gate (confirmation/OTP/match) is pending
// underneath. Policy summary:
//
//   - One-shot: once requested it can never be offered again; a repeated
//     request applies the configured atomic handoff fallback (or refuses).
//   - Lockdown while PENDING: only the choice controls, abort, handoff, and
//     the explicitly configured `directInputActions` may run. This is what
//     prevents a meta-level "continue" from becoming consent for a suspended
//     permanent mutation if the model emits the wrong action.
//   - Turn-lock after a nonterminal RESOLUTION: the resolution records a
//     stable caller-turn identity, and domain work stays locked until the
//     caller speaks again — a second ReAct loop in the SAME turn cannot
//     bypass the protection. Resolution fails closed when no stable identity
//     exists (hosts that compact messages provide `getCallerTurnId`).
//   - `resolved` deliberately persists until the surrounding flow ends or a
//     terminal handoff clears it, so the same one-shot choice cannot be
//     re-offered later in the conversation.
//
// The two model-facing actions that drive this overlay live in
// controls/bounded-choice.ts; this module owns the state policy they share
// with the admission phase.

import type { HandoffRequest } from "../state.js";

/** One host-configured, engine-owned conversational choice. `selections` are
 *  the nonterminal resolutions the runner may record (for example
 *  `"continue"`). A terminal alternative should remain the built-in
 *  `request_handoff` action. When `onRepeatHandoff` is supplied, trying to
 *  request a choice which has already been offered atomically emits that
 *  handoff instead of presenting the choice twice. */
export interface BoundedChoiceDef {
  description: string;
  selections: readonly string[];
  /** Domain actions which may consume a pending choice because the caller
   *  supplied the exact detail the suspended question requested. Every other
   *  domain action remains locked until `resolve_bounded_choice` runs. */
  directInputActions?: readonly string[];
  onRepeatHandoff?: HandoffRequest;
}

export type BoundedChoiceRegistry = Record<string, BoundedChoiceDef>;

/** Return the latest caller message's stable LangGraph id. LangGraph's
 *  messages reducer assigns missing ids before a node sees state, so this is
 *  stable across every ReAct loop in one caller turn and independent of
 *  history length/compaction. Direct `runSteps` consumers may provide messages
 *  without ids; in that case the same-turn guard is deliberately unavailable
 *  rather than guessing an identity and risking a permanent deadlock. */
export function latestHumanMessageId(state: unknown): string | undefined {
  const messages =
    state && typeof state === "object"
      ? (state as { messages?: unknown[] }).messages
      : undefined;
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || typeof message !== "object") continue;
    const value = message as {
      getType?: () => string;
      _getType?: () => string;
      type?: string;
      role?: string;
      id?: unknown;
    };
    const kind =
      value.getType?.() ?? value._getType?.() ?? value.type ?? value.role ?? "";
    if (kind === "human" || kind === "user") {
      return typeof value.id === "string" && value.id.length > 0
        ? value.id
        : undefined;
    }
  }
  return undefined;
}

/** Resolve the current caller turn's stable identity: the host-provided
 *  `getCallerTurnId` when configured, else the latest human message id.
 *  Blank/whitespace collapses to `undefined` (identity unavailable). */
export function resolveCallerTurnId<T>(
  initialState: T,
  getCallerTurnId: ((state: T) => string | null | undefined) | undefined,
): string | undefined {
  const raw = getCallerTurnId
    ? getCallerTurnId(initialState)
    : latestHumanMessageId(initialState);
  return typeof raw === "string" && raw.trim().length > 0 ? raw : undefined;
}
