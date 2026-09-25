import { spawn } from "node:child_process";
import { connect, type Socket } from "node:net";
import type { XenolithSettings } from "../config.js";
import {
  isWireEvent,
  isWireResponse,
  WireError,
  type WireEvent,
  type WireGenParams,
  type WireMessage,
  type WireOkResponse,
  type WireResponse,
  type WireToolDeclaration,
} from "./protocol.js";

/** Frame bound until describe says otherwise: the service derives its
 * single-line cap from the context window (262144 tokens x 16 bytes) and
 * advertises it as `max_frame`; the client mirrors that value. */
export const DEFAULT_MAX_FRAME_BYTES = 262144 * 16;
export const FRAME_TOO_LARGE =
  "the wire request frame exceeds the single-line protocol limit of the xenolith service";
export const RECORD_UNREADABLE =
  "the xenolith wire record is too large to read back in one frame";

const MAX_STDERR_TAIL = 8192;

export class WireFrameTooLargeError extends WireError {
  readonly bytes: number;

  constructor(bytes: number) {
    super("invalid_request", FRAME_TOO_LARGE);
    this.name = "WireFrameTooLargeError";
    this.bytes = bytes;
  }
}

interface PendingLine {
  resolve: (line: unknown) => void;
  reject: (error: Error) => void;
}

export class WireConnection {
  private readonly socket: Socket;
  private buffer = "";
  private readonly lines: unknown[] = [];
  private readonly waiters: PendingLine[] = [];
  private closedError: Error | undefined;
  private lock: Promise<void> = Promise.resolve();
  private outstandingCancels = 0;
  /** Largest request line this connection will send; set from describe.max_frame. */
  maxFrameBytes = DEFAULT_MAX_FRAME_BYTES;

  constructor(socket: Socket) {
    this.socket = socket;
    this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk: string) => this.onData(chunk));
    this.socket.on("error", (error: Error) => this.fail(error));
    this.socket.on("close", () => this.fail(new WireError("io_error", "wire connection closed")));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > this.maxFrameBytes * 4) {
      this.fail(new WireError("io_error", "wire response exceeded the client buffer limit"));
      return;
    }
    for (;;) {
      const index = this.buffer.indexOf("\n");
      if (index < 0) break;
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.fail(new WireError("io_error", `wire sent a malformed line: ${line.slice(0, 200)}`));
        return;
      }
      if (this.outstandingCancels > 0 && isWireResponse(parsed)) {
        this.outstandingCancels--;
        continue;
      }
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(parsed);
      else this.lines.push(parsed);
    }
  }

  private fail(error: Error): void {
    if (this.closedError) return;
    this.closedError = error;
    this.outstandingCancels = 0;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.reject(error);
    }
  }

  private nextLine(): Promise<unknown> {
    const buffered = this.lines.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    if (this.closedError) return Promise.reject(this.closedError);
    return new Promise<unknown>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  private write(request: Record<string, unknown>): void {
    if (this.closedError) throw this.closedError;
    const line = `${JSON.stringify(request)}\n`;
    const bytes = Buffer.byteLength(line, "utf8");
    if (bytes > this.maxFrameBytes) throw new WireFrameTooLargeError(bytes);
    this.socket.write(line);
  }

  get closed(): boolean {
    return this.closedError !== undefined;
  }

  get pendingCancels(): number {
    return this.outstandingCancels;
  }

  close(): void {
    this.socket.destroy();
    this.fail(new WireError("io_error", "wire connection closed"));
  }

  unref(): void {
    this.socket.unref();
  }

  private async acquire(): Promise<() => void> {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.lock;
    this.lock = previous.then(() => held);
    await previous;
    return release;
  }

  async request(request: Record<string, unknown>): Promise<WireOkResponse> {
    const release = await this.acquire();
    try {
      this.write(request);
      const line = await this.nextLine();
      if (!isWireResponse(line)) {
        throw new WireError("io_error", `expected a response, got ${JSON.stringify(line).slice(0, 200)}`);
      }
      return unwrap(line);
    } finally {
      release();
    }
  }

  cancel(): void {
    if (this.closedError) return;
    this.outstandingCancels++;
    try {
      this.write({ op: "cancel" });
    } catch {
      this.outstandingCancels--;
    }
  }

  stream(request: Record<string, unknown>): AsyncGenerator<WireEvent, void, void> {
    const self = this;
    return (async function* stream(): AsyncGenerator<WireEvent, void, void> {
      const release = await self.acquire();
      try {
        self.write(request);
        for (;;) {
          const line = await self.nextLine();
          if (isWireResponse(line)) {
            if (line.ok) continue;
            throw new WireError(line.code, line.error, { tokens: line.tokens, context: line.context });
          }
          if (!isWireEvent(line)) {
            throw new WireError("io_error", `expected an event, got ${JSON.stringify(line).slice(0, 200)}`);
          }
          yield line;
          if (line.event === "done" || line.event === "error") return;
        }
      } finally {
        release();
      }
    })();
  }
}

