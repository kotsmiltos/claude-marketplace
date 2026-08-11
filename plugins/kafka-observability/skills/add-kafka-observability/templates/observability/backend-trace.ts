// FILE: src/observability/backend-trace.ts
//
// Turns an outgoing backend HTTP call into a first-class RUN in the trace
// tree, so the Kafka run tracer ships a request/response event pair for it —
// the same treatment the graph, its nodes, the LLM calls and the tool runs
// already get. Opt-in: the project's backend client (ideally the single
// chokepoint every endpoint funnels through) wraps each call in
// `traceBackendCall`; nothing is traced until it does.
//
// WHY A RUN AND NOT A LOG LINE: stdout is not a durable sink in most
// deployments (log volume rotates away), so a console trace cannot answer
// "what did we send to the backend and what came back?" after the fact. A
// run, by contrast, is enveloped with the conversation's thread_id and
// carries trace_id / parent_run_id / dotted_order — so the HTTP call shows up
// NESTED under the node and tool run that issued it, permanently, next to the
// LLM turns that decided to make it.
//
// MECHANISM: RunnableLambda. Its `.invoke()` runs ensureConfig(), which merges
// the AsyncLocalStorage-stored RunnableConfig of the enclosing LangGraph node —
// so the KafkaRunTracer (and configurable.thread_id) are INHERITED without
// threading a RunnableConfig through the backend client's signature. That
// matters: the call sites (tool executors, backend clients) usually have fixed
// signatures, and widening them for a telemetry concern would ripple through
// every caller.
//
// If the async ancestry is ever severed (the INC-2026-0045 failure class
// documented in index.ts), the run degrades to its own root and its events
// envelope as thread_id "no-thread" — still emitted, still complete, just
// unparented.
//
// ─── SECURITY CONTRACT (non-negotiable) ─────────────────────────────────────
// This library's redactor (redaction.ts) masks CREDENTIALS ONLY —
// authorization / api_key / password / token / secret. It has no notion of
// the domain's PII: full card numbers, tax ids, phone numbers and customer
// names routinely arrive under generic keys (`accounts[].number`, …) that no
// credential net can know about.
//
// Therefore: `input` and the `logged` half of the callback's result MUST
// already have passed through the PROJECT's own domain redaction (e.g. a
// backend/redact.ts). Never hand this function a raw payload or a raw
// response body. The caller still gets the REAL parsed response back — that
// is the whole point of the {result, logged} split: the lambda RETURNS the
// masked view (a RunnableLambda's return value IS its run output) while the
// real value travels out through a closure.

import { AsyncLocalStorage } from "node:async_hooks";
import { RunnableLambda } from "@langchain/core/runnables";
// SIDE-EFFECT IMPORT, load-bearing — do not remove as "unused".
//
// LangChain's context propagation runs on a GLOBAL AsyncLocalStorage instance
// that must be installed before any nested runnable can inherit its parent's
// callbacks. Until it is, @langchain/core falls back to a MockAsyncLocalStorage
// that propagates nothing — and the symptom is not an error, it is that the
// child run is never created and the HTTP events SILENTLY VANISH from Kafka
// (verified: without this import the nested run emits zero events).
//
// Importing `@langchain/core/context` installs it (idempotently — the provider
// only sets the instance when none exists). `@langchain/langgraph` and this
// library's index.ts happen to install it too, so production works either
// way; this import makes the guarantee explicit instead of leaving the
// feature hostage to module import order.
import "@langchain/core/context";

/** Which attempt of a retry sequence is currently in flight. Set by the
 *  project's retry wrapper around each attempt; read here at run creation. An
 *  AsyncLocalStorage rather than a parameter so the attempt number reaches the
 *  trace without editing the backend client's signature or its call sites —
 *  and, unlike a module-level counter, it stays correct under concurrent
 *  calls. */
const attemptStore = new AsyncLocalStorage<{ attempt: number; attempts: number }>();

/** Run `fn` with the given retry-attempt context visible to `traceBackendCall`. */
export function withAttemptContext<T>(
  ctx: { attempt: number; attempts: number },
  fn: () => Promise<T>,
): Promise<T> {
  return attemptStore.run(ctx, fn);
}

/** The in-flight attempt context, or undefined for a call made outside any
 *  retry wrapper (calls that are never retried). */
export function currentAttempt(): { attempt: number; attempts: number } | undefined {
  return attemptStore.getStore();
}

export interface TracedCallOutcome<T> {
  /** The REAL value handed back to the caller — never logged. */
  result: T;
  /** The MASKED view recorded as the run's outputs — never returned to the caller. */
  logged: Record<string, unknown>;
}

export interface TracedCallInfo {
  /** Endpoint path, e.g. "position/GetCardsByCustomer" — becomes the run name. */
  endpoint: string;
  /** Backend base URL, for telling multiple backends apart downstream. */
  baseUrl: string;
  /** Request envelope/header kind, when the project distinguishes several
   *  backend header formats — any short discriminator string. */
  envelope: string;
  /** ALREADY-MASKED request payload — becomes the run's inputs. */
  input: Record<string, unknown>;
}

/** Execute `fn` as a traced child run named `http:<endpoint>`, tagged
 *  `backend-http`. Resolves with `fn`'s REAL result; the run records only the
 *  masked view. A throw from `fn` propagates unchanged to the caller and is
 *  recorded on the run as an error (the project's client must ensure its error
 *  messages are already redacted — they carry response-body fragments). */
export async function traceBackendCall<T>(
  info: TracedCallInfo,
  fn: () => Promise<TracedCallOutcome<T>>,
): Promise<T> {
  const retry = currentAttempt();
  // Captured out-of-band: the lambda's RETURN value is what the tracer records
  // as run outputs, so it must be the masked view — the real one comes out here.
  let real!: T;

  const traced = RunnableLambda.from(async (_input: Record<string, unknown>) => {
    const outcome = await fn();
    real = outcome.result;
    return outcome.logged;
  }).withConfig({
    runName: `http:${info.endpoint}`,
    tags: ["backend-http"],
    metadata: {
      backend_endpoint: info.endpoint,
      backend_base_url: info.baseUrl,
      backend_envelope: info.envelope,
      // Always present so downstream queries never special-case its absence.
      backend_attempt: retry?.attempt ?? 1,
      backend_max_attempts: retry?.attempts ?? 1,
      backend_retryable: retry !== undefined,
    },
  });

  await traced.invoke(info.input);
  return real;
}
