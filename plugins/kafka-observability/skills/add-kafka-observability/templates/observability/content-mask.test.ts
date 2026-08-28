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
  maskSpokenDigitsInText,
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

describe("maskSpokenDigitsInText — Greek forms", () => {
  test("a dictated 4-word PIN is masked one # per word", () => {
    assert.equal(maskSpokenDigitsInText("τέσσερα οκτώ τρία επτά"), "# # # #");
  });

  test("a dictated 6-word OTP is masked whole", () => {
    assert.equal(maskSpokenDigitsInText("ένα δύο τρία τέσσερα πέντε έξι"), "# # # # # #");
  });

  test("inflected and colloquial variants all match", () => {
    assert.equal(maskSpokenDigitsInText("μία δυο τρεις τέσσερις"), "# # # #");
    assert.equal(maskSpokenDigitsInText("εφτά οχτώ εννιά μηδέν"), "# # # #");
    assert.equal(maskSpokenDigitsInText("μια εννέα επτά"), "# # #");
  });

  test("accentless ASR output matches («τεσσερα», not «τέσσερα»)", () => {
    assert.equal(maskSpokenDigitsInText("τεσσερα οκτω τρια επτα"), "# # # #");
  });

  test("uppercase ASR output matches, final sigma included («ΤΡΕΙΣ»)", () => {
    assert.equal(maskSpokenDigitsInText("ΤΕΣΣΕΡΑ ΟΚΤΩ ΤΡΕΙΣ ΕΠΤΑ"), "# # # #");
    assert.equal(maskSpokenDigitsInText("Τέσσερα Οκτώ Τρία Επτά"), "# # # #");
  });
});

describe("maskSpokenDigitsInText — run semantics", () => {
  test("commas and dashes join a run like spaces, and separators survive", () => {
    assert.equal(maskSpokenDigitsInText("τέσσερα, οκτώ, τρία, επτά"), "#, #, #, #");
    assert.equal(maskSpokenDigitsInText("τέσσερα - οκτώ - τρία - επτά"), "# - # - # - #");
    assert.equal(maskSpokenDigitsInText("four,eight-three seven"), "#,#-# #");
  });

  test("a run of minRun−1 is untouched (default 3 — a pair is prose)", () => {
    assert.equal(maskSpokenDigitsInText("δύο τρία λεπτά"), "δύο τρία λεπτά");
  });

  test("a run of exactly minRun is masked", () => {
    assert.equal(maskSpokenDigitsInText("ένα δύο τρία"), "# # #");
  });

  test("a lone digit word in prose is untouched — the prose guard", () => {
    assert.equal(maskSpokenDigitsInText("θέλω ένα νέο PIN"), "θέλω ένα νέο PIN");
  });

  test("a non-digit word breaks the run («ή» between digit words)", () => {
    assert.equal(maskSpokenDigitsInText("δύο ή τρία ή τέσσερα"), "δύο ή τρία ή τέσσερα");
  });

  test("sentence punctuation breaks the run (a dot does not join)", () => {
    assert.equal(maskSpokenDigitsInText("ένα δύο. τρία τέσσερα"), "ένα δύο. τρία τέσσερα");
  });

  test("minRun option is honoured in both directions", () => {
    assert.equal(maskSpokenDigitsInText("δύο τρία", { minRun: 2 }), "# #");
    assert.equal(maskSpokenDigitsInText("ένα δύο τρία", { minRun: 4 }), "ένα δύο τρία");
  });

  test("maskChar option is honoured", () => {
    assert.equal(maskSpokenDigitsInText("τέσσερα οκτώ τρία επτά", { maskChar: "*" }), "* * * *");
  });
});

describe("maskSpokenDigitsInText — languages", () => {
  test("an English run is masked, zero and oh included", () => {
    assert.equal(maskSpokenDigitsInText("four eight three seven"), "# # # #");
    assert.equal(maskSpokenDigitsInText("oh one zero"), "# # #");
  });

  test("English is case-insensitive", () => {
    assert.equal(maskSpokenDigitsInText("FOUR EIGHT THREE SEVEN"), "# # # #");
  });

  test("a lone English digit word in prose survives", () => {
    assert.equal(maskSpokenDigitsInText("give me one moment"), "give me one moment");
  });

  test("languages: ['en'] leaves a Greek run untouched", () => {
    assert.equal(
      maskSpokenDigitsInText("τέσσερα οκτώ τρία επτά", { languages: ["en"] }),
      "τέσσερα οκτώ τρία επτά",
    );
  });

  test("languages: ['el'] leaves an English run untouched", () => {
    assert.equal(
      maskSpokenDigitsInText("four eight three seven", { languages: ["el"] }),
      "four eight three seven",
    );
  });

  test("the default covers both languages in one text", () => {
    assert.equal(
      maskSpokenDigitsInText("είπε τέσσερα οκτώ τρία επτά, then one two three four"),
      "είπε # # # #, then # # # #",
    );
  });

  test("a cross-language run still counts as one run (edge case)", () => {
    assert.equal(maskSpokenDigitsInText("τέσσερα eight τρία"), "# # #");
  });
});

