// FILE: src/observability/configure-slot.ts
//
// Attachment fallback + attachment diagnostics (INC-2026-0045).
//
// Why this exists: @langchain/core's registerConfigureHook does NOT have
// global semantics. The hook list is stored in AsyncLocalStorage
// (setContextVariable → als.enterWith()), and CallbackManager._configureSync
// reads it back with getStore() — silently returning [] when the current
// async context does not descend from the registration. A hook registered at
// graph-module load is therefore invisible to any run whose execution context
// was created BEFORE the module was imported (e.g. a platform harness that
// creates its run-dispatch channel first). Proven in QA App Service: producer
// connected, hook registered, zero tracer events — while the identical image
// emitted everything locally.
//
// The fix attaches in the only slot that is independent of async-context
// ancestry — the same one LangSmith's own tracer occupies:
// CallbackManager._configureSync itself. installConfigureSlot() wraps that
// static (on THIS package's @langchain/core copy only — the copy the graph
// itself runs on) and appends a KafkaRunTracer with exactly the configure-hook
// semantics: gated on KAFKA_ENABLED === "true" at configure time, a fresh
// instance per configure, deduped by handler name, inheritable. Event coverage
// is identical to the hook path; only the delivery of the registration
// differs.
//
// The wrap is also the only vantage point that can DETECT the hook failure
// ("configure ran but the registered hook did not fire"): when it has to
// attach the tracer itself although the hook was registered too, the ALS
// break is a fact, and it logs one loud line with a classification of the
// store it found — the discriminating evidence for the upstream escalation.

import { CallbackManager } from "@langchain/core/callbacks/manager";
import { KafkaRunTracer } from "./run-tracer.js";
import { isKafkaEnabled, type KafkaAttachMode } from "./settings.js";

/** Idempotency marker on the CallbackManager class itself — Symbol.for so a
 *  second library copy in the process (duality) cannot double-wrap either. */
const PATCHED = Symbol.for("nbg.kafkaObservability.configureSlotInstalled");
/** The globalThis key @langchain/core AND langsmith share for the tracing
 *  AsyncLocalStorage instance (registered symbol — one instance per process). */
const TRACING_ALS_KEY = Symbol.for("ls:tracing_async_local_storage");
/** The registered symbol under which a store carries its context variables. */
const CONTEXT_VARIABLES_KEY = Symbol.for("lc:context_variables");
/** Double-startup sentinel (which library copy started, from which core). */
const STARTUP_NONCE = Symbol.for("nbg.kafkaObservability.startup");

export interface AttachDiagnostics {
  /** configure() calls observed while KAFKA_ENABLED === "true". */
  configureCalls: number;
  /** Times this wrap had to attach the tracer itself. */
  attachedBySlot: number;
  /** Times the tracer was already present (hook fired, or inherited). */
  alreadyAttached: number;
}

const diag: AttachDiagnostics = { configureCalls: 0, attachedBySlot: 0, alreadyAttached: 0 };
let hookAlsoRegistered = false;
let breakLogged = false;
let restoreOriginal: (() => void) | null = null;

export function getAttachDiagnostics(): Readonly<AttachDiagnostics> {
  return diag;
}

type AlsLike = { getStore(): unknown } | undefined;

/** Classify the ALS store visible at configure time — WHY the hook path did
 *  not deliver. Distinguishes a severed ancestry (store undefined) from a
 *  clobbered store and from a foreign-core-copy registration. */
function classifyStore(): string {
  const als = (globalThis as Record<symbol, unknown>)[TRACING_ALS_KEY] as AlsLike;
  if (!als) return "no-als-instance";
  const store = als.getStore() as Record<symbol, unknown> | undefined;
  if (store === undefined) return "store-undefined (async ancestry severed)";
  const contextVars = store[CONTEXT_VARIABLES_KEY] as Record<symbol, unknown> | undefined;
  if (!contextVars) return "store-without-context-variables";
  const hookLists = Object.getOwnPropertySymbols(contextVars).filter(
    (s) => s.description === "lc:configure_hooks",
  );
  if (hookLists.length === 0) return "context-variables-without-hooks (store clobbered)";
  // The hooks key symbol is module-local to each @langchain/core copy — a list
  // being present but unapplied means configure() ran in a different copy than
  // the one startup() registered into (CJS/ESM split or duplicate install).
  return "hooks-present-but-not-applied (foreign core copy or env gate mismatch)";
}

/** Count the configure hooks visible from the CURRENT context (boot readback:
 *  called right after registerConfigureHook, in the same synchronous frame,
 *  this proves the registration landed in a store visible at least here). */
function visibleHookCount(): number {
  const als = (globalThis as Record<symbol, unknown>)[TRACING_ALS_KEY] as AlsLike;
  const store = als?.getStore() as Record<symbol, unknown> | undefined;
  const contextVars = store?.[CONTEXT_VARIABLES_KEY] as Record<symbol, unknown> | undefined;
  if (!contextVars) return 0;
  return Object.getOwnPropertySymbols(contextVars)
    .filter((s) => s.description === "lc:configure_hooks")
    .reduce((n, s) => n + (Array.isArray(contextVars[s]) ? (contextVars[s] as unknown[]).length : 0), 0);
}

