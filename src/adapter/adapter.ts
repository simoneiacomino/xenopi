import type { Api, Context, Model, SimpleStreamOptions, Usage } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, type AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { resolveXenolithSettings, type XenolithSettings } from "../config.js";
import { describeConnection } from "../wire/describe.js";
import {
  appendRequest,
  createSessionRequest,
  ephemeralRequest,
  generateRequest,
  openConnection,
  rebuildRequest,
  RECORD_UNREADABLE,
  WireConnection,
  WireFrameTooLargeError,
} from "../wire/client.js";
import {
  WireError,
  errorMessageForPi,
  type WireCheckpointReason,
  type WireCheckpointReport,
  type WireEvent,
  type WireGenParams,
  type WireResumeReport,
  type WireHistoryEntry,
  type WireMessage,
  type WireToolDeclaration,
  type WireDescribe,
} from "../wire/protocol.js";
import { BindingStore, listPiSessionIds } from "./bindings.js";
import {
  commonPrefixLength,
  keyOf,
  stableStringify,
  translateContext,
  type TranslatedContext,
} from "./translate.js";
import { TurnBuilder } from "./turn.js";

export interface ShadowEntry {
  key: string;
  marker: number;
  wireCallIds: number[];
}

export interface SessionState {
  piSession: string;
  wireSession: string;
  connection: WireConnection;
  systemKey: string;
  toolsKey: string;
  entries: ShadowEntry[];
  callIds: Map<string, number>;
  dirty: boolean;
  loaded: boolean;
  turn: Promise<void>;
  /** Checkpoint reasons already surfaced to the user for this session. */
  noticed: Set<string>;
}

export type Classification =
  | "ephemeral"
  | "create"
  | "append"
  | "rewind"
  | "rebuild"
  | "reconcile";

export interface AdapterOptions {
  agentDir: string;
  settings?: XenolithSettings;
  env?: NodeJS.ProcessEnv;
  onClassification?: (classification: Classification) => void;
  log?: (message: string) => void;
  /** User-facing notice (pi's ctx.ui.notify when available); falls back to log. */
  onNotice?: (message: string, level: "info" | "warning") => void;
}

export class XenolithAdapter {
  readonly agentDir: string;
  readonly settings: XenolithSettings;
  private readonly bindings: BindingStore;
  private readonly sessions = new Map<string, SessionState>();
  private readonly pending = new Map<string, Promise<SessionState>>();
  private readonly onClassification: ((classification: Classification) => void) | undefined;
  private readonly log: (message: string) => void;
  private description: WireDescribe | undefined;
  private kvstoreDisabled = false;
  private onNotice: ((message: string, level: "info" | "warning") => void) | undefined;

  constructor(options: AdapterOptions) {
    this.agentDir = options.agentDir;
    this.settings = options.settings ?? resolveXenolithSettings(options.agentDir, options.env);
    this.bindings = new BindingStore(options.agentDir);
    this.onClassification = options.onClassification;
    this.log = options.log ?? ((message: string) => process.stderr.write(`${message}\n`));
    this.onNotice = options.onNotice;
  }

  /** Route user-facing notices to a UI sink (set once pi's ctx.ui is available). */
  setNoticeSink(sink: ((message: string, level: "info" | "warning") => void) | undefined): void {
    this.onNotice = sink;
  }

  private notice(message: string, level: "info" | "warning" = "warning"): void {
    this.log(`xenopi: ${message}`);
    this.onNotice?.(message, level);
  }

