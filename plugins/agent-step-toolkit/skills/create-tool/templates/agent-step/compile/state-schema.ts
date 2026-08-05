// FILE: src/agent-step/compile/state-schema.ts
//
// The host's state schema, and the intra-batch patch merger derived from it.
// Resolved ONCE at compile time (compile/plan.ts) and closed over — never
// re-derived per batch or per step.

import { schemaMetaRegistry } from "@langchain/langgraph/zod";
import type { z } from "zod";

/** Minimal shape of a LangGraph `Annotation.Root` we depend on: a `spec` map.
 *  Channels are typed as `unknown` because LangGraph's `BaseChannel` doesn't
 *  expose its operator in a structurally-typed way. The merger extracts the
 *  reducer at runtime via a cast — `BinaryOperatorAggregate` exposes
 *  `operator`, `LastValue` has none (replace-on-write). */
interface LangGraphAnnotationLike {
  spec: Record<string, unknown>;
}

/** The host's state schema, accepted in either supported form:
 *  - a LangGraph `Annotation.Root` (channels live on `.spec`), or
 *  - a Zod object schema whose fields carry reducer/default metadata via
 *    `withLangGraph` (channels are derived through the langgraph zod registry).
 *  Both resolve to the same channel classes, so the merger treats them
 *  uniformly. */
export type StateSchemaLike = LangGraphAnnotationLike | z.ZodObject<z.ZodRawShape>;

/** Get the `{ field: channel }` map for either schema form. An `Annotation.Root`
 *  exposes it directly on `.spec`; a Zod object is converted through the public
 *  langgraph zod registry, which yields the SAME channel classes
 *  (`BinaryOperatorAggregate` / `LastValue`). */
export function channelsOf(stateSchema: StateSchemaLike): Record<string, unknown> {
  if ("spec" in stateSchema && (stateSchema as LangGraphAnnotationLike).spec) {
    return (stateSchema as LangGraphAnnotationLike).spec;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return schemaMetaRegistry.getChannelsForSchema(stateSchema as any) as Record<string, unknown>;
}

/** `(a, b) => merged` — merges patch `b` over patch `a` by invoking each
 *  channel's reducer (`BinaryOperatorAggregate.operator`). Channels without an
 *  operator (e.g. `LastValue`) get replace-on-write. */
export type PatchMerger<T> = (a: Partial<T>, b: Partial<T>) => Partial<T>;

/** Derive the patch merger from a host state schema. The `messages` field is
 *  explicitly skipped — the runner emits its own `ToolMessage` at commit time;
 *  merging intermediate messages would double-count. The channel map is
 *  resolved ONCE here (not per merge) and closed over. */
export function buildMergerFromStateSchema<T>(stateSchema: StateSchemaLike): PatchMerger<T> {
  const channels = channelsOf(stateSchema);
  return (a, b) => {
    const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
    for (const [field, channel] of Object.entries(channels)) {
      if (field === "messages") continue;
      const bv = (b as Record<string, unknown>)[field];
      if (bv === undefined) continue;
      const av = (a as Record<string, unknown>)[field];
      const operator = (channel as { operator?: (a: unknown, b: unknown) => unknown })
        .operator;
      out[field] = typeof operator === "function" ? operator(av, bv) : bv;
    }
    return out as Partial<T>;
  };
}
