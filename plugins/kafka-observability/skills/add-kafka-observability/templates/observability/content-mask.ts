// FILE: src/observability/content-mask.ts
//
// The HOST-SUPPLIED content-masking seam, plus the primitives to build a policy
// from. Pure, recursive, no dependency on the rest of the module — usable in
// isolation and unit-testable without a producer/broker.
//
// WHY A SEAM AND NOT A POLICY: redaction.ts masks CREDENTIALS, which look the
// same in every application (`authorization`, `api_key`, `password`). Domain
// PII does not: whether a nine-digit run is a tax id worth masking or an order
// reference worth keeping, and whether a card number should vanish entirely or
// keep its last four, are facts about someone else's flow. Any rule this
// library picked would be a guess — and the guess fails on real payloads (a
// "mask short runs, pass long ones" rule ships a full 16-digit PAN, which is
// exactly what a card flow puts in graph state). So the library provides the
// funnel and the building blocks; the application provides the policy, the same
// division backend-trace.ts's security contract already draws.
//
// Consequence, stated plainly: nothing is masked until a host passes a
// `contentMask` to startup(). See the README for the wiring.
//
// SCOPE — a mask only ever sees the four content-bearing fields of the event
// `data` (`inputs`, `outputs`, `events`, `error`), and within `events` only
// each entry's `kwargs` (see maskRunEvents). Trace identity (run_id, trace_id,
// dotted_order), the timeline (start_time, end_time, latency_ms), `metadata`,
// `serialized` and the envelope's `thread_id` are never passed to it: masking
// those would destroy run-tree reconstruction, the timeline, the node/model
// analytics and the sink's grouping key respectively. A mask must return the
// same SHAPE it was handed — event-emitter.ts re-validates the masked data
// against the schema, so a policy that returns a string for `inputs` drops the
// event (logged) instead of corrupting the sink.

export type ContentField = "inputs" | "outputs" | "events" | "error";

/** A host masking policy. Receives one content field's value and returns the
 *  masked form. `field` is passed so a policy can treat prose (`error`) and
 *  structure (`inputs`) differently. */
export type ContentMask = (value: unknown, field: ContentField) => unknown;

/** The fields a ContentMask is applied to — exhaustive for RunEventDataSchema's
 *  content-bearing half, and deliberately closed (see the SCOPE note above). */
const CONTENT_FIELDS: readonly ContentField[] = ["inputs", "outputs", "events", "error"];

export interface DigitMaskOptions {
  /** Replacement for a single masked digit. Default "#". */
  maskChar?: string;
  /** Digits of a long run to keep. Default 4; set 0 to mask every run whole. */
  keepLast?: number;
  /** Run length at which `keepLast` applies. Default 7. */
  keepLastMinRun?: number;
}

// Unicode decimal digits (\p{Nd}), not ASCII \d — full-width (１２３) and
// Arabic-Indic (١٢٣) numerals are digits a caller can dictate and a model can
// echo, and \d would let them through untouched.
//
// A single space or dash between digits CONTINUES a run, which is what makes
// this usable on voice transcripts: dictation arrives as "4 1 1 1 1 …", and
// without the join that is sixteen one-digit runs instead of one card number.
// A dot deliberately does NOT join, so "1234.56" is masked as two short runs
// rather than read as a six-digit identifier.
//
// All three are module-level /g regexes used only through String.replace(),
// which starts at index 0 and resets lastIndex when it finishes — the same
// reason redaction.ts prefers .replace() over .test() (see its comment).
const DIGIT_RUN = /\p{Nd}(?:[ -]?\p{Nd})*/gu;
const NON_DIGIT = /\P{Nd}/gu;
const DIGIT = /\p{Nd}/gu;

/** Masks digit runs in free text. Runs of `keepLastMinRun`+ digits collapse to
 *  `***<last keepLast digits>` — the tail is what a flow itself uses to
 *  identify a card or read an id back, and it never ships a completable
 *  number. Shorter runs (PINs, OTPs, amounts) are masked digit-for-digit,
 *  preserving length and any separators.
 *
 *  NOT idempotent while `keepLast > 0`: `***4410` still contains a four-digit
 *  run, so a second pass would mask it to `***####`. The library applies a
 *  mask exactly once, at the emitter funnel. With `keepLast: 0` it IS
 *  idempotent. */
