// FILE: src/agent-step/guard-latch.test.ts
//
// The turn-scoped latch for HOST model-input guards. Shipped in 2.3.0 with no
// tests at all, which is exactly backwards for a library whose proposition is a
// verified contract: a host that adopts it inherits nothing.
//
// What must hold: fire at most ONCE per caller turn even though the ReAct loop
// re-enters the model several times inside that turn; re-arm when the caller
// speaks again; keep guards independent; and stay UNLATCHED (never silently
// locked out) when no turn identity exists.

import { test } from "node:test";
import assert from "node:assert/strict";
import { guardFiredOnTurn, markGuardFired } from "./interaction/guard-latch.js";
import type { LibraryManagedSlots } from "./state.js";

interface S extends LibraryManagedSlots {
  messages?: { id?: string; getType?: () => string }[];
}

const human = (id: string) => ({ id, getType: () => "human" });
const ai = (id: string) => ({ id, getType: () => "ai" });

/** One caller turn: the caller spoke, then the ReAct loop added model/tool turns. */
const turn = (callerId: string): S => ({
  messages: [human("h-0"), ai("a-0"), human(callerId), ai("a-1")],
});

test("latch: unfired on a fresh turn, fired after marking", () => {
  const state = turn("h-1");
  assert.equal(guardFiredOnTurn(state, "escalation_refire"), false);
  const patch = markGuardFired(state, "escalation_refire");
  assert.deepEqual(patch, { guardTurn: { escalation_refire: "h-1" } });
  assert.equal(guardFiredOnTurn({ ...state, ...patch }, "escalation_refire"), true);
});

test("latch: survives the ReAct loop re-entering the model in the SAME turn", () => {
  // The whole point: the guard's condition is still true on the next pass, and
  // the note must NOT be injected again.
  const state = turn("h-1");
  const latched = { ...state, ...markGuardFired(state, "digit_retry") };
  const afterToolHop: S = {
    ...latched,
    messages: [...(latched.messages ?? []), ai("a-2")],
  };
  assert.equal(guardFiredOnTurn(afterToolHop, "digit_retry"), true);
});

test("latch: re-arms when the CALLER speaks again", () => {
  const first = turn("h-1");
  const latched = { ...first, ...markGuardFired(first, "digit_retry") };
  // New caller turn — same guard, different turn id.
  const next: S = { ...latched, messages: [...(latched.messages ?? []), human("h-2")] };
  assert.equal(guardFiredOnTurn(next, "digit_retry"), false);
  // …and marking overwrites rather than accumulating: one entry per guard id.
  const patch = markGuardFired(next, "digit_retry");
  assert.deepEqual(patch, { guardTurn: { digit_retry: "h-2" } });
});

test("latch: guards are independent within one turn", () => {
  const state = turn("h-1");
  const a = { ...state, ...markGuardFired(state, "guard_a") };
  assert.equal(guardFiredOnTurn(a, "guard_a"), true);
  assert.equal(guardFiredOnTurn(a, "guard_b"), false);
  // Chaining (mark against the UPDATED state) keeps both.
  const both = { ...a, ...markGuardFired(a, "guard_b") };
  assert.equal(guardFiredOnTurn(both, "guard_a"), true);
  assert.equal(guardFiredOnTurn(both, "guard_b"), true);
});

test("latch: spreading two patches built from the SAME state loses the first", () => {
  // Pinned because it is a real sharp edge, not because it is desirable: the
  // patch carries a whole `guardTurn` map and the slot's reducer REPLACES. The
  // doc-comment documents the chaining/merging alternatives; this test makes
  // the trap visible so it cannot change silently.
  const state = turn("h-1");
  const wrong = { ...state, ...markGuardFired(state, "a"), ...markGuardFired(state, "b") };
  assert.equal(guardFiredOnTurn(wrong, "a"), false, "the first guard is lost");
  assert.equal(guardFiredOnTurn(wrong, "b"), true);
  // The documented merge-the-maps form keeps both.
  const right: S = {
    ...state,
    guardTurn: {
      ...state.guardTurn,
      ...markGuardFired(state, "a").guardTurn,
      ...markGuardFired(state, "b").guardTurn,
    },
  };
  assert.equal(guardFiredOnTurn(right, "a"), true);
  assert.equal(guardFiredOnTurn(right, "b"), true);
});

test("latch: no turn identity → UNLATCHED, never silently locked out", () => {
  // Messages without ids (direct `runSteps` consumers). The stance mirrors the
  // confirmation gate's `sameTurnLocked`: prefer the unlatched behaviour over a
  // permanent deadlock.
  const idless: S = { messages: [{ getType: () => "human" }] };
  assert.deepEqual(markGuardFired(idless, "g"), {});
  assert.equal(guardFiredOnTurn(idless, "g"), false);
  // Even with a stale latch present, an absent identity cannot report "fired".
  assert.equal(guardFiredOnTurn({ ...idless, guardTurn: { g: "h-1" } }, "g"), false);
});

test("latch: a host `getCallerTurnId` hook overrides the message-id default", () => {
  // Hosts whose middleware supplies a real turn id are not tied to message ids.
  const hook = (s: S) => (s as { callerTurn?: string }).callerTurn;
  const state = { ...turn("h-1"), callerTurn: "call-42" } as S;
  const patch = markGuardFired(state, "g", hook);
  assert.deepEqual(patch, { guardTurn: { g: "call-42" } });
  assert.equal(guardFiredOnTurn({ ...state, ...patch }, "g", hook), true);
  // The default resolution disagrees, proving the hook was used.
  assert.equal(guardFiredOnTurn({ ...state, ...patch }, "g"), false);
});