  /**
   * A checkpoint that did not save is an optimization lost, never an error:
   * the session keeps working and the next open pays the prefill. Permanent
   * causes reach the user once per session; transient ones only the log
   * (the engine backs off its own retries); the rest are not news.
   */
  private reportCheckpoint(state: SessionState, report: WireCheckpointReport, origin: string): void {
    if (report.saved) return;
    const reason = report.reason ?? "unknown";
    if (reason === "nothing_new" || reason === "empty" || reason === "kv_diverged") return;
    if (reason === "no_kvstore" && this.kvstoreDisabled) return;
    const permanent = reason === "no_kvstore" || reason === "budget";
    if (!permanent) {
      this.log(`xenopi: checkpoint (${origin}) not saved: ${reason} at ${report.tokens} tokens`);
      return;
    }
    if (state.noticed.has(reason)) return;
    state.noticed.add(reason);
    const why =
      reason === "budget"
        ? "its snapshot no longer fits the engine's cache budget"
        : "the engine's snapshot store is disabled";
    this.notice(
      `this session will not resume from cache (${why}); the next open will prefill ~${report.tokens} tokens`,
    );
  }

  private reportResume(report: WireResumeReport): void {
    if (report.loaded) return;
    this.log(
      `xenopi: resume: snapshot not loaded (${report.reason ?? "unknown"}), prefilling ${report.tokens} tokens instead`,
    );
  }

  get bindingStore(): BindingStore {
    return this.bindings;
  }

  liveSession(piSession: string): SessionState | undefined {
    return this.sessions.get(piSession);
  }

  close(): void {
    for (const state of this.sessions.values()) state.connection.close();
    this.sessions.clear();
  }

  streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
    const stream = createAssistantMessageEventStream();
    const builder = new TurnBuilder(stream, model);
    void this.run(builder, context, options).catch((error: unknown) => {
      let message = error instanceof Error ? error.message : String(error);
      if (error instanceof WireError) {
        message = errorMessageForPi(error.code, error.message);
        if (error.code === "context_length_exceeded") this.logOverflow(error.detail.tokens, error.detail.context);
      }
      builder.fail(options?.signal?.aborted ? "aborted" : "error", message);
    });
    return stream;
  }

  private isOneOff(options?: SimpleStreamOptions): boolean {
    if (!options?.sessionId) return true;
    return options.cacheRetention === "none";
  }

  private async run(builder: TurnBuilder, context: Context, options?: SimpleStreamOptions): Promise<void> {
    // A stateful provider exposes the logical context before choosing append,
    // rewind, or rebuild. Replacements must go through the same translation.
    const replacement = await options?.onPayload?.(context, builder.model);
    if (replacement !== undefined) {
      if (!replacement || typeof replacement !== "object" || !("messages" in replacement) || !Array.isArray(replacement.messages)) {
        throw new WireError("invalid_request", "Xenolith onPayload must return a Pi context with messages");
      }
      context = replacement as Context;
    }
    const translated = translateContext(context);
    const params = genParams(options);
    if (this.isOneOff(options)) {
      this.onClassification?.("ephemeral");
      await this.runEphemeral(builder, translated, params, options);
      return;
    }
    const piSession = options?.sessionId as string;
    const state = await this.session(piSession, translated);
    this.validateGeneration(builder.model, params);
    await this.exclusive(state, async () => {
      try {
        await this.synchronize(state, translated);
      } catch (error) {
        state.dirty = true;
        throw error;
      }
      await this.generate(state, builder, params, options);
    });
  }

  async exclusive<T>(state: SessionState, body: () => Promise<T>): Promise<T> {
    const previous = state.turn;
    let release: () => void = () => undefined;
    state.turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await body();
    } finally {
      release();
    }
  }

  private async runEphemeral(
    builder: TurnBuilder,
    translated: TranslatedContext,
    params: WireGenParams,
    options?: SimpleStreamOptions,
  ): Promise<void> {
    const connection = await this.connect();
    try {
      this.validateGeneration(builder.model, params);
      const request = ephemeralRequest(
        translated.system,
        translated.tools,
        translated.messages.map((entry) => entry.message),
        params,
      );
      await this.consume(connection, connection.stream(request), builder, options);
    } finally {
      connection.close();
    }
  }

  private async session(piSession: string, translated: TranslatedContext): Promise<SessionState> {
    const existing = this.sessions.get(piSession);
    if (existing && !existing.connection.closed) return existing;
    const inflight = this.pending.get(piSession);
    if (inflight) return inflight;
    const created = this.openSession(piSession, translated).finally(() => {
      this.pending.delete(piSession);
    });
    this.pending.set(piSession, created);
    return created;
  }

  /** Open a wire connection carrying the frame bound the service advertised. */
  private async connect(): Promise<WireConnection> {
    const connection = await openConnection({ settings: this.settings });
    try {
      await this.verifyEngine(connection);
      return connection;
    } catch (error) {
      connection.close();
      throw error;
    }
  }

  async describe(): Promise<WireDescribe> {
    const connection = await this.connect();
    connection.close();
    return this.description!;
  }

  async verifyEngine(connection: WireConnection): Promise<void> {
    const info = await describeConnection(connection);
    const previous = this.description;
    if (previous && (previous.model !== info.model || previous.context_window !== info.context_window ||
        previous.max_output !== info.max_output || stableStringify(previous.reasoning) !== stableStringify(info.reasoning))) {
      throw new WireError("invalid_request", "Xenolith model capabilities changed; reload XenoPi before continuing");
    }
    this.description = info;
    if (!info.kvstore && !this.kvstoreDisabled) {
      this.notice("the xenolith snapshot store is disabled (see the engine log); sessions will not resume from cache");
    }
    this.kvstoreDisabled = !info.kvstore;
  }

  private validateGeneration(model: Model<Api>, params: WireGenParams): void {
    const info = this.description;
    if (!info || model.id !== info.model) {
      throw new WireError("invalid_request", "the selected model is not served by this Xenolith connection; reload XenoPi");
    }
    if (params.reasoning) {
      if (params.reasoning.effort && !info.reasoning.efforts.includes(params.reasoning.effort)) {
        throw new WireError("invalid_request", "the Xenolith service does not advertise the requested reasoning effort");
      }
      if (params.reasoning.budget_tokens !== undefined && !info.reasoning.budget_tokens) {
        throw new WireError("invalid_request", "the Xenolith service does not advertise reasoning token budgets");
      }
    }
  }

  private logOverflow(tokens: number | undefined, context: number | undefined): void {
    this.log(
      `xenopi: context_length_exceeded: prompt of ${String(tokens ?? "?")} tokens against a window of ${String(context ?? "?")} tokens; XenoPi's overflow recovery takes over`,
    );
  }

  private debug(message: string): void {
    if (process.env["XENOPI_DEBUG"] === "1") this.log(`xenopi[debug] ${message}`);
  }

  private async openSession(piSession: string, translated: TranslatedContext): Promise<SessionState> {
    const connection = await this.connect();
    const bound = this.bindings.get(piSession);
    if (bound) {
      try {
        const opened = await connection.request({ op: "open", session: bound });
        this.debug(`open: ${JSON.stringify(opened).slice(0, 400)}`);
        if (opened["zero_prefill"] === false && Number(opened["tokens"]) > 0) {
          this.log(
            `xenopi: resuming ${bound} without a current snapshot (${String(opened["resume"])}); up to ${String(opened["tokens"])} tokens of prefill ahead`,
          );
        }
        this.onClassification?.("reconcile");
        const state: SessionState = {
          piSession,
          wireSession: bound,
          connection,
          systemKey: translated.systemKey,
          toolsKey: translated.toolsKey,
          entries: [],
          callIds: new Map(),
          dirty: false,
          loaded: false,
          turn: Promise.resolve(),
          noticed: new Set(),
        };
        this.sessions.set(piSession, state);
        return state;
      } catch (error) {
        if (!(error instanceof WireError) || error.code !== "session_not_found") {
          connection.close();
          throw error;
        }
        this.bindings.delete(piSession);
      }
    }
    this.onClassification?.("create");
    const response = await connection.request(
      createSessionRequest({ system: translated.system, tools: translated.tools }),
    );
    const wireSession = String(response["session"]);
    this.bindings.set(piSession, wireSession);
    const state: SessionState = {
      piSession,
      wireSession,
      connection,
      systemKey: translated.systemKey,
      toolsKey: translated.toolsKey,
      entries: [],
      callIds: new Map(),
      dirty: false,
      loaded: true,
      turn: Promise.resolve(),
      noticed: new Set(),
    };
    this.sessions.set(piSession, state);
    return state;
  }

  private async readback(state: SessionState): Promise<{ systemKey: string; toolsKey: string } | undefined> {
    let response;
    try {
      response = await state.connection.request({ op: "history" });
    } catch (error) {
      if (error instanceof WireError && error.code === "io_error") {
        throw new WireError("invalid_request", RECORD_UNREADABLE);
      }
      throw error;
    }
    const raw = response["entries"];
    const entries: ShadowEntry[] = [];
    let recorded: { systemKey: string; toolsKey: string } | undefined;
    if (Array.isArray(raw)) {
      for (const item of raw as WireHistoryEntry[]) {
        if (item.kind === "system") {
          recorded = {
            systemKey: stableStringify(item.text || null),
            toolsKey: stableStringify(normalizeRecordedTools(item.extra)),
          };
          continue;
        }
        const { message, wireCallIds } = fromHistory(item);
        entries.push({ key: keyOf(message), marker: item.marker, wireCallIds });
      }
    }
    state.entries = entries;
    state.loaded = true;
    return recorded;
  }

  private syncCallIds(state: SessionState, translated: TranslatedContext, upto: number): void {
    state.callIds.clear();
    for (let index = 0; index < upto; index++) {
      const shadow = state.entries[index];
      const source = translated.messages[index];
      if (!shadow || !source) continue;
      for (let position = 0; position < source.toolCallIds.length; position++) {
        const piId = source.toolCallIds[position];
        const wireId = shadow.wireCallIds[position];
        if (piId === undefined || wireId === undefined) continue;
        state.callIds.set(piId, wireId);
      }
    }
  }

  private async rebuild(state: SessionState, translated: TranslatedContext): Promise<void> {
    this.onClassification?.("rebuild");
    state.dirty = true;
    try {
      await state.connection.request(
        rebuildRequest(
          translated.system,
          translated.tools,
          translated.messages.map((entry) => entry.message),
        ),
      );
    } catch (error) {
      if (error instanceof WireFrameTooLargeError) {
        throw new WireError("invalid_request", error.message);
      }
      throw error;
    }
    await this.readback(state);
    if (state.entries.length !== translated.messages.length) {
      throw new WireError(
        "io_error",
        "the xenolith record does not match the context it was rebuilt from",
      );
    }
    for (let index = 0; index < state.entries.length; index++) {
      if (state.entries[index]?.key !== translated.messages[index]?.key) {
        throw new WireError(
          "io_error",
          "the xenolith record does not match the context it was rebuilt from",
        );
      }
    }
    state.systemKey = translated.systemKey;
    state.toolsKey = translated.toolsKey;
    state.dirty = false;
    this.syncCallIds(state, translated, state.entries.length);
  }

  private async reconnect(state: SessionState): Promise<void> {
    state.connection.close();
    const connection = await this.connect();
    await connection.request({ op: "open", session: state.wireSession });
    state.connection = connection;
  }

  private async synchronize(state: SessionState, translated: TranslatedContext): Promise<void> {
    if (!state.loaded) {
      let recorded: { systemKey: string; toolsKey: string } | undefined;
      try {
        recorded = await this.readback(state);
      } catch (error) {
        if (!(error instanceof WireError) || error.message !== RECORD_UNREADABLE) throw error;
        this.log("xenopi: the xenolith record could not be read back, rebuilding from XenoPi's context");
        await this.reconnect(state);
        state.entries = [];
        state.loaded = true;
        state.dirty = true;
        await this.rebuild(state, translated);
        return;
      }
      if (recorded) {
        state.systemKey = recorded.systemKey;
        state.toolsKey = recorded.toolsKey;
      }
    }
    if (state.dirty || state.systemKey !== translated.systemKey || state.toolsKey !== translated.toolsKey) {
      this.debug(
        `rebuild: dirty=${String(state.dirty)} system=${String(state.systemKey === translated.systemKey)} tools=${String(state.toolsKey === translated.toolsKey)} recorded_system=${state.systemKey.slice(0, 120)} incoming_system=${translated.systemKey.slice(0, 120)}`,
      );
      await this.rebuild(state, translated);
      return;
    }
    const shadowKeys = state.entries.map((entry) => entry.key);
    const incomingKeys = translated.messages.map((entry) => entry.key);
    const prefix = commonPrefixLength(shadowKeys, incomingKeys);
    this.debug(
      `scan: shadow=${String(shadowKeys.length)} incoming=${String(incomingKeys.length)} prefix=${String(prefix)}` +
        (prefix < shadowKeys.length ? ` shadow[${String(prefix)}]=${shadowKeys[prefix]?.slice(0, 160)} incoming[${String(prefix)}]=${incomingKeys[prefix]?.slice(0, 160)}` : ""),
    );
    if (prefix < state.entries.length) {
      const anchor = prefix > 0 ? state.entries[prefix - 1] : undefined;
      if (!anchor || rewindDropsNeededCalls(anchor, translated.messages[prefix])) {
        await this.rebuild(state, translated);
        return;
      }
      try {
        this.onClassification?.("rewind");
        await state.connection.request({ op: "rewind", marker: anchor.marker });
      } catch (error) {
        if (error instanceof WireError && error.code === "marker_unavailable") {
          await this.rebuild(state, translated);
          return;
        }
        throw error;
      }
      state.entries.length = prefix;
    }
    this.syncCallIds(state, translated, prefix);
    if (prefix === translated.messages.length) return;
    this.onClassification?.("append");
    for (let index = prefix; index < translated.messages.length; index++) {
      const source = translated.messages[index];
      if (!source) continue;
      if (source.message.role === "assistant") {
        await this.rebuild(state, translated);
        return;
      }
      const message: WireMessage = { ...source.message };
      if (message.role === "tool") {
        const callId = this.resolveCallId(state, source.toolResultId);
        if (callId === undefined) {
          await this.rebuild(state, translated);
          return;
        }
        message.call_id = callId;
      }
      let response;
      try {
        response = await state.connection.request(appendRequest(message));
      } catch (error) {
        if (error instanceof WireError && error.code === "invalid_request") {
          await this.rebuild(state, translated);
          return;
        }
        throw error;
      }
      state.entries.push({
        key: source.key,
        marker: Number(response["marker"]),
        wireCallIds: [],
      });
    }
  }

  private resolveCallId(state: SessionState, piCallId: string | undefined): number | undefined {
    if (piCallId === undefined) return undefined;
    return state.callIds.get(piCallId);
  }

  private async generate(
    state: SessionState,
    builder: TurnBuilder,
    params: WireGenParams,
    options?: SimpleStreamOptions,
  ): Promise<void> {
    const stream = state.connection.stream(generateRequest(params));
    const outcome = await this.consume(state.connection, stream, builder, options, state);
    if (outcome.kind === "done" && outcome.marker !== null && outcome.stop !== "aborted") {
      state.entries.push({
        key: keyOf(builder.wireMessage),
        marker: outcome.marker,
        wireCallIds: builder.wireCallIds,
      });
      for (const id of builder.wireCallIds) state.callIds.set(String(id), id);
      return;
    }
    state.dirty = true;
  }

  private async consume(
    connection: WireConnection,
    stream: AsyncGenerator<WireEvent, void, void>,
    builder: TurnBuilder,
    options?: SimpleStreamOptions,
    state?: SessionState,
  ): Promise<{ kind: "done"; stop: string; marker: number | null } | { kind: "error" }> {
    const signal = options?.signal;
    let aborted = false;
    let started = false;
    let deferredCancel = false;
    const abort = (): void => {
      aborted = true;
      if (started) connection.cancel();
      else deferredCancel = true;
    };
    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }
    try {
      for await (const event of stream) {
        options?.onProviderStreamEvent?.(event, builder.model);
        if (!started) {
          started = true;
          if (deferredCancel) connection.cancel();
        }
        switch (event.event) {
          case "start":
            builder.start();
            break;
          case "progress":
            break;
          case "text_delta":
            builder.textDelta(event.text);
            break;
          case "reasoning_delta":
            builder.reasoningDelta(event.text);
            break;
          case "toolcall_start":
            builder.toolCallStart();
            break;
          case "toolcall_end":
            builder.toolCallEnd(event.id, event.name, event.arguments ?? {});
            break;
          case "done":
            this.debug(`done: stop=${String(event.stop)} usage=${JSON.stringify(event.usage)}`);
            if (event.checkpoint && state) this.reportCheckpoint(state, event.checkpoint, "autosave");
            if (event.resume) this.reportResume(event.resume);
            if (event.stop === "aborted" || aborted) {
              builder.fail("aborted", "aborted", event.usage);
              return { kind: "done", stop: "aborted", marker: event.marker };
            }
            builder.done(event.stop, event.usage);
            return { kind: "done", stop: event.stop, marker: event.marker };
          case "error":
            builder.fail("error", errorMessageForPi(event.code, event.error));
            if (event.code === "context_length_exceeded") this.logOverflow(event.tokens, event.context);
            else this.log(`wire error ${event.code}: ${event.error}`);
            return { kind: "error" };
        }
      }
      builder.fail("error", "the wire stream ended without a terminal event");
      return { kind: "error" };
    } finally {
      if (signal) signal.removeEventListener("abort", abort);
    }
  }

  async checkpoint(piSession: string): Promise<WireCheckpointReport | undefined> {
    const state = this.sessions.get(piSession);
    if (!state || state.connection.closed) return undefined;
    const response = await state.connection.request({ op: "checkpoint" });
    const report: WireCheckpointReport = {
      saved: response["saved"] === true,
      reason: typeof response["reason"] === "string" ? (response["reason"] as WireCheckpointReason) : undefined,
      tokens: Number(response["tokens"] ?? 0),
    };
    this.reportCheckpoint(state, report, "checkpoint");
    return report;
  }

  markDirty(piSession: string): void {
    const state = this.sessions.get(piSession);
    if (state) state.dirty = true;
  }

  async summarize(
    piSession: string,
    prompt: string,
    params: WireGenParams,
    model: Model<Api>,
    signal?: AbortSignal,
    expectedPrefix?: string[],
  ): Promise<{ text: string; usage: Usage } | undefined> {
    const state = this.sessions.get(piSession);
    if (!state || state.connection.closed || state.dirty || !state.loaded) return undefined;
    if (expectedPrefix && !this.shadowStartsWith(state, expectedPrefix)) return undefined;
    return this.exclusive(state, async () => {
      if (state.dirty) return undefined;
      state.dirty = true;
      await state.connection.request(appendRequest({ role: "user", text: prompt }));
      const stream = createAssistantMessageEventStream();
      const builder = new TurnBuilder(stream, model);
      const outcome = await this.consume(state.connection, state.connection.stream(generateRequest(params)), builder, {
        signal,
      } as SimpleStreamOptions);
      if (outcome.kind !== "done" || outcome.stop !== "stop") return undefined;
      if (builder.wireCallIds.length > 0) return undefined;
      return { text: builder.text, usage: builder.message.usage };
    });
  }

  shadowStartsWith(state: SessionState, keys: readonly string[]): boolean {
    if (keys.length > state.entries.length) return false;
    for (let index = 0; index < keys.length; index++) {
      if (state.entries[index]?.key !== keys[index]) return false;
    }
    return true;
  }

  async sweep(sessionDirOverride?: string): Promise<string[]> {
    const known = listPiSessionIds(this.agentDir, sessionDirOverride);
    if (known.size === 0) {
      this.log("xenopi: no XenoPi sessions listed, skipping the orphan sweep");
      return [];
    }
    const orphans = this.bindings.entries().filter(([piSession]) => !known.has(piSession));
    if (orphans.length === 0) return [];
    const removed: string[] = [];
    let connection: WireConnection | undefined;
    try {
      connection = await this.connect();
      for (const [piSession, record] of orphans) {
        try {
          await connection.request({ op: "delete", session: record.wireSession });
        } catch (error) {
          if (!(error instanceof WireError) || error.code !== "session_not_found") continue;
        }
        this.bindings.delete(piSession);
        removed.push(piSession);
      }
    } finally {
      connection?.close();
    }
    return removed;
  }
}