export function maskDigitsInText(text: string, opts: DigitMaskOptions = {}): string {
  const maskChar = opts.maskChar ?? "#";
  const keepLast = opts.keepLast ?? 4;
  const keepLastMinRun = opts.keepLastMinRun ?? 7;
  return text.replace(DIGIT_RUN, (run) => {
    const digits = run.replace(NON_DIGIT, "");
    if (keepLast > 0 && digits.length >= keepLastMinRun) {
      return `***${digits.slice(-keepLast)}`;
    }
    return run.replace(DIGIT, maskChar);
  });
}

export type SpokenDigitLanguage = "el" | "en";

export interface SpokenDigitMaskOptions {
  /** Replacement for one masked digit-word, and for each digit of a numeral
   *  inside a masked run. Default "#". */
  maskChar?: string;
  /** Members a run needs before it is masked. Default 3 — see the doc comment
   *  on maskSpokenDigitsInText for why. */
  minRun?: number;
  /** Language packs to match against. Default: every built-in pack. */
  languages?: readonly SpokenDigitLanguage[];
  /** Digits of a LONG run to keep, translated to numerals (`***4410`).
   *  Default 4 — parity with maskDigitsInText; set 0 to mask every run
   *  whole. */
  keepLast?: number;
  /** Run digit-count at which `keepLast` applies. Default 7 — parity with
   *  maskDigitsInText. */
  keepLastMinRun?: number;
}

// Digit words 0–9 per language, each mapped to its numeral, with the spoken
// variants and inflections ASR actually emits: Greek digit words inflect by
// gender («ένα/μία», «τρία/τρεις», «τέσσερα/τέσσερις») and have colloquial
// forms («εφτά», «οχτώ», «εννιά», «δυο»); English dictation says "oh" for
// zero. Matching is on a NORMALIZED form (lowercased, accents stripped, final
// sigma folded — see normalizeSpokenWord), so «ΤΕΣΣΕΡΑ», «τεσσερα» and
// «τέσσερα» all hit: ASR output is inconsistent about case and accents. The
// numeral value exists so a LONG run's kept tail can be translated
// («…τέσσερα τέσσερα ένα μηδέν» → `***4410` — see the keepLast rule below).
// Number words above nine («σαράντα οκτώ», "forty-eight") are deliberately
// absent — composed numbers are a semantic parse this library does not
// attempt (documented limit).
const SPOKEN_DIGIT_WORDS: Record<SpokenDigitLanguage, Readonly<Record<string, string>>> = {
  el: {
    "μηδέν": "0",
    "ένα": "1", "μία": "1", "μια": "1",
    "δύο": "2", "δυο": "2",
    "τρία": "3", "τρεις": "3",
    "τέσσερα": "4", "τέσσερις": "4",
    "πέντε": "5",
    "έξι": "6",
    "επτά": "7", "εφτά": "7",
    "οκτώ": "8", "οχτώ": "8",
    "εννέα": "9", "εννιά": "9",
  },
  en: {
    zero: "0", oh: "0",
    one: "1", two: "2", three: "3", four: "4",
    five: "5", six: "6", seven: "7", eight: "8", nine: "9",
  },
};

const ALL_SPOKEN_LANGUAGES = Object.keys(SPOKEN_DIGIT_WORDS) as readonly SpokenDigitLanguage[];

/** One normal form for dictionary and input: lowercase, strip combining
 *  accents (NFD), fold final sigma. U+0300–U+036F is the combining
 *  diacritical block NFD moves Greek tonos/dialytika (and Latin accents)
 *  into. */
function normalizeSpokenWord(word: string): string {
  return word
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ς/g, "σ");
}

function normalizedWordMap(words: Readonly<Record<string, string>>): ReadonlyMap<string, string> {
  return new Map(Object.entries(words).map(([word, digit]) => [normalizeSpokenWord(word), digit]));
}

