// FILE: src/agent-step/controls/bounded-choice.ts
//
// The two bounded-choice controls. They drive the overlay policy documented
// in interaction/bounded-choice.ts:
//
//   - `request_bounded_choice` persists one configured one-shot caller choice
//     WITHOUT disturbing any pending confirmation/OTP/match gate. A repeated
//     request applies the configured atomic handoff fallback (or refuses) —
//     the one-shot property is engine-owned, not prompt-owned.
//   - `resolve_bounded_choice` consumes a pending nonterminal selection. It is
//     a meta-choice: it NEVER confirms or executes a suspended domain action,
//     and it records the caller-turn identity so domain work stays locked
//     until the caller actually speaks again (fails closed without a stable
//     identity).

import { z } from "zod";
import type { StepResult } from "../types.js";
import type { LibraryManagedSlots } from "../state.js";
import type {
  ControlAction,
  ControlActivation,
  ControlOutcome,
  ControlRunContext,
} from "./contract.js";
import { handoffParamsSchema } from "../handoff/contract.js";
import {
  getBoundedChoice,
  requestHandoffPatch,
  setBoundedChoicePatch,
} from "../run/batch-state.js";
import { formatMessage } from "../messages.js";

export const REQUEST_BOUNDED_CHOICE_ACTION = "request_bounded_choice";
export const RESOLVE_BOUNDED_CHOICE_ACTION = "resolve_bounded_choice";

export const requestBoundedChoiceControl: ControlAction = {
  name: REQUEST_BOUNDED_CHOICE_ACTION,
  activeWhen: (ctx) => ctx.boundedChoicesEnabled,
  schemaVariant: (ctx: ControlActivation) => {
    const entries = Object.entries(ctx.boundedChoices);
    const choiceNames = entries.map(([name]) => name) as [string, ...string[]];
    const choiceIndex = entries
      .map(
        ([name, choice]) =>
          `- ${name}: ${choice.description} Nonterminal selections: ${choice.selections.join(", ")}.`,
      )
      .join("\n");
    return z
      .object({
        action: z.literal(REQUEST_BOUNDED_CHOICE_ACTION),
        params: z.object({ choice: z.enum(choiceNames) }),
      })
      .describe(
        "Request one configured, nonterminal caller choice as the ONLY step. " +
          "The engine records it without clearing or executing any pending confirmation/OTP/match. " +
          "After success, speak a returned `read_back` verbatim when present; otherwise use the " +
          "host prompt's fixed choice. Call whenever the configured semantic condition applies; " +
          "the engine owns first-versus-repeat detection and automatically applies the configured " +
          "repeat fallback.\n" +
          choiceIndex,
      );
  },
  descriptionLine: () =>
    `- \`${REQUEST_BOUNDED_CHOICE_ACTION}\`: persist one configured one-shot caller choice without disturbing pending domain input (sole step).`,
  allowedDuringGateLockdown: true,
  allowedDuringChoicePending: true,
  sameTurnEscape: "first",
  exclusivityGroup: "bounded-choice",
  execute<T extends LibraryManagedSlots>(
    params: unknown,
    ctx: ControlRunContext<T>,
  ): ControlOutcome {
    const { state, msgs, activation } = ctx;
    const name =
      typeof params === "object" && params !== null
        ? (params as { choice?: unknown }).choice
        : undefined;
    const choice = typeof name === "string" ? activation.boundedChoices[name] : undefined;
    if (typeof name !== "string" || !choice) {
      const entry: StepResult = {
        action: REQUEST_BOUNDED_CHOICE_ACTION,
        ok: false,
        summary: msgs.invalid_params,
        error: "invalid_params",
        _debug: "Unknown or missing bounded choice.",
      };
      return { entry, failed: true };
    }

    const prior = getBoundedChoice(state.view);
    if (prior) {
      // One-shot: the choice was already offered this conversation. Prefer the
      // configured atomic handoff fallback; refuse when none is configured.
      const repeatHandoff = choice.onRepeatHandoff
        ? handoffParamsSchema.parse(choice.onRepeatHandoff)
        : undefined;
      if (repeatHandoff && activation.handoffEnabled) {
        state.apply(
          requestHandoffPatch<T>(repeatHandoff, activation.boundedChoicesEnabled),
        );
        const summary = formatMessage(msgs.handoff_requested, {
          reason: repeatHandoff.reason,
        });
        return {
          entry: {
            action: REQUEST_BOUNDED_CHOICE_ACTION,
            ok: true,
            summary,
            choice: name,
            repeated: true,
            handoff_requested: true,
            reason: repeatHandoff.reason,
          },
          failed: false,
        };
      }
      const summary = `Bounded choice "${name}" has already been used.`;
      return {
        entry: {
          action: REQUEST_BOUNDED_CHOICE_ACTION,
          ok: false,
          summary,
          error: "bounded_choice_already_used",
          choice: name,
          status: prior.status,
        },
        failed: true,
      };
    }

    // Stamp the offering turn: resolution and direct-input consumption stay
    // locked while this turn is current (the caller must actually hear the
    // fork before anything counts as their selection — run/admission.ts).
    state.apply(
      setBoundedChoicePatch<T>({
        name,
        status: "pending",
        ...(ctx.currentCallerTurnId !== undefined
          ? { requested_on_caller_turn_id: ctx.currentCallerTurnId }
          : {}),
      }),
    );
    const readBack = choice.renderRequest?.(state.view);
    const summary = `Bounded choice "${name}" is now awaiting the caller's selection.`;
    return {
      entry: {
        action: REQUEST_BOUNDED_CHOICE_ACTION,
        ok: true,
        summary,
        choice: name,
        choice_requested: true,
        selections: [...choice.selections],
        ...(typeof readBack === "string" && readBack.length > 0
          ? { read_back: readBack }
          : {}),
      },
      failed: false,
    };
  },
};