describe("maskSpokenDigitsInText — numerals and prior masks inside a run", () => {
  test("a numeral counts toward the run and is masked digit-for-digit", () => {
    assert.equal(maskSpokenDigitsInText("τέσσερα 8 τρία επτά"), "# # # #");
  });

  test("a multi-digit numeral in a run is masked per digit", () => {
    assert.equal(maskSpokenDigitsInText("τέσσερα 48 τρία"), "# ## #");
  });

  test("numerals alone never form a spoken run — maskDigitsInText's job", () => {
    assert.equal(maskSpokenDigitsInText("1 2 3 4"), "1 2 3 4");
  });

  test("a numeral+word pair below minRun is untouched", () => {
    assert.equal(maskSpokenDigitsInText("ένα 2"), "ένα 2");
  });

  test("a maskChar token from a prior digit pass continues the run", () => {
    assert.equal(maskSpokenDigitsInText("τέσσερα # τρία επτά"), "# # # #");
  });

  test("the documented digits-first composition catches a mixed run end-to-end", () => {
    const composed = (s: string) => maskSpokenDigitsInText(maskDigitsInText(s));
    assert.equal(composed("το PIN είναι τέσσερα 8 τρία επτά"), "το PIN είναι # # # #");
  });

  test("idempotent: a second pass over masked output is a no-op", () => {
    const once = maskSpokenDigitsInText("τέσσερα οκτώ τρία επτά και 1 2");
    assert.equal(maskSpokenDigitsInText(once), once);
  });
});

describe("maskSpokenDigitsInText — long runs keep a translated tail (numeral parity)", () => {
  const SPOKEN_CARD =
    "τέσσερα ένα ένα ένα ένα ένα ένα ένα ένα ένα ένα ένα τέσσερα τέσσερα ένα μηδέν";

  test("a 16-word dictated card collapses to ***<last4>, words translated to numerals", () => {
    assert.equal(maskSpokenDigitsInText(SPOKEN_CARD), "***4410");
  });

  test("a 9-word dictated tax id collapses to ***<last4>", () => {
    assert.equal(
      maskSpokenDigitsInText("ο ΑΦΜ μου είναι ένα δύο τρία τέσσερα πέντε έξι επτά οκτώ εννιά"),
      "ο ΑΦΜ μου είναι ***6789",
    );
  });

  test("exactly 7 digit words is the threshold; 6 (the OTP shape) is masked whole", () => {
    assert.equal(maskSpokenDigitsInText("ένα δύο τρία τέσσερα πέντε έξι επτά"), "***4567");
    assert.equal(maskSpokenDigitsInText("ένα δύο τρία τέσσερα πέντε έξι"), "# # # # # #");
  });

  test("an English dictated card translates too, oh included", () => {
    assert.equal(
      maskSpokenDigitsInText(
        "four one one one one one one one one one one one four four one oh",
      ),
      "***4410",
    );
  });

  test("inflected/accentless/uppercase variants translate to the right digits", () => {
    assert.equal(
      maskSpokenDigitsInText("μηδέν μηδεν ΜΗΔΕΝ ΤΕΣΣΕΡΑ τέσσερις ένα μηδέν"),
      "***4410",
    );
  });

  test("separators inside a long run collapse with it, like maskDigitsInText", () => {
    assert.equal(
      maskSpokenDigitsInText("ένα, δύο, τρία, τέσσερα, πέντε, έξι, επτά, οκτώ, εννιά"),
      "***6789",
    );
  });

  test("a numeral in the tail contributes its real digits", () => {
    assert.equal(maskSpokenDigitsInText("ένα δύο τρία τέσσερα πέντε 6789"), "***6789");
  });

  test("keepLast: 0 masks every run whole — no tail survives", () => {
    assert.equal(
      maskSpokenDigitsInText("ένα δύο τρία τέσσερα πέντε έξι επτά οκτώ εννιά", { keepLast: 0 }),
      "# # # # # # # # #",
    );
  });

  test("keepLast and keepLastMinRun are honoured", () => {
    assert.equal(
      maskSpokenDigitsInText("τέσσερα οκτώ τρία επτά", { keepLastMinRun: 4, keepLast: 2 }),
      "***37",
    );
  });

  test("an unrecoverable tail (prior-masked digits) falls back to a whole mask — never a partial tail", () => {
    assert.equal(
      maskSpokenDigitsInText("ένα δύο τρία τέσσερα πέντε έξι # #"),
      "# # # # # # # #",
    );
  });

  test("digitContentMask parity: a spoken and a typed card mask to the SAME tail", () => {
    const mask = digitContentMask({ spokenLanguages: ["el", "en"] });
    assert.deepEqual(
      mask({ spoken: SPOKEN_CARD, typed: "4111111111114410" }, "inputs"),
      { spoken: "***4410", typed: "***4410" },
    );
  });

  test("digitContentMask keepLast: 0 blankets both passes", () => {
    const mask = digitContentMask({ spokenLanguages: ["el"], keepLast: 0 });
    assert.deepEqual(
      mask({ spoken: "ένα δύο τρία τέσσερα πέντε έξι επτά", typed: "1234567" }, "inputs"),
      { spoken: "# # # # # # #", typed: "#######" },
    );
  });
});

