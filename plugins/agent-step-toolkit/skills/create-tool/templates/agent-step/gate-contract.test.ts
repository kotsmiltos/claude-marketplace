// FILE: src/agent-step/gate-contract.test.ts
//
// The composed gate reply contract (Group B item B4, 2026-08-15): the engine
// writes the frame clauses it enforces — lead, exact-params yes clause,
// closing guard — around the host's measured domain categories. The frame
// templates were extracted byte-for-byte from the reference host's measured
// closure contract, so these pins hold the frame's exact bytes: a frame edit is a
// deliberate wording change for EVERY host that declares a spec.

import { test } from "node:test";
import assert from "node:assert/strict";

import { composeGateContract } from "./compile/gate-contract.js";
import type { GateContractSpec } from "./types.js";

const SPEC: GateContractSpec = {
  subject: "this irreversible-change consent question",
  subjectNoun: "consent question",
  executesLabel: "the irreversible change",
  categories: [
    "Category one → do the first thing.",
    "Category two sentence A. Category two sentence B.",
  ],
};

test("composeGateContract — frame bytes around the categories, sole-step variant", () => {
  const composed = composeGateContract(SPEC, { action: "apply_change", soleOnExecute: true });
  assert.equal(
    composed,
    "The caller's NEXT reply answers this irreversible-change consent question. " +
      'A clear yes addressed to this consent question → re-call "apply_change" with exactly the proposed params as the ONLY step (that executes the irreversible change). ' +
      "Category one → do the first thing. " +
      "Category two sentence A. Category two sentence B. " +
      'Never re-call "apply_change" without a clear answer to the consent question.',
  );
});

test("composeGateContract — without soleOnExecute the ONLY-step phrase is absent", () => {
  const composed = composeGateContract(SPEC, { action: "apply_change", soleOnExecute: false });
  assert.match(composed, /with exactly the proposed params \(that executes/u);
  assert.doesNotMatch(composed, /as the ONLY step/u);
});

test("composeGateContract — categories join verbatim in declaration order", () => {
  const composed = composeGateContract(SPEC, { action: "apply_change", soleOnExecute: true });
  const first = composed.indexOf("Category one");
  const second = composed.indexOf("Category two");
  assert.ok(first > 0 && second > first, "categories must appear in order after the yes clause");
});

test("composeGateContract — empty spec fields fail construction loudly", () => {
  assert.throws(
    () => composeGateContract({ ...SPEC, subjectNoun: "" }, { action: "a", soleOnExecute: true }),
    /non-empty "subjectNoun"/u,
  );
  assert.throws(
    () => composeGateContract({ ...SPEC, categories: [] }, { action: "a", soleOnExecute: true }),
    /at least one reply category/u,
  );
});
