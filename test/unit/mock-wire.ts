import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface MockCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface MockTurn {
  text?: string;
  reasoning?: string;
  calls?: MockCall[];
  stop?: "stop" | "tool_use" | "length";
  chunk?: number;
  delayMs?: number;
  outputTokens?: number;
  error?: { code: string; error: string };
  reject?: { code: string; error: string };
}

interface RecordEvent {
  kind: "system" | "user" | "assistant" | "tool_result" | "rewind";
  text?: string;
  reasoning?: string;
  calls?: { id: number; name: string; arguments: Record<string, unknown> }[];
  call_id?: number;
  status?: "ok" | "error";
  tool?: string;
  stop?: string;
  tokens?: number;
}

interface MockSession {
  id: string;
  system: string | undefined;
  tools: { name: string; description: string; parameters?: unknown }[];
  events: RecordEvent[];
  visible: number[];
  nextCallId: number;
  pending: number[];
  toolNames: Map<number, string>;
  live: Set<number>;
  kvTokens: number;
  /** Boundary of the last checkpoint answered saved:true. */
  savedTokens: number;
  checkpoints: number;
}

interface Conn {
  socket: Socket;
  buffer: string;
  session: MockSession | undefined;
  generating: boolean;
  cancelled: boolean;
  dropped: boolean;
}

function tokensOf(text: string | undefined): number {
  if (!text) return 1;
  return Math.max(1, Math.ceil(text.length / 4));
}

export const SERVE_FRAME_BYTES_PER_TOKEN = 16;

export interface MockWireOptions {
  contextWindow?: number;
  model?: string;
  maxLine?: number;
  maxOutput?: number;
}

export class MockWireServer {
  readonly socketPath: string;
  readonly ops: Record<string, unknown>[] = [];
  readonly directory: string;
  turns: MockTurn[] = [];
  rewindFails = false;
  /** When set, checkpoints answer saved:false with this reason. */
  checkpointFailure: string | undefined;
  kvstore = true;
  historyDrops = 0;
  corruptHistory = false;
  contextWindow: number;
  maxLine: number;
  maxOutput: number;
  droppedConnections = 0;
  readonly model: string;
  private readonly server: Server;
  private readonly sessions = new Map<string, MockSession>();
  private readonly connections = new Set<Conn>();
  private counter = 0;

  private constructor(options: MockWireOptions) {
    this.directory = mkdtempSync(join(tmpdir(), "xenopi-mock-wire-"));
    this.socketPath = join(this.directory, "wire.sock");
    this.contextWindow = options.contextWindow ?? 4096;
    // The service derives its cap from the window; tests that shrink the
    // window to a few tokens are about token budgets, so keep a floor.
    this.maxLine = options.maxLine ?? Math.max(this.contextWindow * SERVE_FRAME_BYTES_PER_TOKEN, 1 << 20);
    this.maxOutput = options.maxOutput ?? this.maxLine; // the service uses one bound for both directions
    this.model = options.model ?? "gemma-4-26B-A4B-it-qat";
    this.server = createServer((socket) => this.accept(socket));
  }

  static async start(options: MockWireOptions = {}): Promise<MockWireServer> {
    const mock = new MockWireServer(options);
    await new Promise<void>((resolve) => mock.server.listen(mock.socketPath, resolve));
    return mock;
  }

