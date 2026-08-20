// Unit tests for the content-masking seam and its primitives
// (src/observability/content-mask.ts). Pure — no I/O, no producer.
// Run after build: node --test dist/observability/content-mask.test.js

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  applyContentMask,
  digitContentMask,
  mapStringsDeep,
  maskDigitsInText,
  type ContentField,
} from "./content-mask.js";

/** Reads a dotted path (array indices included) out of an unknown tree, so the
 *  assertions below stay readable without a cast on every hop. */
function at(value: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((acc, key) => (acc as Record<string, unknown> | undefined)?.[key], value);
}

function pick(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of keys) out[key] = source[key];
  return out;
}

describe("maskDigitsInText — long runs keep their tail", () => {
  test("a 16-digit card number collapses to ***<last4>", () => {
    assert.equal(maskDigitsInText("4111111111114410"), "***4410");
  });

  test("a 9-digit tax id collapses to ***<last4>", () => {
    assert.equal(maskDigitsInText("afm 123456789 ok"), "afm ***6789 ok");
  });

  test("exactly 7 digits is the threshold; 6 is masked digit-for-digit", () => {
    assert.equal(maskDigitsInText("1234567"), "***4567");
    assert.equal(maskDigitsInText("123456"), "######");
  });

  test("dictated digits separated by single spaces are ONE run, not many", () => {
    assert.equal(maskDigitsInText("4 1 1 1 1 1 1 1 1 1 1 1 4 4 1 0"), "***4410");
  });

  test("single dashes join a run too (grouped card/account numbers)", () => {
    assert.equal(maskDigitsInText("4111-1111-1111-4410"), "***4410");
  });

  test("a double separator breaks the run (edge case — two numbers in a sentence)", () => {
    assert.equal(maskDigitsInText("1234  5678"), "####  ####");
  });
});

describe("maskDigitsInText — short runs are masked digit-for-digit", () => {
  test("a 4-digit PIN is masked whole, length preserved", () => {
    assert.equal(maskDigitsInText("1234"), "####");
  });

  test("separators inside a short run survive so the shape stays readable", () => {
    assert.equal(maskDigitsInText("1 2 3 4"), "# # # #");
  });

  test("a dot does NOT join, so an amount is two short runs (edge case)", () => {
    assert.equal(maskDigitsInText("1234.56"), "####.##");
  });

  test("non-digit text is returned unchanged", () => {
    assert.equal(maskDigitsInText("no numbers here"), "no numbers here");
  });

  test("digits embedded in words are still digits", () => {
    assert.equal(maskDigitsInText("card2 of 3"), "card# of #");
  });
});

describe("maskDigitsInText — Unicode digits and options", () => {
  test("Arabic-Indic and full-width numerals are masked (\\p{Nd}, not \\d)", () => {
    assert.equal(maskDigitsInText("١٢٣٤"), "####");
    assert.equal(maskDigitsInText("１２３４"), "####");
  });

  test("a long Unicode run keeps its tail in the SAME script it arrived in", () => {
    assert.equal(maskDigitsInText("１２３４５６７８９"), "***６７８９");
  });

  test("keepLast: 0 masks every run whole — no tail survives", () => {
    assert.equal(maskDigitsInText("4111111111114410", { keepLast: 0 }), "################");
  });

  test("keepLast: 0 is idempotent; the default keep-tail policy is NOT (documented)", () => {
    const blanket = (s: string) => maskDigitsInText(s, { keepLast: 0 });
    assert.equal(blanket(blanket("4111111111114410")), blanket("4111111111114410"));
    assert.equal(maskDigitsInText(maskDigitsInText("4111111111114410")), "***####");
  });

  test("maskChar and keepLastMinRun are honoured", () => {
    assert.equal(maskDigitsInText("1234", { maskChar: "*" }), "****");
    assert.equal(maskDigitsInText("1234", { keepLastMinRun: 4, keepLast: 2 }), "***34");
  });
});

