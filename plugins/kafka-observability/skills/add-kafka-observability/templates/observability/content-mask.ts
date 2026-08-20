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

export type DigitContentMaskOptions = DigitMaskOptions & { keys?: boolean };

/** A ready-made digit policy — `mapStringsDeep` over `maskDigitsInText`. NOT
 *  installed by the library: a host wires it explicitly, on its own judgement
 *  that blanket digit masking is right for its domain.
 *
 *  Applications that already own a domain masker should compose instead of
 *  replacing — run this pass INSIDE their key-based one, so their key rules
 *  still see (and trim) the real tails. See the README. */
export function digitContentMask(opts: DigitContentMaskOptions = {}): ContentMask {
  return (value) => mapStringsDeep(value, (s) => maskDigitsInText(s, opts), { keys: opts.keys });
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
