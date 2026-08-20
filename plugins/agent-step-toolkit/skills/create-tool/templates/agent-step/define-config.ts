import type { AgentStepConfig } from "./types.js";

/** Identity helper — purpose is type inference (callers get autocomplete on
 *  action names, prereq names) and a stable import surface. */
export function defineConfig<A extends string, P extends string, T = unknown>(
  cfg: AgentStepConfig<A, P, T>,
): AgentStepConfig<A, P, T> {
  return cfg;
}
