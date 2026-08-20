// FILE: src/agent-step/interaction/turn-identity.ts
//
// The caller-turn identity primitives: one stable id per caller utterance,
// however many ReAct loops the model runs inside that turn. Consumed by the
// confirmation gate's turn provenance (same-turn execute lock), the host
// guard latch, and the runner's per-batch context. Historically these lived
// in interaction/bounded-choice.ts; they outlived that subsystem (removed in
// 3.0.0) because turn identity is a property of the CONVERSATION, not of any
// one interaction kind.

/** Return the latest caller message's stable LangGraph id. LangGraph's
 *  messages reducer assigns missing ids before a node sees state, so this is
 *  stable across every ReAct loop in one caller turn and independent of
 *  history length/compaction. Direct `runSteps` consumers may provide messages
 *  without ids; in that case the same-turn guard is deliberately unavailable
 *  rather than guessing an identity and risking a permanent deadlock. */
export function latestHumanMessageId(state: unknown): string | undefined {
  const messages =
    state && typeof state === "object"
      ? (state as { messages?: unknown[] }).messages
      : undefined;
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || typeof message !== "object") continue;
    const value = message as {
      getType?: () => string;
      _getType?: () => string;
      type?: string;
      role?: string;
      id?: unknown;
    };
    const kind =
      value.getType?.() ?? value._getType?.() ?? value.type ?? value.role ?? "";
    if (kind === "human" || kind === "user") {
      return typeof value.id === "string" && value.id.length > 0
        ? value.id
        : undefined;
    }
  }
  return undefined;
}

/** Resolve the current caller turn's stable identity: the host-provided
 *  override when configured, otherwise the latest human message id. Trims to
 *  `undefined` so an empty override degrades to "no identity" rather than a
 *  matchable empty string. */
export function resolveCallerTurnId<T>(
  initialState: T,
  getCallerTurnId: ((state: T) => string | null | undefined) | undefined,
): string | undefined {
  const raw = getCallerTurnId
    ? getCallerTurnId(initialState)
    : latestHumanMessageId(initialState);
  return typeof raw === "string" && raw.trim().length > 0 ? raw : undefined;
}