function unwrap(response: WireResponse): WireOkResponse {
  if (response.ok) return response;
  throw new WireError(response.code, response.error, { tokens: response.tokens, context: response.context });
}

export interface ConnectOptions {
  settings: XenolithSettings;
  attempts?: number;
  baseDelayMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

function connectOnce(path: string): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const socket = connect(path);
    const onError = (error: Error): void => {
      socket.destroy();
      reject(error);
    };
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.removeListener("error", onError);
      resolve(socket);
    });
  });
}

export interface SpawnDiagnostics {
  stderr: string;
  spawnError: string | undefined;
}

export function spawnService(settings: XenolithSettings): SpawnDiagnostics {
  if (!settings.model) {
    throw new WireError(
      "invalid_request",
      'no xenolith model configured: set XENOLITH_MODEL or "model" in xenolith.json',
    );
  }
  const args = [
    "serve",
    settings.model,
    "--socket",
    settings.socket,
    "--idle-shutdown",
    String(settings.idleShutdownMinutes),
  ];
  if (settings.stateDir) args.push("--state", settings.stateDir);
  if (settings.cacheDir) args.push("--cache", settings.cacheDir);
  const diagnostics: SpawnDiagnostics = { stderr: "", spawnError: undefined };
  const child = spawn(settings.bin, args, {
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.on("error", (error: Error) => {
    diagnostics.spawnError = error.message;
  });
  const stderr = child.stderr;
  if (stderr) {
    stderr.setEncoding("utf8");
    stderr.on("data", (chunk: string) => {
      diagnostics.stderr = `${diagnostics.stderr}${chunk}`.slice(-MAX_STDERR_TAIL);
    });
    stderr.on("error", () => undefined);
  }
  child.unref();
  return diagnostics;
}

export async function openConnection(options: ConnectOptions): Promise<WireConnection> {
  const { settings } = options;
  const attempts = options.attempts ?? 40;
  const baseDelayMs = options.baseDelayMs ?? 100;
  let diagnostics: SpawnDiagnostics | undefined;
  let lastError: Error = new WireError("io_error", "wire service unreachable");
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return new WireConnection(await connectOnce(settings.socket));
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (!settings.spawn) break;
      if (!diagnostics) diagnostics = spawnService(settings);
      await sleep(Math.min(baseDelayMs * 2 ** Math.min(attempt, 5), 2000));
    }
  }
  const details: string[] = [`cannot reach the xenolith wire service at ${settings.socket}`, lastError.message];
  if (diagnostics?.spawnError) details.push(`spawn failed: ${diagnostics.spawnError}`);
  if (diagnostics?.stderr) details.push(`xenolith stderr: ${diagnostics.stderr.trim()}`);
  throw new WireError("io_error", details.join(": "));
}

export interface CreateSessionRequest {
  system?: string;
  tools?: WireToolDeclaration[];
}

export function createSessionRequest(request: CreateSessionRequest): Record<string, unknown> {
  const out: Record<string, unknown> = { op: "create" };
  if (request.system !== undefined) out["system"] = request.system;
  if (request.tools && request.tools.length > 0) out["tools"] = request.tools;
  return out;
}

export function appendRequest(message: WireMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { op: "append", role: message.role };
  if (message.text !== undefined) out["text"] = message.text;
  if (message.call_id !== undefined) out["call_id"] = message.call_id;
  if (message.status !== undefined) out["status"] = message.status;
  return out;
}

export function rebuildRequest(
  system: string | undefined,
  tools: WireToolDeclaration[],
  messages: WireMessage[],
): Record<string, unknown> {
  const out: Record<string, unknown> = { op: "rebuild", messages };
  if (system !== undefined) out["system"] = system;
  if (tools.length > 0) out["tools"] = tools;
  return out;
}

export function ephemeralRequest(
  system: string | undefined,
  tools: WireToolDeclaration[],
  messages: WireMessage[],
  params: WireGenParams,
): Record<string, unknown> {
  const out: Record<string, unknown> = { op: "ephemeral", messages, ...params };
  if (system !== undefined) out["system"] = system;
  if (tools.length > 0) out["tools"] = tools;
  return out;
}

export function generateRequest(params: WireGenParams): Record<string, unknown> {
  return { op: "generate", ...params };
}
