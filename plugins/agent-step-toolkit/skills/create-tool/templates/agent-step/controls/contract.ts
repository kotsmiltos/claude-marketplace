// FILE: src/agent-step/controls/contract.ts
//
// A CONTROL is a library-owned, model-facing action that performs a pure
// orchestration transition — no domain executor, no backend I/O. Controls are
// first-class participants: one `ControlAction` implementation carries
// everything the engine needs, so adding a control never requires editing the
// compile or run phases:
//
//   - activation      — when the control is injected (schema + description +
//                       reserved-name validation), from `activeWhen`;
//   - model surface   — its schema variant and its line in the composed tool
//                       description;
//   - admission       — whether it may lead a locked batch
//                       (`allowedDuringGateLockdown`,
//                       `allowedDuringChoicePending`), how it escapes the
//                       resolved-choice same-turn lock (`sameTurnEscape`),
//                       and its batch-exclusivity group (`exclusivityGroup`);
//   - execution       — `execute()`, which applies its state transition
//                       through the batch-state patch vocabulary and returns
//                       the LLM-facing result entry.
//
// The registry (controls/registry.ts) fixes the injection ORDER — part of the
// model-facing surface, do not reorder.

import type { z } from "zod";
import type { StepResult } from "../types.js";
import type { LibraryManagedSlots } from "../state.js";
import type { SystemMessages } from "../messages.js";
import type { BatchState } from "../run/batch-state.js";
import type { BoundedChoiceRegistry } from "../interaction/bounded-choice.js";

/** What the compile phase resolved about which library features are on. Built
 *  once per plan (compile/plan.ts); drives control activation everywhere. */
export interface ControlActivation {
  /** Any action opted into a library-managed gate or flow lifecycle. */
  hasLifecycleOpts: boolean;
  handoffEnabled: boolean;
  /** Host override for the `request_handoff` schema-variant description. */
  handoffActionDescription?: string;
  boundedChoices: BoundedChoiceRegistry;
  boundedChoicesEnabled: boolean;
  /** The `deflect_aside` control (HandoffSpec.deflectAside, requires handoff):
   *  one free in-place deflection of a social aside per task before an
   *  off_topic handback fires. */
  deflectAsideEnabled: boolean;
  /** Host override for the `deflect_aside` schema-variant description (the
   *  shipped default is domain-flavoured — see HandoffSpec). */
  deflectAsideDescription?: string;
}

/** Runtime context a control's `execute` receives. Narrow on purpose: a
 *  control transitions library state through `state.apply` and composes its
 *  result entry — nothing else. */
export interface ControlRunContext<T extends LibraryManagedSlots> {
  msgs: SystemMessages;
  activation: ControlActivation;
  /** Stable identity of the current caller turn, when one exists. */
  currentCallerTurnId: string | undefined;
  state: BatchState<T>;
}

/** What a control's execution produced. The run loop pushes `entry`, takes
 *  `entry.summary` as the batch's running summary, and short-circuits the
 *  batch when `failed` is true. */
export interface ControlOutcome {
  entry: StepResult;
  failed: boolean;
}

/** Exclusivity groups, evaluated in REGISTRY order at admission: for each
 *  group, if the batch has more than one step and contains any member, the
 *  batch is refused. Group identity (not per-control checks) preserves the
 *  refusal attribution when two controls of the same family are mixed. */
export interface ExclusivityGroup {
  name: string;
  memberNames: readonly string[];
  errorCode: string;
  summary(foundAction: string, msgs: SystemMessages): string;
}

export interface ControlAction {
  name: string;
  /** Inject this control into the model-facing surface? Also gates its name
   *  reservation and its acceptance at admission/planning. (`abort_pending_input`
   *  additionally short-circuits the unknown-action guard and executes as a
   *  no-op even when inactive — see run/admission.ts.) */
  activeWhen(ctx: ControlActivation): boolean;
  /** The full `{ action, params }` schema variant, carrying the LLM-facing
   *  mechanics via `.describe()`. */
  schemaVariant(ctx: ControlActivation): z.ZodTypeAny;
  /** The control's bullet in the composed tool description. */
  descriptionLine(ctx: ControlActivation): string;
  /** May lead a batch while a confirmation/OTP/match gate lockdown is active. */
  allowedDuringGateLockdown: boolean;
  /** May lead a batch while a bounded choice is pending. */
  allowedDuringChoicePending: boolean;
  /** How the control escapes the resolved-choice same-turn lock: as the
   *  batch's ONLY step (`"sole"`), as its FIRST step (`"first"`), or not at
   *  all (`"none"`). */
  sameTurnEscape: "sole" | "first" | "none";
  /** Exclusivity-group name, or null when the control may ride along with
   *  other steps (abort). Groups are declared in controls/registry.ts. */
  exclusivityGroup: string | null;
  execute<T extends LibraryManagedSlots>(
    params: unknown,
    ctx: ControlRunContext<T>,
  ): ControlOutcome;
}