/** Wrap CallbackManager._configureSync (fallback: configure) so every
 *  configured invocation gets a KafkaRunTracer regardless of async-context
 *  ancestry. Idempotent. Pass hookAlsoRegistered=true when startup() also
 *  called registerConfigureHook — that arms the ALS-break detector (having to
 *  attach here despite a registered hook proves the hook was invisible). */
export function installConfigureSlot(options: { hookAlsoRegistered: boolean }): void {
  hookAlsoRegistered = options.hookAlsoRegistered;
  const manager = CallbackManager as unknown as Record<string | symbol, unknown>;
  if (manager[PATCHED]) return;
  // _configureSync is the funnel both CallbackManager.configure() and
  // AsyncLocalStorageProviderSingleton.runWithConfig() go through. It is an
  // underscored static — if a future core renames it, fall back to configure()
  // (covers direct invokes) and say so, rather than silently attaching nothing.
  const slotName = typeof manager._configureSync === "function"
    ? "_configureSync"
    : typeof manager.configure === "function"
      ? "configure"
      : null;
  if (slotName === null) {
    console.warn(
      "[observability] configure-slot attachment unavailable: CallbackManager has neither " +
        "_configureSync nor configure — falling back to the registered hook only",
    );
    return;
  }
  if (slotName === "configure") {
    console.warn(
      "[observability] CallbackManager._configureSync not found (upstream rename?) — " +
        "wrapping configure() instead; runWithConfig-driven invocations bypass this slot",
    );
  }
  const original = manager[slotName] as (...args: unknown[]) => unknown;
  manager[slotName] = function (this: unknown, ...args: unknown[]): unknown {
    const result = original.apply(this, args);
    if (!isKafkaEnabled()) return result; // same env gate, same strictness, checked at the same time as the hook's
    diag.configureCalls += 1;
    const mgr = (result ?? new CallbackManager()) as CallbackManager;
    const handlers = (mgr as unknown as { handlers?: Array<{ name: string }> }).handlers ?? [];
    if (handlers.some((h) => h.name === "kafka_run_tracer")) {
      diag.alreadyAttached += 1;
    } else {
      mgr.addHandler(new KafkaRunTracer(), true);
      diag.attachedBySlot += 1;
      if (hookAlsoRegistered && !breakLogged) {
        breakLogged = true;
        console.warn(
          `[observability] ALS context break detected: configure ran without the registered ` +
            `configure-hook firing (${classifyStore()}). KafkaRunTracer attached via the ` +
            `configure slot instead — events flow normally, but this runtime severs ` +
            `async-context ancestry between graph load and run execution ` +
            `(see src/observability/README.md "Attachment").`,
        );
      }
    }
    return mgr;
  };
  manager[PATCHED] = true;
  restoreOriginal = () => {
    manager[slotName] = original;
    delete manager[PATCHED];
  };
}

/** One greppable line answering, from a single boot log, every question the
 *  QA incident had to establish by experiment: which core copy registered,
 *  whether the shared ALS exists, whether the registration is visible at
 *  boot, and whether the runtime injected loader/agent flags. */
export function logAttachmentDiagnostics(mode: KafkaAttachMode): void {
  let coreUrl = "unresolvable";
  try {
    const resolve = (import.meta as { resolve?: (specifier: string) => string }).resolve;
    if (resolve) coreUrl = resolve("@langchain/core/context");
  } catch {
    // some bundlers strip import.meta.resolve — the placeholder is the info
  }
  const als = (globalThis as Record<symbol, unknown>)[TRACING_ALS_KEY];
  const nodeOptions = process.env.NODE_OPTIONS;
  console.log(
    `[observability] attachment diagnostics: mode=${mode} pid=${process.pid} core=${coreUrl} ` +
      `als=${als ? "present" : "MISSING"} hooks_visible_at_boot=${visibleHookCount()} ` +
      `node_options=${nodeOptions ? JSON.stringify(nodeOptions) : "<unset>"} ` +
      `exec_argv=${process.execArgv.length > 0 ? JSON.stringify(process.execArgv) : "[]"}`,
  );
  const g = globalThis as Record<symbol, unknown>;
  const prior = g[STARTUP_NONCE] as { pid: number; coreUrl: string } | undefined;
  if (prior && prior.coreUrl !== coreUrl) {
    console.warn(
      `[observability] duplicate library copy detected: a startup() in pid=${prior.pid} already ` +
        `registered against core=${prior.coreUrl}; this one sees core=${coreUrl}. Two copies ` +
        `of @langchain/core (or of this library) are loaded — events may be double-emitted or lost.`,
    );
  }
  g[STARTUP_NONCE] = { pid: process.pid, coreUrl, startedAt: new Date().toISOString() };
}

/** TEST SEAM: restore the original configure slot and zero the counters.
 *  Unlike registerConfigureHook (which cannot be unregistered), the slot wrap
 *  is fully reversible. */
export function __resetConfigureSlotForTests(): void {
  restoreOriginal?.();
  restoreOriginal = null;
  hookAlsoRegistered = false;
  breakLogged = false;
  diag.configureCalls = 0;
  diag.attachedBySlot = 0;
  diag.alreadyAttached = 0;
}