describe("mapStringsDeep", () => {
  test("maps strings through nested objects and arrays", () => {
    const input = { a: "1234", b: { c: ["5678", { d: "9012" }] } };
    assert.deepEqual(mapStringsDeep(input, maskDigitsInText), {
      a: "####",
      b: { c: ["####", { d: "####" }] },
    });
  });

  test("numbers, booleans, null and undefined pass verbatim (token analytics)", () => {
    const input = { output_tokens: 1450, ok: true, missing: null, absent: undefined };
    assert.deepEqual(mapStringsDeep(input, maskDigitsInText), input);
  });

  test("never mutates its input", () => {
    const input = { cardNumber: "4111111111114410" };
    mapStringsDeep(input, maskDigitsInText);
    assert.equal(input.cardNumber, "4111111111114410");
  });

  test("object keys are left alone by default", () => {
    const input = { "4111111111114410": { lastFour: "4410" } };
    assert.deepEqual(mapStringsDeep(input, maskDigitsInText), {
      "4111111111114410": { lastFour: "####" },
    });
  });

  test("keys: true masks a record keyed BY the sensitive value (the PAN-keyed slot)", () => {
    const input = { "4111111111114410": { cardNumber: "4111111111114410", lastFour: "4410" } };
    assert.deepEqual(mapStringsDeep(input, maskDigitsInText, { keys: true }), {
      "***4410": { cardNumber: "***4410", lastFour: "####" },
    });
  });

  test("keys: true collapses two keys that mask alike (edge case — documented)", () => {
    const input = { "4111111111114410": 1, "5555555555554410": 2 };
    assert.deepEqual(mapStringsDeep(input, maskDigitsInText, { keys: true }), { "***4410": 2 });
  });
});

// A response event for a chain run, shaped like the real thing: LangChain
// message envelopes, a PAN-keyed state slot, usage counters, a streaming token
// event. This fixture — not the regex tests above — is what proves the SCOPE
// claim: content masked, trace identity and analytics untouched.
const CHAIN_EVENT = {
  type: "run",
  direction: "response",
  run_id: "0f2c1e64-1111-4a2b-9c3d-4444aaaa5555",
  trace_id: "0f2c1e64-1111-4a2b-9c3d-4444aaaa5555",
  dotted_order: "20260820T101500123456Z0f2c1e64-1111-4a2b-9c3d-4444aaaa5555",
  run_type: "chain",
  name: "agent",
  tags: ["graph:step:3"],
  metadata: { thread_id: "voice-4711", langgraph_node: "agent", ls_model_name: "gpt-4.1" },
  serialized: { lc: 1, id: ["langchain", "chat_models", "azure"], kwargs: { temperature: 0 } },
  inputs: {
    messages: [
      {
        lc: 1,
        id: ["langchain_core", "messages", "HumanMessage"],
        kwargs: { content: "ο ΑΦΜ μου είναι 1 2 3 4 5 6 7 8 9", additional_kwargs: {} },
      },
    ],
    activeCardNumber: "4111111111114410",
    verifiedCards: { "4111111111114410": { cardNumber: "4111111111114410", lastFour: "4410" } },
  },
  outputs: {
    generations: [
      [
        {
          text: "Το ΑΦΜ 123456789 καταγράφηκε.",
          message: {
            kwargs: {
              content: "Το ΑΦΜ 123456789 καταγράφηκε.",
              response_metadata: { tokenUsage: { promptTokens: 1450, completionTokens: 42 } },
              usage_metadata: { input_tokens: 1450, output_tokens: 42, total_tokens: 1492 },
            },
          },
        },
      ],
    ],
  },
  events: [{ name: "new_token", time: "2026-08-20T10:15:00.500Z", kwargs: { token: "1234" } }],
  status: "success",
  start_time: "2026-08-20T10:15:00.123Z",
  end_time: "2026-08-20T10:15:02.456Z",
  latency_ms: 2333,
};

/** Every field a mask must never see — the trace tree, the timeline, and the
 *  node/model analytics. */
const OUTSIDE_SCOPE = [
  "type",
  "direction",
  "run_id",
  "trace_id",
  "dotted_order",
  "run_type",
  "name",
  "tags",
  "metadata",
  "serialized",
  "status",
  "start_time",
  "end_time",
  "latency_ms",
] as const;

