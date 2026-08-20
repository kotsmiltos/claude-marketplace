// FILE: src/agent-step/action-describe.test.ts
//
// The composed per-action description (Group B item B3, 2026-08-15): the
// host writes a semantic lead; the engine appends the mechanics it enforces
// — the confirmation-gate marker (from the controller) and the verdict index
// (from the glossed rows, classified mechanically). These pins hold the
// exact tail bytes: a tail edit is a deliberate model-surface change for
// every host.

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

import { composeActionDescription } from "./compile/action-describe.js";
import type { ActionDef } from "./types.js";

const base = {
  description: "Does the thing.",
  paramsSchema: z.object({}),
  prereqs: [] as string[],
};

test("composeActionDescription — ungated action gets the no-gate marker", () => {
  const def: ActionDef<string> = { ...base };
  assert.equal(
    composeActionDescription(def),
    "No confirmation gate: executes on its first call. Does the thing.",
  );
});

test("composeActionDescription — gated with read_back and soleOnExecute, exact marker bytes", () => {
  const def: ActionDef<string> = {
    ...base,
    controller: {
      soleOnExecute: true,
      requiresConfirmation: { readBack: () => "recap" },
    },
  };
  assert.equal(
    composeActionDescription(def),
    "Confirmation-gated: the first call proposes with `read_back`; " +
      "a later identical re-call executes as the batch's ONLY step; " +
      "`invalid_params` is a recoverable proposal rejection with no confirmation attempt spent. " +
      "Does the thing.",
  );
});

test("composeActionDescription — bare gate (no read_back, not sole) drops both derived phrases", () => {
  const def: ActionDef<string> = { ...base, controller: { requiresConfirmation: true } };
  assert.equal(
    composeActionDescription(def),
    "Confirmation-gated: the first call proposes; a later identical re-call executes; " +
      "`invalid_params` is a recoverable proposal rejection with no confirmation attempt spent. " +
      "Does the thing.",
  );
});
