// FILE: src/agent-step/capture.ts
//
// Caller-digit capture primitives. Pure, domain-agnostic schema helpers for
// tool param authoring — the runner does not call them; they exist because the
// runner's own contract dictates how a caller-dictated digit param MUST be
// shaped, and every voice host was re-deriving (or missing) the same rules:
//
//   1. THE SHAPE RULE IS A REFINEMENT, NEVER `.regex()`. A `.regex()` is
//      emitted into the MODEL-FACING JSON Schema as a `pattern` keyword,
//      turning the tool's validation rule into a precondition the model must
//      satisfy BEFORE it may emit the call — the exact inversion of "the tool
//      is the validator". The model then counts digits itself (unreliable on
//      grouped STT captures) and either withholds the call or pads an invented
//      digit to fit. A refinement is invisible to JSON Schema: the model sees
//      `type: "string"` and sends what it extracted; the runner's propose-path
//      parse bounces a bad shape as recoverable `invalid_params` — before any
//      read-back and without spending a confirmation attempt.
//   2. REFINEMENT MESSAGES CARRY NO DIGIT COUNT. The runner surfaces zod issue
//      messages through the StepResult's `_debug`, and `_debug` rides the body
//      handed BACK to the model. "must be exactly 9 digits" re-introduces,
//      through the error path, the very constraint the refinement keeps out of
//      the schema — precisely on the turn where the model is about to re-ask.
//      Say WHAT failed, never HOW MANY DIGITS. The rule is about the VALUE's
//      length; a count of something else (e.g. how many alternative readings
//      `maxCandidates` allows) says nothing about the digits and is fine.
//   3. REPRESENTATION FLIPS MUST NOT READ AS DRIFT. The confirmation gate
//      compares schema-PARSED params, so `["7070"]` and `"7070"` (or a value
//      re-sent with STT separators stripped differently) must normalize
//      identically — otherwise a caller's plain yes re-proposes instead of
//      executing. Hence the separator strip and the singleton-array collapse
//      live in the preprocess, BEFORE the compare.
//   4. THE DECLARED TYPE IS THE HONEST WIRE UNION. When a field accepts digit
//      GROUPS (an array) as well as a single string, the union must be in the
//      TYPE, not only tolerated by the preprocess: the wire schema is what the
//      model AND any shape-only wrapper validation see, and a preprocess is
//      invisible to both — with a bare string type a group-array call bounces
//      at the wrapper as a raw schema error instead of reaching the runner's
//      voice-safe `invalid_params`.
//   5. OMISSION IS THE ONLY SPELLING OF "ABSENT". Both builders are optional,
//      and an omitted field is the host's channel for "consume the carried /
//      collected value". `null` is deliberately NOT a second spelling: it is
//      not in the declared union, so a shape-only wrapper rejects it before the
//      preprocess ever runs (rule 4 cuts both ways — what the preprocess
//      tolerates but the type does not declare is unreachable anyway). Both
//      builders therefore reject it identically; do not "helpfully" special-
//      case it in one of them, which is exactly the asymmetry this rule exists
//      to prevent.
//
// The model-facing `describe` text is deliberately REQUIRED and has NO
// default: field wording is live prompt surface, tuned and QA-gated per host —
// the library never injects caller-facing or model-facing wording silently.
// See the toolkit's agent-step-api.md `<caller_digit_capture>` for the
// authoring doctrine and a proven description template to copy and adapt
// (including WHY the field should stay semantically neutral — naming the
// domain entity, e.g. "the AFM", re-activates the model's length world-
// knowledge that rule 1 exists to keep out).

import { z } from "zod";

/** Strip everything but digits from a string; pass non-strings through
 *  untouched (they fail the type check downstream, as they should). STT
 *  captures arrive with separators — "70,76", "12 34", "48/65" — which are
 *  transcription artifacts: stripping removes only separators (never adds or
 *  reorders), so shape rules still apply to the real digits afterwards. */
export const digitsOnly = (v: unknown): unknown =>
  typeof v === "string" ? v.replace(/\D/g, "") : v;

/** `digitsOnly`, but reaching inside an array branch (candidate strings). A
 *  SINGLETON array collapses to its one string so `["7070"]` and `"7070"`
 *  normalize identically — the confirmation gate compares parsed params, and a
 *  representation flip between propose and execute must never read as drift. */
export const digitsOnlyDeep = (v: unknown): unknown => {
  if (!Array.isArray(v)) return digitsOnly(v);
  const cleaned = v.map(digitsOnly);
  return cleaned.length === 1 ? cleaned[0] : cleaned;
};

/** A caller-dictated digit string (a tax number, a card-number tail). The
 *  shape check is a REFINEMENT and never a `.regex()` — see header rule 1 —
 *  and the `message` must stay COUNT-FREE — see header rule 2. */
