// FILE: src/agent-step/run/execution.ts
//
// Sequential step execution. Each planned step dispatches to either a CONTROL
// (library-owned transition, controls/) or the DOMAIN pipeline below. Any step
// may short-circuit the batch: a control failure, a gate refusal, a prereq
// denial, a param-validation failure, an exhausted confirmation, or a non-ok
// executor all set `failedAt` and stop the loop. Earlier steps' state patches
// stay applied (cumulative commit on partial failure — see run/batch-state.ts).
//
// DOMAIN STEP ORDER (behavior — do not reorder):
//   1. `requiresFlow` gate            (before confirm-mode resolution, so a
//   2. user-declared prereqs           doomed mutation never proposes)
//   3. confirm propose / re-propose   (validate params, store gate + caller
//                                      turn id, NO executor; consumes a
//                                      pending bounded choice ON ACCEPTANCE)
//   4. confirm same-turn lock         (matching re-call on the propose turn —
//                                      refuse, no attempt spent, gate intact)
//   5. confirm exhausted              (clear gate, error out)
//   6. confirm execute                (clear gate atomically, fall through)
//   7. OTP gate                       (live view — same-batch [consumer,
//                                      issuer] chains work)
//   8. match gate                     (BATCH-START frozen — the double-entry
//                                      repeat must arrive in a separate turn)
//   9. OTP-issue-vs-match ordering    (live view)
//  10. param validation               (the action's effective schema; success
//                                      consumes a pending bounded choice — a
//                                      refused/malformed step never burns the
//                                      one-shot)
//  11. pageable cache short-circuit   (self-paginate re-page skips the executor)
//  12. executor invocation
//
// POST-EXECUTION EFFECT ORDER (behavior — do not reorder):
//   a. `invalidatesOnChange` cascade  (BEFORE stateUpdate, so the executor's
//      own re-writes of downstream slots win over the nulls)
//   b. `stateUpdate`                  (domain slots only — guarded)
//   c. `request_handoff` effect      (terminal cleanup + handoff slot; the
//      point where v1 hosts wrote the slot through stateUpdate)
//   d. pageable cache patch
//   e. ok-only lifecycle: flow open/merge → `otp_issued` → OTP/match gate
//      consumption → `startsMatchFor` → `endsFlow` — SKIPPED once a handoff
//      is set (handoff monotonicity: nothing may reopen interaction state)
//   f. ok:false match-mismatch accounting (decrement / exhaust+abort) —
//      likewise skipped once a handoff is set
//   g. `clear_awaiting_input` / `abort_flow` effects (regardless of ok)
//
// HANDOFF MONOTONICITY: once `handoff` is non-null in the view, the batch is
// terminal — sections e/f are skipped and the loop ends after the current
// step, whatever `ok` was.

import { z } from "zod";
import type { ExecutorEffect, StepResult } from "../types.js";
import type { LibraryManagedSlots } from "../state.js";
import { formatMessage } from "../messages.js";
import type { CompiledPlan } from "../compile/plan.js";
import { CONTROL_REGISTRY } from "../controls/registry.js";
import type { ControlRunContext } from "../controls/contract.js";
import {
  applyPagination,
  tryPageFromCache,
  type PagedCache,
} from "../paginate.js";
import { CONFIRMATION_DEFAULTS } from "../interaction/confirmation.js";
import { refuseOtpNotPending, refuseOtpIssueWhileMatchPending } from "../interaction/otp.js";
import {
  MATCH_DEFAULT_MAX_ATTEMPTS,
  matchMismatchLifecycle,
  refuseMatchNotPending,
} from "../interaction/match.js";
import { refuseWrongFlow, flowAfterOkStep } from "../interaction/flow.js";
import {
  assertDomainOnlyStateUpdate,
  clearAwaitingInputPatch,
  clearInteractionPatch,
  getAwaitingInput,
  getBoundedChoice,
  getCurrentFlow,
  getHandoff,
  requestHandoffPatch,
  setAwaitingMatchPatch,
  setAwaitingOtpPatch,
  setBoundedChoicePatch,
  setConfirmationPatch,
  setCurrentFlowPatch,
  type BatchState,
} from "./batch-state.js";
import { valueEqual } from "./value-equal.js";
import type { PlannedStep } from "./planning.js";