function genParams(options?: SimpleStreamOptions): WireGenParams {
  const params: WireGenParams = {};
  if (typeof options?.temperature === "number") params.temperature = options.temperature;
  if (typeof options?.maxTokens === "number" && options.maxTokens > 0) params.max_tokens = options.maxTokens;
  const sampling = options?.samplingParams;
  if (sampling) {
    if (typeof sampling["top_k"] === "number") params.top_k = sampling["top_k"];
    if (typeof sampling["top_p"] === "number") params.top_p = sampling["top_p"];
  }
  const level = options?.reasoning;
  if (level === undefined) {
    params.reasoning = false;
  } else {
    const effort = level === "minimal" ? "low" : level === "xhigh" ? "high" : level;
    const reasoning: Exclude<WireGenParams["reasoning"], false | undefined> = { effort };
    const budget = effort === "max" ? undefined : options?.thinkingBudgets?.[effort];
    if (typeof budget === "number" && budget >= 0) reasoning.budget_tokens = budget;
    params.reasoning = reasoning;
  }
  return params;
}

export function fromHistory(entry: WireHistoryEntry): { message: WireMessage; wireCallIds: number[] } {
  if (entry.kind === "user") {
    return { message: { role: "user", text: entry.text }, wireCallIds: [] };
  }
  if (entry.kind === "assistant") {
    const message: WireMessage = { role: "assistant", text: entry.text };
    if (entry.reasoning !== undefined) message.reasoning = entry.reasoning;
    const wireCallIds: number[] = [];
    if (Array.isArray(entry.extra)) {
      const calls = entry.extra as { id?: number; name?: string; arguments?: Record<string, unknown> }[];
      const mapped = calls
        .filter((call) => typeof call.name === "string")
        .map((call) => {
          wireCallIds.push(typeof call.id === "number" ? call.id : -1);
          return { name: call.name as string, arguments: call.arguments ?? {} };
        });
      if (mapped.length > 0) message.calls = mapped;
    }
    return { message, wireCallIds };
  }
  const message: WireMessage = {
    role: "tool",
    text: entry.text,
    status: entry.status === "error" ? "error" : "ok",
  };
  if (entry.tool !== undefined) message.tool = entry.tool;
  return { message, wireCallIds: [] };
}

export function rewindDropsNeededCalls(
  anchor: ShadowEntry,
  next: { message: WireMessage } | undefined,
): boolean {
  return anchor.wireCallIds.length > 0 && next?.message.role === "tool";
}

export function normalizeRecordedTools(extra: unknown): WireToolDeclaration[] {
  if (!Array.isArray(extra)) return [];
  const tools: WireToolDeclaration[] = [];
  for (const item of extra as Record<string, unknown>[]) {
    if (typeof item["name"] !== "string" || typeof item["description"] !== "string") continue;
    const tool: WireToolDeclaration = { name: item["name"], description: item["description"] };
    const parameters = item["parameters"];
    if (parameters && typeof parameters === "object") tool.parameters = parameters as Record<string, unknown>;
    tools.push(tool);
  }
  return tools;
}

export function toolsOf(context: Context): WireToolDeclaration[] {
  return translateContext(context).tools;
}
