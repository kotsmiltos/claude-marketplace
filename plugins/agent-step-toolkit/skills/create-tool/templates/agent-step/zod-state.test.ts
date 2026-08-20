// Isolation test for the 1.7.0 capability: the runner can derive its intra-batch
// state merger from a ZOD state schema (fields carry reducer/default metadata via
// `withLangGraph`) exactly as it does from a LangGraph `Annotation.Root`. No
// backend, no LLM — this proves the flow-controller mechanic in isolation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { MessagesZodState } from "@langchain/langgraph";
import { withLangGraph } from "@langchain/langgraph/zod";

import { defineConfig } from "./define-config.js";
import { runSteps, type BuildAgentStepToolOptions } from "./runner.js";
import type { ExecutorRegistry, VerifierRegistry } from "./types.js";
import type { LibraryManagedSlots } from "./state.js";

// A Zod state schema whose `first_wins` field carries a first-value-wins reducer
// via `withLangGraph`, and whose `last_write` field is plain (no metadata →
// `LastValue`, replace-on-write). If the runner reads reducers off the zod
// schema's channels, `first_wins` keeps the FIRST value written across a batch
// and `last_write` keeps the LAST — distinguishing the two proves the reducer was
// actually found and applied (a replace-only fallback would keep the last for both).
const ZodState = MessagesZodState.extend({
  first_wins: withLangGraph(z.string().nullable(), {
    reducer: { fn: (prev: string | null, next: string | null) => prev ?? next },
    default: (): string | null => null,
  }),
  last_write: z.string().nullable(),
});

interface ZS extends LibraryManagedSlots {
  messages?: unknown[];
  first_wins?: string | null;
  last_write?: string | null;
}

type ActionName = "write";

const selectors = { write: (s: ZS) => s };

function makeOpts(): BuildAgentStepToolOptions<ZS, ActionName, never, typeof selectors> {
  const config = defineConfig<ActionName, never>({
    tool: { name: "zod_state_tool", description: "writes two fields" },
    actions: {
      write: {
        description: "write first_wins + last_write",
        paramsSchema: z.object({ fw: z.string(), lw: z.string() }),
        prereqs: [],
        verdicts: {
          ok: {
            ok: true,
            summary: (_state, data) => `wrote ${String(data.fw)}/${String(data.lw)}`,
            body: { verdict: "ok" },
          },
        },
      },
    },
  });
  const executors: ExecutorRegistry<ZS, typeof selectors> = {
    write: async (params) => {
      const { fw, lw } = params as { fw: string; lw: string };
      return {
        verdict: "ok",
        data: { fw, lw },
        stateUpdate: { first_wins: fw, last_write: lw },
      };
    },
  };
  const verifiers: VerifierRegistry<ZS> = {};
  return { config, stateSchema: ZodState, selectors, executors, verifiers };
}

test("zod state: intra-batch merger derives reducers from the schema (first-wins vs LastValue)", async () => {
  const { body, committed } = await runSteps(
    makeOpts(),
    [
      { action: "write", params: { fw: "A", lw: "X" } },
      { action: "write", params: { fw: "B", lw: "Y" } },
    ],
    {} as ZS,
  );
  assert.equal(body.results.length, 2);
  assert.equal(body.results[0].ok, true);
  assert.equal(body.results[1].ok, true);

  const c = committed as ZS;
  // first_wins reducer `(prev, next) => prev ?? next` keeps the FIRST value.
  assert.equal(c.first_wins, "A");
  // last_write has no reducer metadata → LastValue → the SECOND value wins.
  assert.equal(c.last_write, "Y");
});

test("zod state: a single write threads through correctly from empty initial state", async () => {
  const { committed } = await runSteps(
    makeOpts(),
    [{ action: "write", params: { fw: "only", lw: "only" } }],
    {} as ZS,
  );
  const c = committed as ZS;
  assert.equal(c.first_wins, "only");
  assert.equal(c.last_write, "only");
});
