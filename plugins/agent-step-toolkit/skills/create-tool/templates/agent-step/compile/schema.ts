// FILE: src/agent-step/compile/schema.ts
//
// The model-facing input schema: `{ steps: Step[] }`, a discriminated union
// over the compiled domain actions (in config order) followed by the active
// controls (in registry order). Each variant carries its full LLM-facing
// mechanics via `.describe()` — the composed tool description never repeats
// them (compile/describe.ts).
//
// THIS OUTPUT IS EMPIRICALLY TUNED MODEL SURFACE. Variant order, descriptions,
// and the absence of value-shape keywords are all measured-brittle; changes
// here must re-verify against the host's model-surface golden and prompt-input
// layer.

import { z } from "zod";
import type { LibraryManagedSlots } from "../state.js";
import type { CompiledPlan } from "./plan.js";

export function buildStepSchema<T extends LibraryManagedSlots>(plan: CompiledPlan<T>) {
  const stepVariants = plan.actionOrder.map((name) => {
    const action = plan.actions[name];
    return z
      .object({ action: z.literal(name), params: action.effectiveSchema })
      .describe(action.description);
  });
  for (const control of plan.controls) {
    stepVariants.push(
      control.schemaVariant(plan.activation) as (typeof stepVariants)[number],
    );
  }
  const StepSchema =
    stepVariants.length === 1
      ? stepVariants[0]
      : z.discriminatedUnion(
          "action",
          stepVariants as [
            (typeof stepVariants)[number],
            ...(typeof stepVariants)[number][],
          ],
        );
  // NOTE: no `.min(1)` — `minItems` is not permitted under OpenAI strict
  // structured outputs. An empty batch is handled gracefully by the run
  // pipeline (the step loops are length-guarded and simply produce no
  // results).
  return z.object({
    steps: z.array(StepSchema),
  });
}