export interface ExecutionOutcome {
  results: StepResult[];
  failedAt: number | undefined;
  lastSummary: string;
  /** Whether any step actually invoked its executor — the error counter's
   *  neutrality rule keys on it (run/finalize.ts). */
  anExecutorRan: boolean;
}

export async function executeSteps<T extends LibraryManagedSlots>(
  plan: CompiledPlan<T>,
  planned: PlannedStep[],
  st: BatchState<T>,
  currentCallerTurnId: string | undefined,
): Promise<ExecutionOutcome> {
  const { msgs, activation } = plan;
  const choiceEnabled = activation.boundedChoicesEnabled;
  const results: StepResult[] = [];
  let failedAt: number | undefined;
  let lastSummary = "";
  let anExecutorRan = false;

  // Snapshot the awaiting-input gate as it stood at BATCH START — the match
  // gate's consumer check is frozen against it (interaction/match.ts). The OTP
  // gate deliberately reads the live view instead.
  const batchStartAwaiting = getAwaitingInput(st.view);

  const controlCtx: ControlRunContext<T> = {
    msgs,
    activation,
    currentCallerTurnId,
    state: st,
  };

  const fail = (entry: StepResult): void => {
    results.push(entry);
    lastSummary = entry.summary as string;
    failedAt = results.length - 1;
  };

  for (const step of planned) {
    // ─── Control dispatch. Admission already refused inactive control names
    //     as unknown (abort excepted — it degrades to a no-op when inactive).
    if (plan.controlNames.has(step.action)) {
      const control = CONTROL_REGISTRY.find((c) => c.name === step.action);
      if (control) {
        const { entry, failed } = control.execute(step.params, controlCtx);
        results.push(entry);
        lastSummary = entry.summary as string;
        if (failed) {
          failedAt = results.length - 1;
          break;
        }
        // Handoff monotonicity: a control that set the handoff slot ends the
        // batch (the request control is sole-step by admission, but the
        // invariant is enforced uniformly, not by convention).
        if (getHandoff(st.view) != null) break;
        continue;
      }
    }

    const action = plan.actions[step.action];
    const controller = action.controller;

    // ─── 1. Consuming a pending meta-choice as "the caller supplied the
    //     requested domain input" happens ON ACCEPTANCE — after the flow
    //     gate, the prereqs, and the params validation have all passed (see
    //     consumePendingChoice below, called from the propose and execute
    //     paths). A refused or malformed step must NOT burn the one-shot
    //     choice: `invalid_params` on a bad capture sends the model back to
    //     the caller with the choice still pending.
    const consumePendingChoice = (): { choice: string; selection: "domain_input" } | null => {
      if (!choiceEnabled) return null;
      const pendingChoice = getBoundedChoice(st.view);
      if (pendingChoice?.status !== "pending") return null;
      // Preserve the resolved marker (no turn id — the caller's input
      // itself is the resolution) so a later unsupported clarification
      // cannot reopen the one-shot choice.
      st.apply(
        setBoundedChoicePatch<T>({
          name: pendingChoice.name,
          status: "resolved",
          selection: "domain_input",
        }),
      );
      // The transition must be VISIBLE in the step result (`choice_consumed`):
      // the transcript is the model's only authority for the choice status —
      // engine state is never injected into the prompt — so a silent
      // consumption would leave the model believing the choice is still
      // pending.
      return { choice: pendingChoice.name, selection: "domain_input" };
    };

    // ─── 2. Library-managed flow prereq — BEFORE confirm-mode resolution. A
    //     confirm-required mutation that also `requiresFlow` would otherwise
    //     propose despite the flow being absent, leaving the LLM with a
    //     `needs_confirmation` recap on a doomed action.
    const flowRefusal = refuseWrongFlow(
      step.action,
      controller,
      getCurrentFlow(st.view),
      msgs,
    );
    if (flowRefusal) {
      fail(flowRefusal);
      break;
    }

    // ─── 3. User-declared prereqs — also before confirm-mode resolution, so
    //     propose, re-propose, and execute share the same gate.
    let prereqDenied = false;
    for (const p of action.prereqs) {
      const verifier = plan.verifiers[p];
      if (!verifier.check(st.view as T)) {
        fail({
          action: step.action,
          ok: false,
          summary: verifier.denial.summary,
          error: verifier.denial.error,
        });
        prereqDenied = true;
        break;
      }
    }
    if (prereqDenied) break;

    // ─── 4. Confirm-required propose / re-propose: validate params, store the
    //     gate, return needs_confirmation WITHOUT invoking the executor.
    //     Parse with the SAME schema the execute decision compares against
    //     (paramsMatchPending) so stored pending params and re-fired params
    //     are normalized identically. Raw Zod detail goes to `_debug`, never
    //     the summary.
    if (step.confirmMode === "propose" || step.confirmMode === "rePropose") {
      let params: unknown;
      try {
        params = action.effectiveSchema.parse(step.params);
      } catch (err) {
        const message =
          err instanceof z.ZodError
            ? err.issues.map((iss) => iss.message).join("; ")
            : String(err);
        fail({
          action: step.action,
          ok: false,
          summary: msgs.invalid_params,
          error: "invalid_params",
          _debug: `Invalid params for "${step.action}": ${message}`,
        });
        break;
      }
      // Propose-time state-aware refusal (ConfirmationOpts.refuseProposal):
      // a schema-valid proposal may still be impossible given state (e.g. an
      // empty capture probing for carried identity that does not exist). It
      // refuses BEFORE anything commits — no gate, no attempt spent, and the
      // pending bounded choice stays unburnt, exactly like `invalid_params`.
      const proposeRefusal = action.confirmation?.refuseProposal(
        params as Record<string, unknown>,
        st.view,
      );
      if (proposeRefusal) {
        fail({ action: step.action, ok: false, ...proposeRefusal });
        break;
      }
      // The step was accepted (params parsed) — the caller's input, not a
      // malformed capture, is what consumed any pending meta-choice.
      const consumedChoice = consumePendingChoice();
      const maxAttempts =
        action.confirmation?.maxAttempts ?? CONFIRMATION_DEFAULTS.maxAttempts;
      const attemptsLeft = step.proposeAttemptsLeft ?? maxAttempts;
      const confirmationPatch = setConfirmationPatch<T>(
        step.action,
        params as Record<string, unknown>,
        attemptsLeft,
        maxAttempts,
        currentCallerTurnId,
      );
      const summary =
        step.confirmMode === "propose"
          ? formatMessage(msgs.confirm_proposed, { action: step.action })
          : formatMessage(msgs.confirm_reproposed, { action: step.action });
      // What the runner ACTUALLY recorded, rendered by the host for the model
      // to speak back verbatim (ConfirmationOpts.readBack). The library owns
      // the capture — it sanitized, joined and validated these params — so it
      // owns reporting them back; the host owns only the lexicon.
      const readBack = action.confirmation?.readBack(
        params as Record<string, unknown>,
        st.preview(confirmationPatch),
      );
      const hasReadBack = typeof readBack === "string" && readBack.length > 0;
      // Commit exactly once. When repetition is enabled, persist the
      // already-rendered bytes on the gate; the repeat control never calls the
      // renderer again against potentially drifted host state.
      st.apply(
        action.confirmation?.repeatReadBack && hasReadBack
          ? setConfirmationPatch<T>(
              step.action,
              params as Record<string, unknown>,
              attemptsLeft,
              maxAttempts,
              currentCallerTurnId,
              readBack,
            )
          : confirmationPatch,
      );
      results.push({
        action: step.action,
        ok: true,
        summary,
        needs_confirmation: true,
        proposed_params: params as object,
        ...(hasReadBack ? { read_back: readBack } : {}),
        ...(consumedChoice ? { choice_consumed: consumedChoice } : {}),
        attempts_left: attemptsLeft,
      });
      lastSummary = summary;
      continue;
    }

    // ─── 5. Same-turn matching re-call: the proposal was stored on THIS
    //     caller turn, so the caller has not answered the read-back yet.
    //     Refuse without spending an attempt; the gate stays untouched. The
    //     model must wait for the caller's reply (see
    //     interaction/confirmation.ts).
    if (step.confirmMode === "sameTurnLocked") {
      fail({
        action: step.action,
        ok: false,
        summary:
          `The "${step.action}" proposal was made on the current caller turn; ` +
          "wait for the caller's confirmation before executing.",
        error: "confirmation_same_turn_locked",
      });
      break;
    }

    // ─── 6. Confirm-required attempts exhausted: clear the gate, error out.
    if (step.confirmMode === "exhausted") {
      st.apply(clearAwaitingInputPatch<T>());
      fail({
        action: step.action,
        ok: false,
        summary: formatMessage(msgs.confirm_exhausted, { action: step.action }),
        error: "confirmation_attempts_exhausted",
      });
      break;
    }

    // ─── 7. Execute mode: clear the gate atomically BEFORE the executor runs.
    if (step.confirmMode === "execute") {
      st.apply(clearAwaitingInputPatch<T>());
    }

    // ─── 7.–9. OTP / match gates (freeze semantics documented per gate).
    const otpRefusal = refuseOtpNotPending(
      step.action,
      controller,
      getAwaitingInput(st.view),
      msgs,
    );
    if (otpRefusal) {
      fail(otpRefusal);
      break;
    }
    const matchRefusal = refuseMatchNotPending(
      step.action,
      controller,
      batchStartAwaiting,
      msgs,
    );
    if (matchRefusal) {
      fail(matchRefusal);
      break;
    }
    const otpIssueRefusal = refuseOtpIssueWhileMatchPending(
      step.action,
      controller,
      getAwaitingInput(st.view),
      msgs,
    );
    if (otpIssueRefusal) {
      fail(otpIssueRefusal);
      break;
    }

    // ─── 10. Params. Pageable actions validate against the schema with the
    //     library-injected page/pageSize merged in.
    let params: unknown;
    try {
      params = action.effectiveSchema.parse(step.params);
    } catch (err) {
      const message =
        err instanceof z.ZodError
          ? err.issues.map((iss) => iss.message).join("; ")
          : String(err);
      fail({
        action: step.action,
        ok: false,
        summary: msgs.invalid_params,
        error: "invalid_params",
        _debug: `Invalid params for "${step.action}": ${message}`,
      });
      break;
    }
    // The step was accepted — only now does it count as the caller supplying
    // the domain input a pending meta-choice was suspended over.
    const consumedChoice = consumePendingChoice();

    // ─── 11. Pageable self-paginate cache hit: re-page from the
    //     library-managed `pagedRead` slot WITHOUT calling the executor.
    if (action.pageable?.mode === "self") {
      const cache =
        (st.view as { pagedRead?: PagedCache<unknown> | null }).pagedRead ?? null;
      const cachedBody = tryPageFromCache(step.action, action.pageable, params, cache);
      if (cachedBody) {
        results.push({ action: step.action, ok: true, ...cachedBody });
        lastSummary = (cachedBody.summary as string | undefined) ?? lastSummary;
        continue;
      }
    }

    // ─── Snapshot watched-slot values BEFORE the executor runs, for the
    //     invalidatesOnChange cascade below.
    const watchMap = action.invalidatesOnChange;
    const watchedKeys = Object.keys(watchMap);
    const preWatched: Record<string, unknown> = {};
    if (watchedKeys.length > 0) {
      const viewRec = st.view as Record<string, unknown>;
      for (const k of watchedKeys) preWatched[k] = viewRec[k];
    }

    // ─── 12. Execute. The selector projects the running view down to the
    //     slice this executor needs — it can't read anything the selector
    //     didn't hand it.
    const selector = plan.selectors[step.action];
    const executor = plan.executors[step.action];
    const slice = selector(st.view);
    let result: Awaited<ReturnType<typeof executor>>;
    anExecutorRan = true; // set before the call — a throw still counts as ran
    try {
      result = await executor(params, slice);
    } catch (err) {
      // Executors — and the fetchers / backend client they call — throw on
      // hard failures (backend 5xx, non-JSON, a required URL missing).
      // Convert the throw into an ok:false step and short-circuit, exactly
      // like a returned ok:false: the LLM still receives the
      // { summary, results, failed_at } envelope, and every earlier step's
      // patches stay committed. Without this the throw escapes the runner, no
      // Command is emitted, and those earlier commits are lost.
      const message = err instanceof Error ? err.message : String(err);
      fail({
        action: step.action,
        ok: false,
        summary: msgs.executor_error,
        error: "executor_error",
        _debug: `Action "${step.action}" failed: ${message}`,
      });
      break;
    }
    const effects: ExecutorEffect[] = result.effects ?? [];

    // ─── Pageable transform: turn the executor's result into the uniform page
    //     envelope. SELF slices `resultBody.items` (the full set) and emits a
    //     cache patch; DELEGATE wraps the backend's page using `totalCount`.
    let pageCachePatch: Partial<T> | null = null;
    let entryBody = result.resultBody as Record<string, unknown>;
    if (result.ok && action.pageable) {
      const outcome = applyPagination(
        step.action,
        action.pageable,
        params,
        result.resultBody as Record<string, unknown>,
      );
      entryBody = outcome.body;
      pageCachePatch = outcome.cachePatch as Partial<T> | null;
    }

    results.push({
      action: step.action,
      ok: result.ok,
      ...(consumedChoice ? { choice_consumed: consumedChoice } : {}),
      ...entryBody,
    });

    // ─── a. invalidatesOnChange cascade — BEFORE stateUpdate, so the
    //     executor's own re-writes of the same downstream slots win over the
    //     nulls. First-time set (null → value) and same-VALUE re-writes do
    //     not fire.
    if (watchedKeys.length > 0) {
      const stateUpdateRec = (result.stateUpdate ?? {}) as Record<string, unknown>;
      const invalidationPatch: Record<string, unknown> = {};
      for (const watched of watchedKeys) {
        const pre = preWatched[watched];
        if (pre == null) continue;
        if (!(watched in stateUpdateRec)) continue;
        if (valueEqual(pre, stateUpdateRec[watched])) continue;
        for (const downstream of watchMap[watched]) {
          invalidationPatch[downstream] = null;
        }
      }
      if (Object.keys(invalidationPatch).length > 0) {
        st.apply(invalidationPatch as Partial<T>);
      }
    }

    // ─── b. Domain-state patch (applied regardless of ok). Library-managed
    //     slots are rejected loudly — those transitions arrive as effects.
    if (result.stateUpdate) {
      assertDomainOnlyStateUpdate(
        step.action,
        result.stateUpdate as Record<string, unknown>,
      );
      st.apply(result.stateUpdate);
    }

    // ─── c. Terminal handoff effect (regardless of ok — a refusal verdict may
    //     still be terminal). Same atomic cleanup as the built-in control.
    for (const effect of effects) {
      if (effect.type === "request_handoff") {
        st.apply(requestHandoffPatch<T>(effect.request, choiceEnabled));
      }
    }

    // ─── d. Self-paginate cache miss: persist the full set under its query
    //     signature so a same-query re-page next turn skips the executor.
    if (pageCachePatch) {
      st.apply(pageCachePatch);
    }

    // ─── Handoff monotonicity: once the handoff slot is set, the batch is
    //     terminal — no later transition may (re)open interaction state
    //     (flow, OTP/match gates), and no later step may run. Without this, a
    //     `startsFlow`/`otp_issued` on the same step would reopen slots the
    //     handoff cleanup just cleared, and an ok:true handoff step would let
    //     subsequent steps execute work whose result nobody will see.
    const handoffSet = getHandoff(st.view) != null;

    if (result.ok && !handoffSet) {
      // ─── e. ok-only lifecycle.
      const flowUpdate = flowAfterOkStep(
        step.action,
        controller,
        effects,
        getCurrentFlow(st.view),
      );
      if (flowUpdate) {
        st.apply(setCurrentFlowPatch<T>(flowUpdate.name, flowUpdate.data));
      }

      if (effects.some((e) => e.type === "otp_issued")) {
        const finalFlow = getCurrentFlow(st.view);
        if (!finalFlow) {
          throw new Error(
            `agent-step: action "${step.action}" reported otp_issued but no flow is active.`,
          );
        }
        if (!controller?.issuesOtp) {
          throw new Error(
            `agent-step: action "${step.action}" reported otp_issued but config lacks issuesOtp opt.`,
          );
        }
        st.apply(
          setAwaitingOtpPatch<T>(controller.issuesOtp.consumer_action, finalFlow.name),
        );
      }

      // requiresOtp / requiresMatch on ok → the gate was consumed.
      if (controller?.requiresOtp) {
        st.apply(clearAwaitingInputPatch<T>());
      }
      if (controller?.requiresMatch) {
        st.apply(clearAwaitingInputPatch<T>());
      }

      // startsMatchFor on ok → open (or reset) the match gate for the named
      // consumer with a fresh attempts counter from the consumer's config.
      // (validate.ts checks the pair at construction; the throw remains as
      // defense for direct runSteps consumers with unvalidated configs.)
      if (controller?.startsMatchFor) {
        const consumerName = controller.startsMatchFor.consumer_action;
        const consumer = plan.actions[consumerName]?.controller;
        if (!consumer?.requiresMatch) {
          throw new Error(
            `agent-step: action "${step.action}" declares startsMatchFor "${consumerName}" but that consumer doesn't declare requiresMatch.`,
          );
        }
        const maxAttempts =
          consumer.requiresMatch.maxAttempts ?? MATCH_DEFAULT_MAX_ATTEMPTS;
        const finalFlow = getCurrentFlow(st.view);
        st.apply(
          setAwaitingMatchPatch<T>(consumerName, maxAttempts, maxAttempts, finalFlow?.name),
        );
      }

      if (controller?.endsFlow) {
        st.apply(clearInteractionPatch<T>(choiceEnabled));
      }
    } else if (!result.ok && !handoffSet) {
      // ─── f. ok:false — double-entry mismatch accounting (only a
      //     `match_mismatch` verdict spends an attempt).
      const mismatch = matchMismatchLifecycle<T>(
        step.action,
        controller,
        result.resultBody,
        getAwaitingInput(st.view),
        msgs,
        choiceEnabled,
      );
      if (mismatch) {
        st.apply(mismatch.patch);
        const entryIndex = results.length - 1;
        results[entryIndex] = { ...results[entryIndex], ...mismatch.entryPatch };
        if (mismatch.exhausted) {
          lastSummary = results[entryIndex].summary as string;
        }
      }
    }

    // ─── g. Executor-driven gate clearing (regardless of ok).
    for (const effect of effects) {
      if (effect.type === "clear_awaiting_input") {
        st.apply(clearAwaitingInputPatch<T>());
      } else if (effect.type === "abort_flow") {
        st.apply(clearInteractionPatch<T>(choiceEnabled));
      }
    }

    const summary = (result.resultBody as { summary?: string }).summary;
    if (typeof summary === "string") lastSummary = summary;

    if (!result.ok) {
      failedAt = results.length - 1;
      break;
    }
    // Handoff monotonicity: an ok step that requested a handoff still ends
    // the batch — later steps must not run.
    if (handoffSet) break;
  }

  return { results, failedAt, lastSummary, anExecutorRan };
}