export const callerDigits = (shape: RegExp, message: string) =>
  z.string().superRefine((v, ctx) => {
    if (!shape.test(v)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    }
  });

/** Options for `digitGroupsParam`. */
export interface DigitGroupsParamOpts {
  /** Shape of the JOINED capture (e.g. `/^\d{9}$/u`). Never surfaces in the
   *  model-facing JSON Schema (refinement, header rule 1). */
  shape: RegExp;
  /** COUNT-FREE refinement message (header rule 2), e.g.
   *  `"spokenDigits is not a usable capture"`. */
  message: string;
  /** REQUIRED model-facing field description — the library ships no wording
   *  (see header). Copy the doctrine template from agent-step-api.md
   *  `<caller_digit_capture>` and adapt it to the host. */
  describe: string;
}

/** A "transcription field" for a caller-dictated digit sequence spoken in
 *  GROUPS («δεκαεπτά, είκοσι ένα, πενήντα δύο, δύο, ογδόντα δύο» →
 *  `["17","21","52","2","82"]`): the model transcribes one array entry per
 *  spoken group — or a single string — and the JOIN happens HERE, in the
 *  preprocess, never in the model (models regroup, drop repeated groups, and
 *  lose the zero of round tens when asked to concatenate). The joined value
 *  validates via `callerDigits`. The field is OPTIONAL by construction:
 *  omission is the host's channel for "consume a carried/collected value". */
export const digitGroupsParam = (opts: DigitGroupsParamOpts) =>
  z
    .preprocess(
      (v) => {
        if (v === undefined) return undefined;
        // Entries are COERCED, not type-checked: they get joined, so a
        // non-string entry dropped to "" would silently SHORTEN the capture
        // (["17", 21] → "17") and could pass the shape rule as a wrong value.
        // Coercing keeps every spoken group in the result. (Contrast the
        // candidates builder, where each entry stays a separate value and a
        // non-string fails loudly instead — nothing can be silently lost.)
        if (Array.isArray(v)) return v.map((x) => String(x).replace(/\D/g, "")).join("");
        return digitsOnly(v);
      },
      z
        .union([
          callerDigits(opts.shape, opts.message),
          // Honest wire union (header rule 4): the array branch is what the
          // model and shape-only wrappers see; the preprocess joins it away
          // before validation, so the string branch is what actually parses.
          z.array(z.string()),
        ])
        .optional(),
    )
    .describe(opts.describe);

/** Options for `digitCandidatesParam`. */
export interface DigitCandidatesParamOpts {
  /** Shape of ONE candidate digit string (e.g. `/^\d{4,19}$/u`). */
  shape: RegExp;
  /** COUNT-FREE refinement message for the single-string branch. */
  message: string;
  /** Per-candidate refinement message for the array branch; defaults to
   *  `message`. */
  candidateMessage?: string;
  /** Upper bound on simultaneous candidate readings (default 3). */
  maxCandidates?: number;
  /** REQUIRED model-facing field description — see `DigitGroupsParamOpts`. */
  describe: string;
}

/** An ambiguous-reading digit field: a single digit string, or an ARRAY of
 *  every plausible reading of one utterance («χίλια τρία» → `["1003","10003"]`)
 *  for the EXECUTOR to try — the model never picks one reading itself.
 *  Separators are stripped and a singleton array collapses to its string
 *  (`digitsOnlyDeep`), so the confirm gate's parsed-params compare never reads
 *  a representation flip as drift. The field is OPTIONAL (hosts pair it with a
 *  mutually exclusive alternative selector or a carried-value channel). */
export const digitCandidatesParam = (opts: DigitCandidatesParamOpts) => {
  const max = opts.maxCandidates ?? 3;
  return z
    .preprocess(
      digitsOnlyDeep,
      z
        .union([
          callerDigits(opts.shape, opts.message),
          z
            .array(callerDigits(opts.shape, opts.candidateMessage ?? opts.message))
            .superRefine((values, ctx) => {
              if (values.length < 1) {
                ctx.addIssue({ code: z.ZodIssueCode.custom, message: "at least one candidate" });
              } else if (values.length > max) {
                // A count of READINGS, not of digits — see header rule 2.
                ctx.addIssue({ code: z.ZodIssueCode.custom, message: `at most ${max} candidates` });
              }
            }),
        ])
        // Optional INSIDE the preprocess, matching `digitGroupsParam`: with it
        // outside, `undefined` short-circuits before the preprocess but `null`
        // does not, so the two builders answered `null` differently (header
        // rule 5). Same wire schema either way — `required` is unaffected.
        .optional(),
    )
    .describe(opts.describe);
};