describe("maskSpokenDigitsInText — a realistic Greek utterance", () => {
  const utterance =
    "Θέλω ένα νέο PIN. Το PIN που διάλεξα είναι τέσσερα οκτώ τρία επτά και ο κωδικός που έλαβα είναι ένα δύο τρία τέσσερα πέντε έξι, ευχαριστώ.";

  test("the 4-word PIN and the 6-word OTP are fully masked, the sentence survives", () => {
    assert.equal(
      maskSpokenDigitsInText(utterance),
      "Θέλω ένα νέο PIN. Το PIN που διάλεξα είναι # # # # και ο κωδικός που έλαβα είναι # # # # # #, ευχαριστώ.",
    );
  });

  test("no digit word of either secret survives, while the prose «ένα» does", () => {
    const masked = maskSpokenDigitsInText(utterance);
    assert.equal(masked.includes("τέσσερα οκτώ τρία επτά"), false);
    assert.equal(masked.includes("ένα δύο τρία τέσσερα πέντε έξι"), false);
    assert.ok(masked.startsWith("Θέλω ένα νέο PIN."));
  });
});

describe("digitContentMask — the spokenLanguages opt-in", () => {
  test("spokenLanguages masks a spoken PIN deep in a payload", () => {
    const mask = digitContentMask({ spokenLanguages: ["el", "en"] });
    assert.deepEqual(
      mask(
        { messages: [{ content: "το PIN είναι τέσσερα οκτώ τρία επτά" }], note: "one two three" },
        "inputs",
      ),
      { messages: [{ content: "το PIN είναι # # # #" }], note: "# # #" },
    );
  });

  test("omitted spokenLanguages leaves spoken words verbatim — pre-1.7.0 behaviour, the regression guard", () => {
    const input = { content: "το PIN είναι τέσσερα οκτώ τρία επτά και ο ΑΦΜ 123456789" };
    assert.deepEqual(digitContentMask()(input, "inputs"), {
      content: "το PIN είναι τέσσερα οκτώ τρία επτά και ο ΑΦΜ ***6789",
    });
  });

  test("the numeral pass and the spoken pass compose on mixed dictation", () => {
    const mask = digitContentMask({ spokenLanguages: ["el"] });
    assert.deepEqual(mask({ content: "τέσσερα 8 τρία επτά" }, "inputs"), {
      content: "# # # #",
    });
  });

  test("keys: true runs the spoken pass over object keys too", () => {
    const mask = digitContentMask({ spokenLanguages: ["el"], keys: true });
    assert.deepEqual(mask({ "ένα δύο τρία τέσσερα": true }, "inputs"), { "# # # #": true });
  });

  test("a spokenLanguages subset does not touch the other language", () => {
    const mask = digitContentMask({ spokenLanguages: ["en"] });
    assert.deepEqual(mask({ content: "τέσσερα οκτώ τρία επτά" }, "inputs"), {
      content: "τέσσερα οκτώ τρία επτά",
    });
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
