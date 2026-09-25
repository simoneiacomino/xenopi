export type WireStatusCode =
  | "ok"
  | "context_length_exceeded"
  | "session_not_found"
  | "marker_unavailable"
  | "invalid_request"
  | "busy"
  | "io_error"
  | "out_of_memory"
  | "unknown";

export type WireRole = "user" | "assistant" | "tool";

export interface WireCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface WireToolDeclaration {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

export interface WireMessage {
  role: WireRole;
  text?: string;
  reasoning?: string;
  calls?: WireCall[];
  call_id?: number;
  tool?: string;
  status?: "ok" | "error";
}

export interface WireGenParams {
  temperature?: number;
  top_k?: number;
  top_p?: number;
  max_tokens?: number;
  seed?: number;
  reasoning?: false | {
    effort: "low" | "medium" | "high" | "max";
    budget_tokens?: number;
    history?: "discard" | "preserve_tool_calls";
  };
}

export interface WireOkResponse {
  ok: true;
  [key: string]: unknown;
}

/** Structured detail of a context_length_exceeded failure. */
export interface WireErrorDetail {
  tokens?: number;
  context?: number;
}

export interface WireErrorResponse {
  ok: false;
  code: WireStatusCode;
  error: string;
  tokens?: number;
  context?: number;
}

export type WireResponse = WireOkResponse | WireErrorResponse;

export interface WireUsage {
  input: number;
  cache_read: number;
  output: number;
  total: number;
  reasoning: number;
  replayed: number;
}

export type WireStop = "stop" | "tool_use" | "length" | "aborted" | "unknown";

/** Why a checkpoint did not save. Checkpoints are never fatal: the
 * transcript is the source of truth and replay always works. */
export type WireCheckpointReason =
  | "no_kvstore"
  | "empty"
  | "nothing_new"
  | "kv_diverged"
  | "budget"
  | "io"
  | "rejected"
  | "record_failed";

export interface WireCheckpointReport {
  saved: boolean;
  reason?: WireCheckpointReason;
  tokens: number;
}

/** Why a resume did not load the snapshot it was expected to. */
export type WireResumeReason = "evicted" | "model_mismatch" | "token_mismatch" | "io" | "rejected";

export interface WireResumeReport {
  loaded: boolean;
  reason?: WireResumeReason;
  tokens: number;
}

export type WireEvent =
  | { event: "start" }
  | { event: "progress"; prefilled: number; total: number }
  | { event: "text_delta"; text: string }
  | { event: "reasoning_delta"; text: string }
  | { event: "toolcall_start"; id: number; name: string }
  | { event: "toolcall_end"; id: number; name: string; arguments: Record<string, unknown> }
  | {
      event: "done";
      stop: WireStop;
      usage: WireUsage;
      marker: number | null;
      reasoning_close?: "natural" | "soft" | "hard" | "length" | "aborted" | "eos";
      checkpoint?: WireCheckpointReport;
      resume?: WireResumeReport;
    }
  | { event: "error"; code: WireStatusCode; error: string; tokens?: number; context?: number };

export interface WireHistoryEntry {
  kind: "system" | "user" | "assistant" | "tool_result";
  marker: number;
  text: string;
  reasoning?: string;
  extra?: unknown;
  call_id?: number;
  status?: "ok" | "error";
  tool?: string;
  stop?: string;
}

export interface WireDescribe {
  protocol: number;
  model: string;
  context_window: number;
  max_output: number;
  /** Single-line frame bound in bytes (context_window x 16); requests above it are refused. */
  max_frame: number;
  kvstore: boolean;
  reasoning: {
    efforts: ("low" | "medium" | "high" | "max")[];
    history: ("discard" | "preserve_tool_calls")[];
    budget_tokens: boolean;
  };
}

export interface WireOpenReport {
  tokens: number;
  marker: number | null;
  turn_open: boolean;
  zero_prefill: boolean;
  resume: "snapshot" | "stale" | "none";
  pending: number[];
}

export interface WireSessionSummary {
  session: string;
  title: string;
  tokens: number;
  resumable: boolean;
}

export class WireError extends Error {
  readonly code: WireStatusCode;
  readonly detail: WireErrorDetail;

  constructor(code: WireStatusCode, message: string, detail: WireErrorDetail = {}) {
    super(message);
    this.name = "WireError";
    this.code = code;
    this.detail = detail;
  }
}

/**
 * The text pi sees for a wire failure. Every wire error text reaches pi
 * verbatim except context overflow: pi has no structural overflow signal
 * and classifies by regex on errorMessage (`isContextOverflow`), so the
 * adapter composes a message that its generic fallback pattern
 * /context[_ ]length[_ ]exceeded/ recognizes, built from our own status
 * code rather than from any other server's wording. Digit-free on purpose:
 * pi's retry classifier matches bare "429"/"5xx" substrings. The unit suite
 * pins this against pi's exported isContextOverflow.
 */
export function errorMessageForPi(code: WireStatusCode, text: string): string {
  if (code === "context_length_exceeded") return "context_length_exceeded: the prompt does not fit the context window";
  return text;
}

export function isWireEvent(line: unknown): line is WireEvent {
  return typeof line === "object" && line !== null && "event" in line;
}

export function isWireResponse(line: unknown): line is WireResponse {
  return typeof line === "object" && line !== null && "ok" in line;
}