const NORMALIZED_SPOKEN_WORDS: Record<SpokenDigitLanguage, ReadonlyMap<string, string>> = {
  el: normalizedWordMap(SPOKEN_DIGIT_WORDS.el),
  en: normalizedWordMap(SPOKEN_DIGIT_WORDS.en),
};

const NUMERAL_TOKEN = /^\p{Nd}+$/u;

/** Masks runs of consecutive SPOKEN digit words — «τέσσερα οκτώ τρία επτά»,
 *  "four eight three seven". The word-form counterpart of maskDigitsInText:
 *  on a voice channel word-form is how digits normally arrive, so a digit
 *  policy alone ships every dictated PIN and OTP verbatim. Same class of
 *  primitive — language-shaped but domain-independent — which is why it lives
 *  here and the POLICY (whether and which languages to wire) stays with the
 *  application.
 *
 *  THE RULE, out loud: consecutive digit-words joined by spaces, commas or
 *  dashes are one run; numerals and `maskChar` tokens inside it count as
 *  members too (see below); a run is masked only when it has `minRun`+
 *  members (default 3) AND at least one actual digit word. A run of
 *  `keepLastMinRun`+ digits (default 7) collapses to `***<last keepLast
 *  digits>` with the kept words TRANSLATED to numerals («…τέσσερα τέσσερα
 *  ένα μηδέν» → `***4410`) — full parity with maskDigitsInText, because the
 *  length rule discriminates the same shapes in word form: 7+ digits is a
 *  dictated identifier the flow itself reads back by its tail (card 16,
 *  ΑΦΜ 9), while shorter runs are secrets (PIN 4, OTP 6) and are masked
 *  whole, each digit-word ONE `maskChar` and a numeral digit-for-digit.
 *  Without the parity, a spoken card would lose the last-four the numeral
 *  pass deliberately keeps, purely because the caller dictated instead of
 *  typing.
 *
 *  One safety rule on the tail: it is either the REAL last digits or absent,
 *  never partial. If any of the last `keepLast` digits is unrecoverable — a
 *  `maskChar` token left by a prior digit pass — the run is masked whole
 *  instead of emitting a half-real tail.
 *
 *  minRun 3 is the prose guard: a lone «ένα» («θέλω ένα νέο PIN») or a pair
 *  («δύο τρία λεπτά») survives, while the shapes that matter — PIN (4) and
 *  OTP (6) — are always caught, as is a 3-word fragment of a PIN an ASR
 *  pause split off. Any non-member word («δύο ή τρία») or other punctuation
 *  (a dot) breaks the run.
 *
 *  Numerals and `maskChar` tokens CONTINUE a run and count toward minRun
 *  because ASR emits mixed forms («τέσσερα 8 τρία επτά») — and in the
 *  documented composition (maskDigitsInText FIRST) that numeral has already
 *  become `#` by the time this pass runs («τέσσερα # τρία επτά»). Without the
 *  continuation, either form would split one PIN into two sub-minRun runs and
 *  leak every word. Numeral-only runs are NOT this function's business —
 *  «1 2 3 4» passes through untouched (maskDigitsInText owns it).
 *
 *  Idempotency mirrors maskDigitsInText exactly: with `keepLast: 0` a second
 *  pass is a no-op; the default keep-tail policy leaves a numeral tail that a
 *  LATER DIGIT pass would re-mask (`***4410` → `***####`) — the library
 *  applies a mask once, at the emitter funnel, and the documented composition
 *  runs the digit pass BEFORE this one, so the tail survives there. */