export const resolveBoundedChoiceControl: ControlAction = {
  name: RESOLVE_BOUNDED_CHOICE_ACTION,
  activeWhen: (ctx) => ctx.boundedChoicesEnabled,
  schemaVariant: (ctx: ControlActivation) => {
    const entries = Object.entries(ctx.boundedChoices);
    const resolutionVariants = entries.map(([name, choice]) =>
      z.object({
        choice: z.literal(name),
        selection: z.enum(choice.selections as [string, ...string[]]),
      }),
    );
    const resolutionParams =
      resolutionVariants.length === 1
        ? resolutionVariants[0]
        : z.discriminatedUnion(
            "choice",
            resolutionVariants as [
              (typeof resolutionVariants)[number],
              ...(typeof resolutionVariants)[number][],
            ],
          );
    return z
      .object({
        action: z.literal(RESOLVE_BOUNDED_CHOICE_ACTION),
        params: resolutionParams,
      })
      .describe(
        "Resolve the currently pending bounded choice as the ONLY step. This is a meta-choice: " +
          "it never confirms or executes a suspended domain action. After success, speak a returned " +
          "`read_back` verbatim when present; otherwise return to the pending process question " +
          "described by the host prompt.",
      );
  },
  descriptionLine: () =>
    `- \`${RESOLVE_BOUNDED_CHOICE_ACTION}\`: consume a pending nonterminal choice without confirming a domain action (sole step).`,
  allowedDuringGateLockdown: true,
  allowedDuringChoicePending: true,
  sameTurnEscape: "first",
  exclusivityGroup: "bounded-choice",
  execute<T extends LibraryManagedSlots>(
    params: unknown,
    ctx: ControlRunContext<T>,
  ): ControlOutcome {
    const { state, msgs, activation } = ctx;
    const raw =
      typeof params === "object" && params !== null
        ? (params as { choice?: unknown; selection?: unknown })
        : {};
    const name = typeof raw.choice === "string" ? raw.choice : "";
    const selection = typeof raw.selection === "string" ? raw.selection : "";
    const configured = activation.boundedChoices[name];
    if (!configured || !configured.selections.includes(selection)) {
      const entry: StepResult = {
        action: RESOLVE_BOUNDED_CHOICE_ACTION,
        ok: false,
        summary: msgs.invalid_params,
        error: "invalid_params",
        _debug: "Unknown bounded choice or selection.",
      };
      return { entry, failed: true };
    }
    const pending = getBoundedChoice(state.view);
    if (!pending || pending.name !== name || pending.status !== "pending") {
      const summary = `Bounded choice "${name}" is not awaiting a selection.`;
      return {
        entry: {
          action: RESOLVE_BOUNDED_CHOICE_ACTION,
          ok: false,
          summary,
          error: "bounded_choice_not_pending",
          choice: name,
        },
        failed: true,
      };
    }
    if (!ctx.currentCallerTurnId) {
      // Fail closed: without a stable turn identity the same-turn lock cannot
      // hold, so the resolution must not proceed (see
      // interaction/bounded-choice.ts).
      const summary =
        "The bounded choice cannot be resolved without a stable caller-turn identity.";
      return {
        entry: {
          action: RESOLVE_BOUNDED_CHOICE_ACTION,
          ok: false,
          summary,
          error: "bounded_choice_turn_identity_unavailable",
          choice: name,
        },
        failed: true,
      };
    }
    state.apply(
      setBoundedChoicePatch<T>({
        name,
        status: "resolved",
        selection,
        resolved_on_caller_turn_id: ctx.currentCallerTurnId,
      }),
    );
    const readBack = configured.renderResolution?.(selection, state.view);
    const summary = `Bounded choice "${name}" resolved as "${selection}"; no domain action was confirmed or executed.`;
    return {
      entry: {
        action: RESOLVE_BOUNDED_CHOICE_ACTION,
        ok: true,
        summary,
        choice: name,
        selection,
        choice_resolved: true,
        ...(typeof readBack === "string" && readBack.length > 0
          ? { read_back: readBack }
          : {}),
      },
      failed: false,
    };
  },
};