  async stop(): Promise<void> {
    for (const conn of this.connections) conn.socket.destroy();
    this.connections.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  opNames(): string[] {
    return this.ops.map((op) => String(op["op"]));
  }

  reset(): void {
    this.ops.length = 0;
  }

  sessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  history(sessionId: string): RecordEvent[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    return session.visible.map((index) => session.events[index] as RecordEvent);
  }

  private accept(socket: Socket): void {
    const conn: Conn = { socket, buffer: "", session: undefined, generating: false, cancelled: false, dropped: false };
    this.connections.add(conn);
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      if (conn.dropped) return;
      conn.buffer += chunk;
      if (Buffer.byteLength(conn.buffer, "utf8") >= this.maxLine && !conn.buffer.includes("\n")) {
        this.send(conn, { ok: false, code: "invalid_request", error: "request line is too long" });
        this.drop(conn);
        return;
      }
      for (;;) {
        const index = conn.buffer.indexOf("\n");
        if (index < 0) break;
        const line = conn.buffer.slice(0, index);
        conn.buffer = conn.buffer.slice(index + 1);
        if (line.trim().length === 0) continue;
        if (Buffer.byteLength(line, "utf8") + 1 > this.maxLine) {
          this.send(conn, { ok: false, code: "invalid_request", error: "request line is too long" });
          this.drop(conn);
          return;
        }
        let request: Record<string, unknown>;
        try {
          request = JSON.parse(line) as Record<string, unknown>;
        } catch {
          this.send(conn, { ok: false, code: "invalid_request", error: "invalid request" });
          continue;
        }
        this.ops.push(request);
        void this.dispatch(conn, request);
      }
    });
    socket.on("close", () => this.connections.delete(conn));
    socket.on("error", () => this.connections.delete(conn));
  }

  private send(conn: Conn, payload: unknown): void {
    if (conn.socket.destroyed || conn.dropped) return;
    const line = `${JSON.stringify(payload)}\n`;
    if (Buffer.byteLength(line, "utf8") > this.maxOutput) {
      this.drop(conn);
      return;
    }
    conn.socket.write(line);
  }

  private drop(conn: Conn): void {
    if (conn.dropped) return;
    conn.dropped = true;
    this.droppedConnections++;
    conn.socket.destroy();
    this.connections.delete(conn);
  }

  private fail(conn: Conn, code: string, error: string, extra: Record<string, unknown> = {}): void {
    this.send(conn, { ok: false, code, error, ...extra });
  }

  /** Mirrors the service: a digit-free text plus structured tokens/context. */
  private overflow(conn: Conn, total: number): void {
    this.fail(conn, "context_length_exceeded", "prompt does not fit the context window", {
      tokens: total,
      context: this.contextWindow,
    });
  }

  private totalTokens(session: MockSession): number {
    let total = 0;
    for (const index of session.visible) total += (session.events[index] as RecordEvent).tokens ?? 0;
    return total;
  }

  private async dispatch(conn: Conn, request: Record<string, unknown>): Promise<void> {
    const op = String(request["op"] ?? "");
    if (op === "cancel") {
      if (conn.generating) {
        conn.cancelled = true;
        this.send(conn, { ok: true });
        return;
      }
      this.fail(conn, "invalid_request", "no generation in progress");
      return;
    }
    if (conn.generating) {
      this.fail(conn, "busy", "generation in progress");
      return;
    }
    switch (op) {
      case "describe":
        this.send(conn, {
          ok: true,
          protocol: 1,
          model: this.model,
          context_window: this.contextWindow,
          max_output: this.contextWindow,
          max_frame: this.maxLine,
          kvstore: this.kvstore,
          reasoning: {
            efforts: ["low", "medium", "high", "max"],
            history: ["discard", "preserve_tool_calls"],
            budget_tokens: true,
          },
        });
        return;
      case "create": {
        const id = `${(++this.counter).toString(16).padStart(32, "0")}`;
        const system = typeof request["system"] === "string" ? (request["system"] as string) : undefined;
        const tools = Array.isArray(request["tools"])
          ? (request["tools"] as { name: string; description: string; parameters?: unknown }[])
          : [];
        const session: MockSession = {
          id,
          system,
          tools,
          events: [],
          visible: [],
          nextCallId: 1,
          pending: [],
          toolNames: new Map(),
          live: new Set(),
          kvTokens: 0,
          savedTokens: 0,
          checkpoints: 0,
        };
        this.pushSystem(session, system, tools);
        this.sessions.set(id, session);
        conn.session = session;
        this.send(conn, { ok: true, session: id, marker: session.visible[0] });
        return;
      }
      case "open": {
        const session = this.sessions.get(String(request["session"]));
        if (!session) {
          this.fail(conn, "session_not_found", "no such session");
          return;
        }
        conn.session = session;
        const total = this.totalTokens(session);
        this.send(conn, {
          ok: true,
          tokens: total,
          marker: session.visible.length > 0 ? session.visible[session.visible.length - 1] : null,
          turn_open: session.pending.length > 0,
          zero_prefill: session.kvTokens >= total,
          resume: session.kvTokens >= total ? "snapshot" : session.kvTokens > 0 ? "stale" : "none",
          pending: [...session.pending],
        });
        return;
      }
      case "stat": {
        const session = this.sessions.get(String(request["session"]));
        if (!session) {
          this.fail(conn, "session_not_found", "no such session");
          return;
        }
        this.send(conn, {
          ok: true,
          session: session.id,
          title: "",
          tokens: this.totalTokens(session),
          resumable: true,
          created: 0,
          updated: 0,
        });
        return;
      }
      case "delete": {
        const id = String(request["session"]);
        if (!this.sessions.has(id)) {
          this.fail(conn, "session_not_found", "no such session");
          return;
        }
        for (const other of this.connections) {
          if (other !== conn && other.session?.id === id) {
            this.fail(conn, "busy", "session is bound by another connection");
            return;
          }
        }
        this.sessions.delete(id);
        if (conn.session?.id === id) conn.session = undefined;
        this.send(conn, { ok: true });
        return;
      }
      case "list":
        this.send(conn, {
          ok: true,
          sessions: [...this.sessions.values()].map((session) => ({
            session: session.id,
            title: "",
            tokens: this.totalTokens(session),
            resumable: true,
          })),
        });
        return;
      case "append": {
        const session = conn.session;
        if (!session) {
          this.fail(conn, "session_not_found", "no open session");
          return;
        }
        const role = String(request["role"]);
        const text = typeof request["text"] === "string" ? (request["text"] as string) : undefined;
        if (text === undefined) {
          this.fail(conn, "invalid_request", "missing text");
          return;
        }
        if (role === "user") {
          const marker = this.pushEvent(session, { kind: "user", text, tokens: tokensOf(text) });
          if (marker === undefined) {
            this.overflow(conn, this.totalTokens(session) + tokensOf(text));
            return;
          }
          this.send(conn, { ok: true, marker });
          return;
        }
        if (role === "tool") {
          const callId = Number(request["call_id"]);
          const name = session.live.has(callId) ? session.toolNames.get(callId) : undefined;
          if (name === undefined) {
            this.fail(conn, "invalid_request", `unknown tool call id ${callId}`);
            return;
          }
          if (!session.pending.includes(callId)) {
            this.fail(conn, "invalid_request", "no open model turn for a tool result");
            return;
          }
          const status = request["status"] === "error" ? "error" : "ok";
          const marker = this.pushEvent(session, {
            kind: "tool_result",
            text,
            call_id: callId,
            status,
            tool: name,
            tokens: tokensOf(text),
          });
          if (marker === undefined) {
            this.overflow(conn, this.totalTokens(session) + tokensOf(text));
            return;
          }
          session.pending = session.pending.filter((id) => id !== callId);
          this.send(conn, { ok: true, marker });
          return;
        }
        this.fail(conn, "invalid_request", "invalid role");
        return;
      }
      case "rebuild": {
        const session = conn.session;
        if (!session) {
          this.fail(conn, "session_not_found", "no open session");
          return;
        }
        const system = typeof request["system"] === "string" ? (request["system"] as string) : undefined;
        const tools = Array.isArray(request["tools"])
          ? (request["tools"] as { name: string; description: string; parameters?: unknown }[])
          : [];
        session.events.push({ kind: "rewind" });
        session.visible = [];
        session.pending = [];
        session.live = new Set();
        session.system = system;
        session.tools = tools;
        this.pushSystem(session, system, tools);
        const messages = Array.isArray(request["messages"])
          ? (request["messages"] as Record<string, unknown>[])
          : [];
        for (const message of messages) {
          const role = String(message["role"]);
          const text = typeof message["text"] === "string" ? (message["text"] as string) : "";
          if (role === "user") {
            this.pushEvent(session, { kind: "user", text, tokens: tokensOf(text) });
            continue;
          }
          if (role === "assistant") {
            const rawCalls = Array.isArray(message["calls"])
              ? (message["calls"] as { name: string; arguments?: Record<string, unknown> }[])
              : [];
            const calls = rawCalls.map((call) => {
              const id = session.nextCallId++;
              session.toolNames.set(id, call.name);
              session.live.add(id);
              session.pending.push(id);
              return { id, name: call.name, arguments: call.arguments ?? {} };
            });
            const event: RecordEvent = { kind: "assistant", text, tokens: tokensOf(text) };
            if (typeof message["reasoning"] === "string") event.reasoning = message["reasoning"] as string;
            if (calls.length > 0) event.calls = calls;
            this.pushEvent(session, event);
            continue;
          }
          if (role === "tool") {
            const tool = typeof message["tool"] === "string" ? (message["tool"] as string) : undefined;
            const candidate = tool
              ? session.pending.find((id) => session.toolNames.get(id) === tool)
              : session.pending[0];
            if (candidate === undefined) {
              this.fail(conn, "invalid_request", `no pending call for tool ${String(tool)}`);
              return;
            }
            session.pending = session.pending.filter((id) => id !== candidate);
            this.pushEvent(session, {
              kind: "tool_result",
              text,
              call_id: candidate,
              status: message["status"] === "error" ? "error" : "ok",
              tool: session.toolNames.get(candidate) ?? "",
              tokens: tokensOf(text),
            });
            continue;
          }
          this.fail(conn, "invalid_request", "invalid role");
          return;
        }
        session.kvTokens = 0;
        const last = session.visible[session.visible.length - 1];
        this.send(conn, { ok: true, marker: last });
        return;
      }
      case "rewind": {
        const session = conn.session;
        if (!session) {
          this.fail(conn, "session_not_found", "no open session");
          return;
        }
        const marker = Number(request["marker"]);
        if (this.rewindFails) {
          this.fail(conn, "marker_unavailable", `marker ${marker} is not addressable`);
          return;
        }
        const position = session.visible.indexOf(marker);
        if (position < 0) {
          this.fail(conn, "marker_unavailable", `marker ${marker} is not addressable`);
          return;
        }
        session.visible = session.visible.slice(0, position + 1);
        session.events.push({ kind: "rewind" });
        this.recomputeCalls(session, marker);
        session.kvTokens = Math.min(session.kvTokens, this.totalTokens(session));
        this.send(conn, { ok: true });
        return;
      }
      case "rewind_cost": {
        const session = conn.session;
        if (!session) {
          this.fail(conn, "session_not_found", "no open session");
          return;
        }
        this.send(conn, { ok: true, prefill: 0 });
        return;
      }
      case "checkpoint": {
        const session = conn.session;
        if (!session) {
          this.fail(conn, "session_not_found", "no open session");
          return;
        }
        session.checkpoints++;
        const total = this.totalTokens(session);
        if (!this.kvstore || this.checkpointFailure) {
          this.send(conn, {
            ok: true,
            saved: false,
            reason: this.kvstore ? this.checkpointFailure : "no_kvstore",
            tokens: total,
          });
          return;
        }
        if (session.savedTokens >= total) {
          this.send(conn, { ok: true, saved: false, reason: "nothing_new", tokens: total });
          return;
        }
        session.savedTokens = total;
        session.kvTokens = total;
        this.send(conn, { ok: true, saved: true, tokens: total });
        return;
      }
      case "pending": {
        const session = conn.session;
        if (!session) {
          this.fail(conn, "session_not_found", "no open session");
          return;
        }
        this.send(conn, { ok: true, calls: [...session.pending] });
        return;
      }
      case "history": {
        const session = conn.session;
        if (!session) {
          this.fail(conn, "session_not_found", "no open session");
          return;
        }
        if (this.historyDrops > 0) {
          this.historyDrops--;
          this.drop(conn);
          return;
        }
        const entries = session.visible.map((index) => {
          const event = session.events[index] as RecordEvent;
          const entry: Record<string, unknown> = {
            kind: event.kind === "assistant" ? "assistant" : event.kind,
            marker: index,
            text: event.text ?? "",
          };
          if (event.kind === "system") entry["extra"] = session.tools;
          if (event.kind === "assistant" && event.calls) entry["extra"] = event.calls;
          if (event.kind === "assistant" && event.reasoning !== undefined)
            entry["reasoning"] = event.reasoning;
          if (event.kind === "tool_result") {
            entry["call_id"] = event.call_id;
            entry["status"] = event.status;
            entry["tool"] = event.tool;
          }
          if (event.stop) entry["stop"] = event.stop;
          return entry;
        });
        if (this.corruptHistory) entries.push({ kind: "user", marker: 9999, text: "phantom" });
        this.send(conn, { ok: true, entries });
        return;
      }
      case "generate": {
        const session = conn.session;
        if (!session) {
          this.fail(conn, "session_not_found", "no open session");
          return;
        }
        const total = this.totalTokens(session);
        if (total + 1 >= this.contextWindow) {
          this.overflow(conn, total);
          return;
        }
        const rejection = this.turns[0]?.reject;
        if (rejection) {
          this.turns.shift();
          this.fail(conn, rejection.code, rejection.error);
          return;
        }
        await this.generate(conn, session);
        return;
      }
      case "ephemeral": {
        const invalid = validateEphemeral(request);
        if (invalid) {
          this.fail(conn, "invalid_request", invalid);
          return;
        }
        await this.generate(conn, undefined);
        return;
      }
      default:
        this.fail(conn, "invalid_request", "unknown op");
    }
  }

  private recomputeCalls(session: MockSession, target: number): void {
    const live = new Set<number>();
    const closed = new Set<number>();
    for (const index of session.visible) {
      const event = session.events[index] as RecordEvent;
      if (event.kind === "assistant" && event.calls && index < target) {
        for (const call of event.calls) live.add(call.id);
      }
      if (event.kind === "tool_result" && event.call_id !== undefined) closed.add(event.call_id);
    }
    session.live = live;
    session.pending = [...live].filter((id) => !closed.has(id));
  }

  private pushSystem(
    session: MockSession,
    system: string | undefined,
    tools: { name: string; description: string; parameters?: unknown }[],
  ): void {
    const text = system ?? "";
    session.events.push({ kind: "system", text, tokens: tokensOf(text) + tools.length });
    session.visible.push(session.events.length - 1);
  }

  private pushEvent(session: MockSession, event: RecordEvent): number | undefined {
    const total = this.totalTokens(session) + (event.tokens ?? 0);
    if (total + 1 >= this.contextWindow) return undefined;
    session.events.push(event);
    const marker = session.events.length - 1;
    session.visible.push(marker);
    return marker;
  }

  private async generate(conn: Conn, session: MockSession | undefined): Promise<void> {
    const plan = this.turns.shift() ?? { text: "ok", stop: "stop" as const };
    conn.generating = true;
    conn.cancelled = false;
    try {
      if (plan.error) {
        this.send(conn, { event: "error", code: plan.error.code, error: plan.error.error });
        return;
      }
      this.send(conn, { event: "start" });
      const reasoning = plan.reasoning ?? "";
      if (reasoning.length > 0)
        this.send(conn, { event: "reasoning_delta", text: reasoning });
      const text = plan.text ?? "";
      const chunk = plan.chunk ?? Math.max(1, text.length);
      let emitted = "";
      for (let index = 0; index < text.length; index += chunk) {
        if (conn.cancelled) break;
        if (plan.delayMs) await new Promise<void>((resolve) => setTimeout(resolve, plan.delayMs));
        if (conn.cancelled) break;
        const slice = text.slice(index, index + chunk);
        emitted += slice;
        this.send(conn, { event: "text_delta", text: slice });
      }
      const calls: { id: number; name: string; arguments: Record<string, unknown> }[] = [];
      if (!conn.cancelled && plan.calls) {
        for (const call of plan.calls) {
          const id = session ? session.nextCallId++ : 1;
          if (session) session.toolNames.set(id, call.name);
          calls.push({ id, name: call.name, arguments: call.arguments });
          this.send(conn, { event: "toolcall_start", id, name: call.name });
          this.send(conn, { event: "toolcall_end", id, name: call.name, arguments: call.arguments });
        }
      }
      const reasoningTokens = reasoning.length > 0 ? tokensOf(reasoning) : 0;
      const outputTokens = plan.outputTokens ?? tokensOf(emitted) + reasoningTokens + calls.length;
      if (!session) {
        this.send(conn, {
          event: "done",
          stop: conn.cancelled ? "aborted" : (plan.stop ?? "stop"),
          usage: {
            input: 8,
            cache_read: 0,
            output: outputTokens,
            reasoning: reasoningTokens,
            replayed: 0,
            total: 8 + outputTokens,
          },
          marker: null,
        });
        return;
      }
      const before = this.totalTokens(session);
      const cacheRead = Math.min(session.kvTokens, before);
      const input = before - cacheRead;
      const event: RecordEvent = {
        kind: "assistant",
        text: emitted,
        reasoning: reasoning || undefined,
        tokens: outputTokens,
        stop: conn.cancelled ? "cancelled" : plan.stop === "tool_use" ? "tool_calls" : "eot",
      };
      if (calls.length > 0) event.calls = calls;
      session.events.push(event);
      const marker = session.events.length - 1;
      session.visible.push(marker);
      for (const call of calls) {
        session.pending.push(call.id);
        session.live.add(call.id);
      }
      session.kvTokens = before + outputTokens;
      this.send(conn, {
        event: "done",
        stop: conn.cancelled ? "aborted" : (plan.stop ?? "stop"),
        usage: {
          input,
          cache_read: cacheRead,
          output: outputTokens,
          reasoning: reasoningTokens,
          replayed: 0,
          total: before + outputTokens,
        },
        marker,
      });
    } finally {
      conn.generating = false;
      conn.cancelled = false;
    }
  }
}