export function maskSpokenDigitsInText(text: string, opts: SpokenDigitMaskOptions = {}): string {
  const maskChar = opts.maskChar ?? "#";
  const minRun = opts.minRun ?? 3;
  const languages = opts.languages ?? ALL_SPOKEN_LANGUAGES;
  const keepLast = opts.keepLast ?? 4;
  const keepLastMinRun = opts.keepLastMinRun ?? 7;

  // Tokens are maximal letter/digit words, or runs of the mask character (so
  // a prior digit pass's output can continue a run). Built per call because
  // maskChar is an option; String.matchAll never leaves lastIndex behind.
  const maskEsc = maskChar.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tokenPattern = new RegExp(`(?:${maskEsc})+|[\\p{L}\\p{Nd}]+`, "gu");

  type SpokenToken = {
    start: number;
    end: number;
    text: string;
    kind: "word" | "numeral" | "masked";
    /** The word's numeral value ("word" tokens only) — what a kept tail is
     *  translated with. */
    digit?: string;
  };

  // How many digits a token stands for: a word is one, a numeral is its
  // digits, a masked token is one per maskChar (each # was a digit upstream).
  const digitsOf = (t: SpokenToken): number =>
    t.kind === "word" ? 1 : t.kind === "numeral" ? [...t.text].length : t.text.length / maskChar.length;

  // The run's last `keepLast` digits, words translated to numerals — or null
  // when any of them is unrecoverable (an already-masked token), in which
  // case the caller masks the run whole: the tail is real or absent, never
  // partial.
  const tailDigits = (): string | null => {
    const digits: string[] = [];
    for (let i = run.length - 1; i >= 0 && digits.length < keepLast; i--) {
      const t = run[i];
      if (t.kind === "word") digits.unshift(t.digit as string);
      else if (t.kind === "numeral") {
        const chars = [...t.text];
        for (let j = chars.length - 1; j >= 0 && digits.length < keepLast; j--) digits.unshift(chars[j]);
      } else return null;
    }
    return digits.join("");
  };

  let out = "";
  let cursor = 0;
  let run: SpokenToken[] = [];

  // Masks the pending run (when it qualifies): a long run collapses whole to
  // `***<translated tail>` like maskDigitsInText's long-run branch; a short
  // run is spliced token-by-token, separators surviving verbatim like its
  // short-run branch.
  const flushRun = (): void => {
    if (run.length >= minRun && run.some((t) => t.kind === "word")) {
      const runDigits = run.reduce((n, t) => n + digitsOf(t), 0);
      const tail = keepLast > 0 && runDigits >= keepLastMinRun ? tailDigits() : null;
      if (tail !== null) {
        out += text.slice(cursor, run[0].start) + `***${tail}`;
        cursor = run[run.length - 1].end;
      } else {
        for (const t of run) {
          out += text.slice(cursor, t.start);
          out +=
            t.kind === "word"
              ? maskChar
              : t.kind === "numeral"
                ? t.text.replace(DIGIT, maskChar)
                : t.text;
          cursor = t.end;
        }
      }
    }
    run = [];
  };

  for (const match of text.matchAll(tokenPattern)) {
    const tokenText = match[0];
    const start = match.index;
    let kind: SpokenToken["kind"] | null = null;
    let digit: string | undefined;
    if (tokenText.startsWith(maskChar)) kind = "masked";
    else if (NUMERAL_TOKEN.test(tokenText)) kind = "numeral";
    else {
      const normalized = normalizeSpokenWord(tokenText);
      for (const lang of languages) {
        digit = NORMALIZED_SPOKEN_WORDS[lang]?.get(normalized);
        if (digit !== undefined) {
          kind = "word";
          break;
        }
      }
    }
    if (kind === null) {
      // A non-member word breaks the run even when only run-joining
      // separators surround it («δύο ή τρία» is prose, not a PIN fragment).
      flushRun();
      continue;
    }
    if (run.length > 0) {
      const gap = text.slice(run[run.length - 1].end, start);
      if (!/^[ ,-]*$/.test(gap)) flushRun();
    }
    run.push({ start, end: start + tokenText.length, text: tokenText, kind, digit });
  }
  flushRun();
  return out + text.slice(cursor);
}

/** Recursively applies `fn` to every string in a JSON-shaped value. Numbers,
 *  booleans, null and undefined pass verbatim — masking numbers would turn
 *  token/usage counters into strings and destroy the analytics the
 *  USAGE_KEY_PATTERN carve-out in redaction.ts exists to protect. Never
 *  mutates its input.
 *
 *  `keys: true` also maps OBJECT KEYS. Needed because a value can BE a key: a
 *  state slot keyed by card number (`{ "4111111111114410": {…} }`) is
 *  unreachable by any key-NAME policy, which reads keys and masks values. Off
 *  by default — rewriting keys is never done silently, and two keys that mask
 *  to the same string collapse into one entry. */
