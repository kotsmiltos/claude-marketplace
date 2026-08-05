// FILE: src/agent-step/handoff/delegate-client.ts
//
// Minimal fetch/SSE implementation of the LangGraph Platform API
// (`POST /threads`, `POST /threads/{id}/runs/stream` with
// `stream_mode: ["messages-tuple"]`) — no SDK dependency. Used by the handoff
// resolver node (handoff/node.ts) to run a delegate deployment and pass its
// answer through. Pure transport: no runner or graph state in here.

import { createHash } from "node:crypto";
import type { HandoffDelegateTarget } from "./contract.js";

const CONNECT_DEFAULT_TIMEOUT_MS = 10_000;
const DELEGATE_DEFAULT_TIMEOUT_MS = 20_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The Platform API requires UUID thread ids. A platform-generated host
 *  thread id IS a UUID and passes through unchanged (shared-id correlation —
 *  safe by construction: the delegate is a separate deployment with its own
 *  checkpointer, so the id is pure correlation); any other id (a local CLI
 *  thread, a missing-checkpointer fallback) maps to a UUID derived
 *  deterministically from it, so repeated delegations from the same host
 *  thread still land on the same delegate thread. */
export function delegateThreadId(hostThreadId: string): string {
  if (UUID_RE.test(hostThreadId)) return hostThreadId;
  const h = createHash("sha1").update(`agent-step-handoff:${hostThreadId}`).digest("hex");
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Extract plain text from a serialized message chunk's `content` (string, or
 *  the array-of-parts form with `{ type: "text", text }` entries). */
function textContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    let out = "";
    for (const part of content) {
      if (
        part &&
        typeof part === "object" &&
        (part as { type?: string }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        out += (part as { text: string }).text;
      }
    }
    return out;
  }
  return "";
}

/** Minimal SSE parser over a fetch body. Yields `{ event, data }` per SSE
 *  message; multi-line `data:` fields are joined with newlines per spec. */
async function* parseSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      for (;;) {
        const boundary = buf.match(/\r?\n\r?\n/);
        if (!boundary || boundary.index === undefined) break;
        const raw = buf.slice(0, boundary.index);
        buf = buf.slice(boundary.index + boundary[0].length);
        let event = "message";
        const dataLines: string[] = [];
        for (const line of raw.split(/\r?\n/)) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
        }
        if (dataLines.length > 0) yield { event, data: dataLines.join("\n") };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Serialized message chunk as it arrives in a `messages-tuple` SSE event:
 *  `data` is the `[chunk, metadata]` tuple. */
interface SerializedChunk {
  id?: string;
  type?: string;
  content?: unknown;
  tool_calls?: unknown[];
  tool_call_chunks?: unknown[];
}

/** True for AI message chunks (the delegate's spoken tokens). Server
 *  serializations vary (`AIMessageChunk` | `ai`); reject the known non-AI
 *  types rather than allowlisting one spelling. */
function isAiChunk(chunk: SerializedChunk): boolean {
  const t = (chunk.type ?? "").toLowerCase();
  if (t.includes("tool") || t.includes("human") || t.includes("system")) return false;
  return true;
}

/** Run the delegate over the Platform API and return its final text. Streams
 *  each AI token through `writer` (as `delegated_token` custom events) as it
 *  arrives. Throws on any HTTP/parse failure — the caller falls back to the
 *  terminate envelope. */
export async function runDelegate(
  target: HandoffDelegateTarget,
  threadId: string,
  input: Record<string, unknown>,
  writer: ((chunk: unknown) => void) | undefined,
): Promise<string> {
  const connectSignal = AbortSignal.timeout(
    target.connectTimeoutMs ?? CONNECT_DEFAULT_TIMEOUT_MS,
  );
  const headers = { "Content-Type": "application/json", ...(target.headers ?? {}) };
  const base = target.url.replace(/\/+$/, "");

  // Idempotently ensure the shared thread exists on the delegate deployment.
  const threadRes = await fetch(`${base}/threads`, {
    method: "POST",
    headers,
    signal: connectSignal,
    body: JSON.stringify({ thread_id: threadId, if_exists: "do_nothing" }),
  });
  if (!threadRes.ok) {
    throw new Error(`delegate thread create failed: HTTP ${threadRes.status}`);
  }

  // Created only NOW — after the connect phase — so the streaming budget is
  // measured from run start, not from delegate entry (an `AbortSignal.timeout`
  // starts ticking at creation).
  const streamSignal = AbortSignal.timeout(target.timeoutMs ?? DELEGATE_DEFAULT_TIMEOUT_MS);

  const runRes = await fetch(`${base}/threads/${threadId}/runs/stream`, {
    method: "POST",
    headers,
    signal: streamSignal,
    body: JSON.stringify({
      assistant_id: target.assistantId,
      input,
      stream_mode: ["messages-tuple"],
    }),
  });
  if (!runRes.ok || !runRes.body) {
    throw new Error(`delegate run failed: HTTP ${runRes.status}`);
  }

  // A delegate graph may run SEVERAL LLM calls in one turn (router /
  // structured-output nodes emit tokens before the customer-facing reply).
  // With `replyNode` configured (the production path), only that node's
  // tokens are forwarded/accumulated — the first forwarded token is already
  // the reply, preserving time-to-first-token for voice clients. Without it,
  // fall back to grouping tokens per message (chunk id / emitting node) and
  // keeping the LAST message, emitting `delegated_restart` on each boundary
  // so live consumers discard earlier tokens — fine for text, not for voice.
  let text = "";
  let currentKey: string | null = null;
  for await (const evt of parseSse(runRes.body)) {
    if (evt.event === "error") {
      throw new Error(`delegate stream error: ${evt.data}`);
    }
    // messages-tuple events arrive as `event: messages`.
    if (evt.event !== "messages") continue;
    let data: unknown;
    try {
      data = JSON.parse(evt.data);
    } catch {
      continue;
    }
    if (!Array.isArray(data) || data.length === 0) continue;
    const chunk = data[0] as SerializedChunk | null;
    if (!chunk || typeof chunk !== "object" || !isAiChunk(chunk)) continue;
    const token = textContent(chunk.content);
    if (token.length === 0) continue;
    const meta = (data[1] ?? {}) as { langgraph_node?: string };
    if (target.replyNode) {
      if (meta.langgraph_node !== target.replyNode) continue;
    } else {
      const key = chunk.id ?? meta.langgraph_node ?? "m0";
      if (currentKey !== null && key !== currentKey && text.length > 0) {
        text = "";
        writer?.({ type: "delegated_restart" });
      }
      currentKey = key;
    }
    text += token;
    writer?.({ type: "delegated_token", content: token });
  }
  return text;
}
