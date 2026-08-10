// FILE: src/agent-step/compile/validate.ts
//
// Construction-time validation. Fails at CONSTRUCTION, not on the first tool
// call — a miswired tool must surface at startup. Everything checkable from
// the config alone is checked here, including CROSS-ACTION consistency
// (a capturer's consumer must declare `requiresMatch`; an issuer's consumer
// must exist); only genuinely runtime conditions (an effect against absent
// flow state) are left to the run pipeline's defensive throws.

import type { ActionDef } from "../types.js";
import { handoffParamsSchema } from "../handoff/contract.js";
import type { BoundedChoiceRegistry } from "../interaction/bounded-choice.js";
import type { ControlActivation } from "../controls/contract.js";
import { reservedControlNames } from "../controls/registry.js";
import { channelsOf, type StateSchemaLike } from "./state-schema.js";

export interface ValidatableOptions {
  config: {
    tool: { name: string; description: string };
    actions: Record<string, ActionDef<string>>;
  };
  stateSchema?: StateSchemaLike;
  selectors: Record<string, unknown>;
  executors: Record<string, unknown>;
  verifiers: Record<string, unknown>;
  handoff?: unknown;
  boundedChoices?: BoundedChoiceRegistry;
  onErrorThreshold?: unknown;
}

/** The library-managed slots this configuration will WRITE (non-null values),
 *  derived from the features it uses. The host's state schema must carry a
 *  channel for each — the patch merger copies only fields present in the
 *  channel map, so a missing channel silently DISCARDS the write: the runner
 *  would report `needs_confirmation` while no gate was ever stored. */
function requiredManagedChannels(opts: ValidatableOptions): string[] {
  const required = new Set<string>();
  for (const action of Object.values(opts.config.actions)) {
    const c = action.controller;
    if (!c) {
      if (action.pageable) required.add("pagedRead");
      continue;
    }
    if (
      c.requiresConfirmation ||
      c.requiresOtp ||
      c.issuesOtp ||
      c.requiresMatch ||
      c.startsMatchFor
    ) {
      required.add("awaitingInput");
    }
    if (c.startsFlow || c.endsFlow || c.requiresFlow || c.issuesOtp) {
      required.add("currentFlow");
    }
    if (action.pageable) required.add("pagedRead");
  }
  if (Object.keys(opts.boundedChoices ?? {}).length > 0) {
    required.add("boundedChoice");
  }
  if (opts.handoff != null) {
    required.add("handoff");
  }
  if (opts.handoff != null || opts.onErrorThreshold != null) {
    required.add("errorCount");
  }
  return [...required];
}