describe("applyContentMask — field scoping on a realistic captured event", () => {
  const masked = applyContentMask(CHAIN_EVENT, digitContentMask({ keys: true }));

  test("trace identity, timeline, metadata and serialized survive byte-for-byte", () => {
    assert.deepEqual(pick(masked, OUTSIDE_SCOPE), pick(CHAIN_EVENT, OUTSIDE_SCOPE));
  });

  test("a dictated tax id in the prompt is masked", () => {
    assert.equal(
      at(masked, "inputs.messages.0.kwargs.content"),
      "ο ΑΦΜ μου είναι ***6789",
    );
  });

  test("a domain state slot carrying a full PAN is masked", () => {
    assert.equal(at(masked, "inputs.activeCardNumber"), "***4410");
  });

  test("the PAN used as a RECORD KEY is masked too (keys: true)", () => {
    assert.deepEqual(at(masked, "inputs.verifiedCards"), {
      "***4410": { cardNumber: "***4410", lastFour: "####" },
    });
  });

  test("the model's own completion is masked", () => {
    assert.equal(
      at(masked, "outputs.generations.0.0.message.kwargs.content"),
      "Το ΑΦΜ ***6789 καταγράφηκε.",
    );
  });

  test("numeric token/usage counters are untouched — the analytics claim", () => {
    assert.deepEqual(at(masked, "outputs.generations.0.0.message.kwargs.usage_metadata"), {
      input_tokens: 1450,
      output_tokens: 42,
      total_tokens: 1492,
    });
    assert.deepEqual(at(masked, "outputs.generations.0.0.message.kwargs.response_metadata"), {
      tokenUsage: { promptTokens: 1450, completionTokens: 42 },
    });
  });

  test("a streaming token is masked, but the event's own name/time are not", () => {
    assert.equal(at(masked, "events.0.kwargs.token"), "####");
    assert.equal(
      at(masked, "events.0.time"),
      "2026-08-20T10:15:00.500Z",
      "token timestamps are this library's own projection — masking them kills streaming latency analysis",
    );
    assert.equal(at(masked, "events.0.name"), "new_token");
  });

  test("the source event is not mutated", () => {
    assert.equal(CHAIN_EVENT.inputs.activeCardNumber, "4111111111114410");
    assert.ok("4111111111114410" in CHAIN_EVENT.inputs.verifiedCards);
  });
});

describe("applyContentMask — contract", () => {
  test("a top-level error string is masked", () => {
    const masked = applyContentMask(
      { run_id: "r-1", error: 'backend failed (500): {"cardNumber":"4111111111114410"}' },
      digitContentMask(),
    );
    assert.equal(masked.error, 'backend failed (###): {"cardNumber":"***4410"}');
    assert.equal(masked.run_id, "r-1");
  });

  test("the field name is passed to the mask, and only the four content fields are", () => {
    const seen: ContentField[] = [];
    applyContentMask(
      {
        run_id: "r-1",
        metadata: { a: 1 },
        inputs: {},
        outputs: {},
        events: [{ name: "new_token", time: "t1", kwargs: { token: "x" } }],
        error: "boom",
      },
      (value, field) => {
        seen.push(field);
        return value;
      },
    );
    assert.deepEqual(seen, ["inputs", "outputs", "events", "error"]);
  });

  test("absent content fields are never handed to the mask (edge case)", () => {
    const seen: ContentField[] = [];
    const masked = applyContentMask({ run_id: "r-1", inputs: { pin: "1234" } }, (value, field) => {
      seen.push(field);
      return value;
    });
    assert.deepEqual(seen, ["inputs"]);
    assert.equal("outputs" in masked, false);
  });

  test("a mask that returns a value verbatim leaves the event deep-equal", () => {
    assert.deepEqual(applyContentMask(CHAIN_EVENT, (value) => value), CHAIN_EVENT);
  });
});

describe("applyContentMask — the events carve-out", () => {
  test("an events entry with no kwargs is passed over entirely (edge case)", () => {
    const seen: unknown[] = [];
    const masked = applyContentMask(
      { run_id: "r-1", events: [{ name: "start", time: "2026-08-20T10:15:00.100Z" }] },
      (value) => {
        seen.push(value);
        return "MASKED";
      },
    );
    assert.deepEqual(seen, [], "nothing in that entry is content");
    assert.deepEqual(masked.events, [{ name: "start", time: "2026-08-20T10:15:00.100Z" }]);
  });

  test("a non-array events value still reaches the mask (defensive)", () => {
    const masked = applyContentMask({ events: "unexpected" }, digitContentMask());
    assert.equal(masked.events, "unexpected");
  });
});
