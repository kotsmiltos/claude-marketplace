// FILE: src/agent-step/controls/note-refusal.ts
//
// Engine-owned escalation ladders (journey-engine G7): the "once" rules the
// prompt used to make the model count from conversation history — explain a
// refusal once, suggest the lookup once — become configured ladders whose
// state lives in the task-scoped `spentLadders` latch. The model keeps only
// the semantic classification (the caller DECLINED or CANNOT supply a
// required detail right now); the engine owns first-versus-repeat:
//
//   - a FREE use: the latch counts it and the result returns the ladder's
//     configured instruction (explain/suggest in ONE short sentence and
//     re-ask in the SAME turn) — nothing else changes.
//   - uses spent: the control escalates ATOMICALLY into the ladder's
//     configured handoff (the same `requestHandoffPatch` the handoff control
//     applies) — no window where the model must issue a second call, and no
//     model-selectable route: the escalation contexts belong to the engine.
//
// The count-check → escalate-or-count core is `climbLadder`, shared with
// `deflect_aside` (one mechanism, one latch record; only params parsing and
// the result entry's naming differ per control). The bounded choice's repeat
// fallback stays its own: its detector is any-prior-use across pending AND
// spent, and its fallback is optional with a refuse path — different
// semantics, not a ladder.

import { z } from "zod";
import type { StepResult } from "../types.js";
import type { LibraryManagedSlots } from "../state.js";
import type {
  ControlAction,
  ControlActivation,
  ControlOutcome,
  ControlRunContext,
} from "./contract.js";
import type { HandoffRequest } from "../state.js";
import { handoffParamsSchema } from "../handoff/contract.js";
import { requestHandoffPatch } from "../run/batch-state.js";
import { formatMessage } from "../messages.js";

export const NOTE_REFUSAL_ACTION = "note_refusal";

/** One configured escalation ladder: what condition it covers (schema index),
 *  what the model does on a free use, and where the engine escalates when the
 *  free uses are spent. */
export interface EscalationLadder {
  /** One-line semantic condition, shown in the control's schema index. */
  description: string;
  /** Model-facing instruction returned on a FREE use — rides the result as
   *  its `summary`. */
  instruction: string;
  /** The handoff applied atomically when the free uses are spent. Requires
   *  the library handoff (validated at construction). */
  onExhaust: HandoffRequest;
  /** Free in-place uses before escalation. Default 1. */
  maxFreeUses?: number;
}

export type LadderRegistry = Record<string, EscalationLadder>;

/** The per-ladder use counts, task-scoped (`agentStepTaskScopedSlots`): a
 *  task-ending handback clears them; an `off_topic` roundtrip does not —
 *  a spent explanation stays spent when the same task resumes. */
export type SpentLadders = Record<string, number>;

/** The ladder mechanism itself: read the task-scoped latch for `name`, then
 *  either count a free use or apply `onExhaust` atomically (the same
 *  `requestHandoffPatch` the handoff control applies). The caller owns params
 *  parsing, `onExhaust` validation, and the result entry's naming; the core
 *  owns every state write. Shared by `note_refusal` and `deflect_aside`. */
export function climbLadder<T extends LibraryManagedSlots>(
  ctx: ControlRunContext<T>,
  name: string,
  maxFreeUses: number,
  onExhaust: HandoffRequest,
): { exhausted: true; summary: string; reason: string } | { exhausted: false } {
  const { state, msgs } = ctx;
  const spentLadders =
    (state.view as { spentLadders?: SpentLadders | null }).spentLadders ?? {};
  const spent = spentLadders[name] ?? 0;
  if (spent >= maxFreeUses) {
    state.apply(requestHandoffPatch<T>(onExhaust));
    return {
      exhausted: true,
      summary: formatMessage(msgs.handoff_requested, { reason: onExhaust.reason }),
      reason: onExhaust.reason,
    };
  }
  // Free use: count it, touch nothing else — the standing ask/gate the caller
  // stepped away from is exactly what the model must return to.
  state.apply({
    spentLadders: { ...spentLadders, [name]: spent + 1 },
  } as unknown as Partial<T>);
  return { exhausted: false };
}

export const noteRefusalControl: ControlAction = {
  name: NOTE_REFUSAL_ACTION,
  activeWhen: (ctx) => ctx.laddersEnabled,
  schemaVariant: (ctx: ControlActivation) => {
    const entries = Object.entries(ctx.ladders);
    const ladderNames = entries.map(([name]) => name) as [string, ...string[]];
    const ladderIndex = entries
      .map(([name, ladder]) => `- ${name}: ${ladder.description}`)
      .join("\n");
    return z
      .object({
        action: z.literal(NOTE_REFUSAL_ACTION),
        params: z.object({ ladder: z.enum(ladderNames) }),
      })
      .describe(
        "Record that the caller's turn matches one of the conditions below, as the ONLY step " +
          "with no answer text. The system owns first-versus-repeat: the result either returns the " +
          "instruction for the one free in-place handling (follow it in the SAME turn) or performs " +
          "the configured escalation itself (produce NO text after that result). A turn that " +
          "abandons the whole task is a cancellation instead, and a question your instructions " +
          "can answer is answered in place.\n" +
          ladderIndex,
      );
  },
  descriptionLine: () =>
    `- \`${NOTE_REFUSAL_ACTION}\`: record a turn the flow cannot serve (a configured condition; sole step); the system instructs the free handling or escalates itself.`,
  // A refusal while a gate/choice pends is classified by THAT interaction's
  // reply contract, never by the ladder.
  allowedDuringGateLockdown: false,
  sameTurnEscape: "sole",
  exclusivityGroup: "ladder",
  execute<T extends LibraryManagedSlots>(
    params: unknown,
    ctx: ControlRunContext<T>,
  ): ControlOutcome {
    const { msgs, activation } = ctx;
    const name =
      typeof params === "object" && params !== null
        ? (params as { ladder?: unknown }).ladder
        : undefined;
    const ladder = typeof name === "string" ? activation.ladders[name] : undefined;
    if (typeof name !== "string" || !ladder) {
      const entry: StepResult = {
        action: NOTE_REFUSAL_ACTION,
        ok: false,
        summary: msgs.invalid_params,
        error: "invalid_params",
        _debug: "Unknown or missing escalation ladder.",
      };
      return { entry, failed: true };
    }

    // Defensive re-validation of the configured route (already validated at
    // construction); the climb itself — count or escalate — is the shared core.
    const climb = climbLadder(
      ctx,
      name,
      ladder.maxFreeUses ?? 1,
      handoffParamsSchema.parse(ladder.onExhaust),
    );
    if (climb.exhausted) {
      return {
        entry: {
          action: NOTE_REFUSAL_ACTION,
          ok: true,
          summary: climb.summary,
          ladder: name,
          refusal_noted: true,
          ladder_exhausted: true,
          handoff_requested: true,
          reason: climb.reason,
        },
        failed: false,
      };
    }
    return {
      entry: {
        action: NOTE_REFUSAL_ACTION,
        ok: true,
        summary: ladder.instruction,
        ladder: name,
        refusal_noted: true,
      },
      failed: false,
    };
  },
};