export function validateConfig(opts: ValidatableOptions): void {
  const { config, selectors, executors, verifiers } = opts;
  if (!opts.stateSchema) {
    throw new Error("agent-step: buildAgentStepTool requires `stateSchema`.");
  }
  // Channel completeness: every library slot this config writes must have a
  // channel in the host schema, or the merger drops the write silently.
  const channels = channelsOf(opts.stateSchema);
  const missing = requiredManagedChannels(opts).filter((slot) => !(slot in channels));
  if (missing.length > 0) {
    throw new Error(
      `agent-step: the state schema is missing channel(s) ${missing
        .map((m) => `"${m}"`)
        .join(", ")} required by this configuration — writes to them would be ` +
        `silently discarded. Spread \`agentStepStateSpec\` (Annotation.Root) or ` +
        `\`agentStepZodShape\` (Zod) into the host state schema.`,
    );
  }
  const boundedChoices = opts.boundedChoices ?? {};
  const activation: ControlActivation = {
    // Reserved names don't depend on lifecycle opts (the abort name is always
    // reserved); pass a conservative value.
    hasLifecycleOpts: true,
    handoffEnabled: opts.handoff != null,
    boundedChoices,
    boundedChoicesEnabled: Object.keys(boundedChoices).length > 0,
    deflectAsideEnabled:
      opts.handoff != null &&
      (opts.handoff as { deflectAside?: boolean }).deflectAside === true,
  };

  const actionNames = Object.keys(config.actions);
  // `abort_pending_input` is always reserved. `request_handoff` is reserved
  // ONLY when the library handoff is opted into — a tool that does NOT pass
  // `handoff` may define its own action under that name.
  for (const reserved of reservedControlNames(activation)) {
    if (actionNames.includes(reserved)) {
      throw new Error(
        `agent-step: "${reserved}" is a reserved action name auto-injected by the library; remove it from config.actions.`,
      );
    }
  }

  for (const a of actionNames) {
    const action = config.actions[a];
    // Selectors and executors are registered 1:1 under the action name.
    if (typeof selectors[a] !== "function") {
      throw new Error(
        `agent-step: action "${a}" expects a state selector at selectors["${a}"] but none was found.`,
      );
    }
    if (typeof executors[a] !== "function") {
      throw new Error(
        `agent-step: action "${a}" expects an executor at executors["${a}"] but none was found.`,
      );
    }
    if (typeof action.description !== "string" || action.description.length === 0) {
      throw new Error(
        `agent-step: action "${a}" is missing a non-empty description.`,
      );
    }
    for (const p of action.prereqs) {
      if (!verifiers[p]) {
        throw new Error(
          `agent-step: action "${a}" lists prereq "${p}" but verifiers["${p}"] was not provided.`,
        );
      }
    }
    // Cross-action lifecycle consistency — checkable from the config alone,
    // so a miswired double-entry or OTP pair fails at startup instead of
    // mid-conversation.
    const controller = action.controller;
    if (controller?.startsMatchFor) {
      const consumerName = controller.startsMatchFor.consumer_action;
      const consumer = config.actions[consumerName];
      if (!consumer?.controller?.requiresMatch) {
        throw new Error(
          `agent-step: action "${a}" declares startsMatchFor "${consumerName}" but that consumer doesn't declare requiresMatch.`,
        );
      }
    }
    if (controller?.issuesOtp) {
      const consumerName = controller.issuesOtp.consumer_action;
      if (!config.actions[consumerName]) {
        throw new Error(
          `agent-step: action "${a}" declares issuesOtp for "${consumerName}" but no such action exists.`,
        );
      }
    }
    if (controller?.requiresMatch) {
      const capturerName = controller.requiresMatch.capturer;
      if (!config.actions[capturerName]) {
        throw new Error(
          `agent-step: action "${a}" declares requiresMatch with capturer "${capturerName}" but no such action exists.`,
        );
      }
    }
  }
  if (actionNames.length === 0) {
    throw new Error("agent-step: at least one action must be defined.");
  }

  for (const [name, choice] of Object.entries(boundedChoices)) {
    if (name.trim().length === 0) {
      throw new Error("agent-step: bounded-choice names must be non-empty.");
    }
    if (choice.description.trim().length === 0) {
      throw new Error(
        `agent-step: bounded choice "${name}" is missing a non-empty description.`,
      );
    }
    const selections = choice.selections.map((selection) => selection.trim());
    if (selections.length === 0 || selections.some((selection) => selection.length === 0)) {
      throw new Error(
        `agent-step: bounded choice "${name}" requires at least one non-empty selection.`,
      );
    }
    if (new Set(selections).size !== selections.length) {
      throw new Error(
        `agent-step: bounded choice "${name}" contains duplicate selections.`,
      );
    }
    for (const action of choice.directInputActions ?? []) {
      if (!config.actions[action]) {
        throw new Error(
          `agent-step: bounded choice "${name}" lists unknown directInputAction "${action}".`,
        );
      }
    }
    if (choice.onRepeatHandoff && !opts.handoff) {
      throw new Error(
        `agent-step: bounded choice "${name}" configures onRepeatHandoff but handoff is not enabled.`,
      );
    }
    if (choice.onRepeatHandoff) {
      const parsed = handoffParamsSchema.safeParse(choice.onRepeatHandoff);
      if (!parsed.success) {
        throw new Error(
          `agent-step: bounded choice "${name}" has an invalid onRepeatHandoff: ${parsed.error.issues
            .map((issue) => issue.message)
            .join("; ")}`,
        );
      }
    }
  }
}
