// FILE: src/observability/schemas.ts
//
// Zod schemas for observability Kafka messages. One envelope (the
// bank-standard shape the shared Elasticsearch sink consumes) and one `data`
// shape for all run events: every traced run — graph invocation, LangGraph
// node, LLM call, tool run — is a "request/response pair", so a single shape
// with `direction` covers both the start (inputs) and end (outputs) event.

import { z } from "zod";

export const RunEventDataSchema = z.object({
  type: z.literal("run"),
  /** request = run created (inputs known), response = run ended (outputs/error known). */
  direction: z.enum(["request", "response"]),

  // Identity + trace hierarchy — enough to rebuild the LangSmith-style run
  // tree downstream (parent_run_id links, dotted_order gives depth + ordering).
  run_id: z.string().min(1),
  trace_id: z.string().optional(),
  parent_run_id: z.string().optional(),
  dotted_order: z.string().optional(),

  /** LangChain run type: "chain" (graph + nodes), "llm", "tool", "retriever", … */
  run_type: z.string().min(1),
  name: z.string().min(1),

  tags: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  /** The serialized constructor info LangChain attaches at run creation (model class, params). */
  serialized: z.record(z.string(), z.unknown()).optional(),

  inputs: z.record(z.string(), z.unknown()).optional(),
  outputs: z.record(z.string(), z.unknown()).optional(),
  error: z.string().optional(),
  status: z.enum(["success", "error"]).optional(),
  /** Intra-run events (e.g. streaming new_token timestamps), chunk objects stripped. */
  events: z.array(z.record(z.string(), z.unknown())).optional(),

  start_time: z.string().min(1),
  end_time: z.string().optional(),
  latency_ms: z.number().optional(),
});
export type RunEventData = z.infer<typeof RunEventDataSchema>;

export const ObservabilityEventSchema = z.object({
  id: z.string(),
  thread_id: z.string().min(1, "thread_id must not be empty"),
  application_name: z.string().min(1, "application_name must not be empty"),
  timestamp: z.string(),
  data: RunEventDataSchema,
});
export type ObservabilityEvent = z.infer<typeof ObservabilityEventSchema>;
