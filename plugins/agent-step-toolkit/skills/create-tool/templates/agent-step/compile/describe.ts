// FILE: src/agent-step/compile/describe.ts
//
// Compose the LangChain tool's `description` field: the config's lead
// paragraph plus a bulleted INDEX of actions (one-line `summary` at most — the
// full per-action mechanics reach the model once, through the schema variants'
// `.describe()`), followed by the active controls' lines in registry order.
// Model-facing surface — same caution as compile/schema.ts.

import type { LibraryManagedSlots } from "../state.js";
import type { CompiledPlan } from "./plan.js";

export function composeToolDescription<T extends LibraryManagedSlots>(
  plan: CompiledPlan<T>,
): string {
  const lead = plan.toolLeadDescription.trim();
  const lines = [lead, "", "Actions:"];
  for (const name of plan.actionOrder) {
    const summary = plan.actions[name].summary?.trim();
    lines.push(summary ? `- \`${name}\`: ${summary}` : `- \`${name}\``);
  }
  for (const control of plan.controls) {
    lines.push(control.descriptionLine(plan.activation));
  }
  return lines.join("\n");
}