export function mapStringsDeep(
  value: unknown,
  fn: (s: string) => string,
  opts: { keys?: boolean } = {},
): unknown {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((item) => mapStringsDeep(item, fn, opts));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      out[opts.keys ? fn(key) : key] = mapStringsDeep(v, fn, opts);
    }
    return out;
  }
  return value;
}

export type DigitContentMaskOptions = DigitMaskOptions & {
  keys?: boolean;
  /** Opt-in: also mask runs of SPOKEN digit words in these languages
   *  (maskSpokenDigitsInText, sharing this policy's maskChar, keepLast and
   *  keepLastMinRun, with the default minRun of 3 — so `keepLast: 0`
   *  blankets BOTH passes). Omitted means numerals only — exactly the
   *  pre-1.7.0 behaviour. */
  spokenLanguages?: readonly SpokenDigitLanguage[];
};

/** A ready-made digit policy — `mapStringsDeep` over `maskDigitsInText`. NOT
 *  installed by the library: a host wires it explicitly, on its own judgement
 *  that blanket digit masking is right for its domain.
 *
 *  With `spokenLanguages` set, the spoken-word pass runs AFTER the numeral
 *  pass — that order is load-bearing: a numeral inside a dictated run has
 *  already become `#` («τέσσερα 8 τρία» → «τέσσερα # τρία»), and the spoken
 *  pass counts `maskChar` tokens as run members, so the mixed run is still
 *  one run of 3+, not two leaking fragments.
 *
 *  Applications that already own a domain masker should compose instead of
 *  replacing — run this pass INSIDE their key-based one, so their key rules
 *  still see (and trim) the real tails. See the README. */
export function digitContentMask(opts: DigitContentMaskOptions = {}): ContentMask {
  const maskString = opts.spokenLanguages
    ? (s: string) =>
        maskSpokenDigitsInText(maskDigitsInText(s, opts), {
          languages: opts.spokenLanguages,
          maskChar: opts.maskChar,
          keepLast: opts.keepLast,
          keepLastMinRun: opts.keepLastMinRun,
        })
    : (s: string) => maskDigitsInText(s, opts);
  return (value) => mapStringsDeep(value, maskString, { keys: opts.keys });
}

/** The `events` array is built by THIS library — sanitizeRunEvents projects
 *  each intra-run event to `{ name, time, kwargs }` — so `name` (the event
 *  kind) and `time` (the token timestamp) are machine-generated: the streaming
 *  timeline, in exactly the same category as the top-level start_time/end_time
 *  that are already out of scope. They are in scope here only by accident of
 *  nesting, and a digit policy would shred every timestamp into `##:##:##`,
 *  taking inter-token latency analysis with it. Only each entry's `kwargs`
 *  carries model/caller content, so only that reaches the mask (still under
 *  the "events" field name, so a policy knows the context). Same class of
 *  structural carve-out as USAGE_KEY_PATTERN in redaction.ts. */
function maskRunEvents(value: unknown, mask: ContentMask): unknown {
  if (!Array.isArray(value)) return mask(value, "events");
  return value.map((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return mask(entry, "events");
    }
    const record = entry as Record<string, unknown>;
    if (!("kwargs" in record)) return entry;
    return { ...record, kwargs: mask(record.kwargs, "events") };
  });
}

/** Applies `mask` to the four content fields of an event `data` object and
 *  returns a masked copy; every other field passes through untouched. Absent
 *  fields are not handed to the mask at all. Generic so callers keep their
 *  concrete type (`RunEventData`) instead of widening and casting back — the
 *  same reason redact() is generic. */
export function applyContentMask<T extends Record<string, unknown>>(
  data: T,
  mask: ContentMask,
): T {
  const out = { ...data } as Record<string, unknown>;
  for (const field of CONTENT_FIELDS) {
    if (out[field] === undefined) continue;
    out[field] = field === "events" ? maskRunEvents(out[field], mask) : mask(out[field], field);
  }
  return out as T;
}
