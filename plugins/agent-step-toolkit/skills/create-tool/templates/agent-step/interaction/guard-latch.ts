// FILE: src/agent-step/interaction/guard-latch.ts
//
// Turn-scoped latch for HOST model-input guards — "fire this note at most ONCE
// per caller turn".
//
// Why the library owns it: the ReAct loop re-enters the model several times
// within ONE caller turn (agent → tools → agent …), so a host guard whose
// condition stays true would re-inject its note on every pass. Deciding "has
// this already fired since the caller last spoke?" needs a stable caller-turn
// identity — which this library already defines and uses for confirmation
// freshness (`proposedOnCallerTurnId`) and bounded-choice stability. Hosts that
// re-derived it by scanning messages backwards for a `human` message ended up
// storing the answer in the resolved message's `additional_kwargs`, i.e. inside
// the frozen channel contract. This module is the sanctioned form.
//
// The library owns the LATCH and the turn identity ONLY. What a guard says, and
// where the host injects it, stay the host's prompt — the library never renders
// or places model-facing text.

import { resolveCallerTurnId } from "./bounded-choice.js";
import type { LibraryManagedSlots } from "../state.js";

/** Has `guardId` already fired on the CURRENT caller turn?
 *
 *  Returns false when no turn identity is available (no host
 *  `getCallerTurnId` and no message ids): an identity-less consumer keeps the
 *  unlatched behaviour rather than being silently locked out — the same
 *  stance the confirmation gate takes for `sameTurnLocked`. */
export function guardFiredOnTurn<T extends LibraryManagedSlots>(
  state: T,
  guardId: string,
  getCallerTurnId?: (state: T) => string | null | undefined,
): boolean {
  const turn = resolveCallerTurnId(state, getCallerTurnId);
  if (turn === undefined) return false;
  return state.guardTurn?.[guardId] === turn;
}

/** State patch recording that `guardId` fired on the current caller turn. Merge
 *  it into the node's return value. One entry per guard id, overwritten each
 *  turn, so the map stays bounded by the number of guards — never by call
 *  length. Returns an empty patch when no turn identity exists.
 *
 *  DOES NOT COMPOSE BY SPREADING. The patch carries a WHOLE `guardTurn` map
 *  built from the state passed in, and the slot's reducer replaces rather than
 *  merges — so firing two guards in one node and spreading both patches loses
 *  the first:
 *
 *      // WRONG — 'a' is lost; the second map wins wholesale
 *      return { ...markGuardFired(state, 'a'), ...markGuardFired(state, 'b') };
 *
 *      // RIGHT — merge the maps, not the patches
 *      return { guardTurn: { ...state.guardTurn,
 *                            ...markGuardFired(state, 'a').guardTurn,
 *                            ...markGuardFired(state, 'b').guardTurn } };
 *
 *  One guard per node is the common case and needs none of this. */
export function markGuardFired<T extends LibraryManagedSlots>(
  state: T,
  guardId: string,
  getCallerTurnId?: (state: T) => string | null | undefined,
): Partial<T> {
  const turn = resolveCallerTurnId(state, getCallerTurnId);
  if (turn === undefined) return {} as Partial<T>;
  return {
    guardTurn: { ...(state.guardTurn ?? {}), [guardId]: turn },
  } as Partial<T>;
}