export function validateEphemeral(request: Record<string, unknown>): string | undefined {
  const system = request["system"];
  if (system !== undefined && typeof system !== "string") return "invalid system";
  const tools = request["tools"];
  if (tools !== undefined) {
    if (!Array.isArray(tools)) return "invalid tools";
    for (const tool of tools as Record<string, unknown>[]) {
      if (typeof tool["name"] !== "string" || typeof tool["description"] !== "string") {
        return "invalid tools";
      }
    }
  }
  const messages = request["messages"];
  if (messages === undefined) return undefined;
  if (!Array.isArray(messages)) return "invalid messages";
  let turnOpen = false;
  for (const message of messages as Record<string, unknown>[]) {
    const role = message["role"];
    const text = message["text"];
    if (role === "user") {
      if (typeof text !== "string") return "missing text";
      turnOpen = false;
      continue;
    }
    if (role === "assistant") {
      const calls = message["calls"];
      turnOpen = Array.isArray(calls) && calls.length > 0;
      continue;
    }
    if (role === "tool") {
      if (!turnOpen) return "no open model turn for a tool result";
      if (typeof message["tool"] !== "string" || typeof text !== "string") {
        return "missing tool name or text";
      }
      continue;
    }
    return "invalid role";
  }
  return undefined;
}
