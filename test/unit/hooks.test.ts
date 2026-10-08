import { normalizeContext } from "@earendil-works/pi-ai";
import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessageEvent, Context, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ProviderConfig,
  SessionBeforeCompactEvent,
  SessionBeforeTreeEvent,
  SessionCompactEvent,
} from "@earendil-works/pi-coding-agent";
import type { CompactionResult } from "@earendil-works/pi-coding-agent";
import {
  buildSummaryPrompt,
  compactionPrefixKeys,
  PROVIDER_API,
  PROVIDER_ID,
  summaryMaxTokens,
} from "../../src/extensions/provider.js";
import xenolithProvider from "../../src/extensions/provider.js";
import { assistantFrom, collect, context, harness, model, user } from "./harness.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { MockWireServer } from "./mock-wire.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface SessionBeforeCompactResult {
  cancel?: boolean;
  compaction?: CompactionResult;
}

const SESSION = "0199bbbb-1111-7222-8333-444455556666";

function lastAssistant(events: AssistantMessageEvent[]): AssistantMessage {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event?.type === "done") return event.message;
    if (event?.type === "error") return event.error;
  }
  throw new Error("no terminal event in the stream");
}

interface Registered {
  providers: { name: string; config: ProviderConfig }[];
  handlers: Map<string, ((event: unknown, ctx: unknown) => unknown)[]>;
}

function fakePi(): { pi: ExtensionAPI; registered: Registered } {
  const registered: Registered = { providers: [], handlers: new Map() };
  const pi = {
    on(event: string, handler: (payload: unknown, ctx: unknown) => unknown): void {
      const list = registered.handlers.get(event) ?? [];
      list.push(handler);
      registered.handlers.set(event, list);
    },
    registerProvider(name: string, config: ProviderConfig): void {
      registered.providers.push({ name, config });
    },
    registerTool(): void {
      return;
    },
  } as unknown as ExtensionAPI;
  return { pi, registered };
}

function compactionEvent(
  messagesToSummarize: AgentMessage[],
  overrides: Record<string, unknown> = {},
): SessionBeforeCompactEvent {
  return {
    type: "session_before_compact",
    preparation: {
      firstKeptEntryId: "entry-7",
      messagesToSummarize,
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 1234,
      fileOps: { read: [], edited: [], created: [] },
      settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
      ...overrides,
    },
    branchEntries: [],
    reason: "threshold",
    willRetry: false,
    signal: new AbortController().signal,
  } as unknown as SessionBeforeCompactEvent;
}

async function emit(registered: Registered, event: string, payload: unknown, ctx: unknown): Promise<unknown> {
  let result: unknown;
  for (const handler of registered.handlers.get(event) ?? []) {
    const value = await handler(payload, ctx);
    if (value !== undefined) result = value;
  }
  return result;
}

async function withExtension<T>(
  body: (input: {
    mock: MockWireServer;
    registered: Registered;
    stream: (ctx: Context, options?: SimpleStreamOptions) => Promise<AssistantMessageEvent[]>;
    ctx: ExtensionContext;
  }) => Promise<T>,
): Promise<T> {
  const mock = await MockWireServer.start();
  const agentDir = mkdtempSync(join(tmpdir(), "xenopi-hooks-"));
  const previous = { ...process.env };
  process.env["PI_CODING_AGENT_DIR"] = agentDir;
  process.env["XENOLITH_SOCKET"] = mock.socketPath;
  process.env["XENOLITH_NO_SPAWN"] = "1";
  try {
    const { pi, registered } = fakePi();
    await xenolithProvider(pi);
    mock.reset();
    const entry = registered.providers[0];
    assert.ok(entry);
    const streamSimple = entry.config.streamSimple;
    assert.ok(streamSimple);
    const stream = async (ctx: Context, options?: SimpleStreamOptions): Promise<AssistantMessageEvent[]> => {
      const events: AssistantMessageEvent[] = [];
      const source = streamSimple(model, normalizeContext(ctx), options);
      for await (const event of source) events.push(event);
      await source.result();
      return events;
    };
    const ctx = {
      sessionManager: { getSessionId: () => SESSION },
      model,
    } as unknown as ExtensionContext;
    return await body({ mock, registered, stream, ctx });
  } finally {
    process.env = previous;
    await mock.stop();
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(mock.directory, { recursive: true, force: true });
  }
}

test("the extension registers the xenolith provider with the engine facts", async () => {
  await withExtension(async ({ registered }) => {
    const entry = registered.providers[0];
    assert.ok(entry);
    assert.equal(entry.name, PROVIDER_ID);
    assert.equal(entry.config.api, PROVIDER_API);
    assert.ok(entry.config.baseUrl);
    assert.ok(entry.config.apiKey);
    const models = entry.config.models ?? [];
    assert.equal(models.length, 1);
    const registeredModel = models[0];
    assert.ok(registeredModel && (!registeredModel.type || registeredModel.type === "chat"));
    assert.equal(registeredModel.id, model.id);
    assert.equal(registeredModel.contextWindow, 4096);
    assert.equal(registeredModel.maxTokens, 4096);
    assert.deepEqual(registeredModel.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    assert.deepEqual(registeredModel.input, ["text"]);
    assert.equal(registeredModel.reasoning, true);
    assert.deepEqual(registeredModel.thinkingLevelMap, {
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
      max: "max",
    });
  });
});

test("the provider displays measured progress through Pi's working message only in TUI mode", async () => {
  await withExtension(async ({ mock, registered, stream, ctx }) => {
    const lines: (string | undefined)[] = [];
    const uiContext = {
      ...ctx,
      mode: "tui",
      sessionManager: { getSessionId: () => SESSION, getSessionDir: () => mock.directory },
      ui: { setWorkingMessage: (line: string | undefined) => lines.push(line), notify: () => undefined },
    } as unknown as ExtensionContext;
    await emit(registered, "session_start", {}, uiContext);
    mock.turns.push({ text: "answer", progressEvents: [
      { event: "inference_progress", phase: "prefill", state: "running", tokens: 0, total: 200, elapsed_ms: 0 },
      { event: "inference_progress", phase: "prefill", state: "running", tokens: 100, total: 200, elapsed_ms: 1000 },
      { event: "inference_progress", phase: "prefill", state: "finished", tokens: 200, total: 200, elapsed_ms: 2000 },
      { event: "inference_progress", phase: "decode", state: "running", tokens: 0, elapsed_ms: 0 },
      { event: "inference_progress", phase: "decode", state: "running", tokens: 20, elapsed_ms: 1000 },
    ], finalProgressEvents: [
      { event: "inference_progress", phase: "decode", state: "finished", tokens: 21, elapsed_ms: 1050 },
    ] });
    await stream(context([user("hello")]), { sessionId: SESSION });
    assert.ok(lines.some((line) => line?.includes("50% · 100/200 tok · 100.0 tok/s")));
    assert.ok(lines.some((line) => line?.includes("20 tok · 20.0 tok/s")));
    assert.ok(lines.some((line) => line?.includes("Finalizing…")));
    assert.equal(lines.at(-1), undefined);

    await emit(registered, "session_start", {}, { ...uiContext, mode: "print" });
    lines.length = 0;
    mock.turns.push({ text: "plain" });
    await stream(context([user("plain")]));
    assert.deepEqual(lines, []);
    await emit(registered, "session_shutdown", {}, uiContext);
  });
});

for (const hook of ["agent_end", "model_select", "session_shutdown"] as const) {
  test(`the ${hook} hook clears the progress line and ignores later stream events`, async () => {
    await withExtension(async ({ mock, registered, stream, ctx }) => {
      const lines: (string | undefined)[] = [];
      const uiContext = {
        ...ctx,
        mode: "tui",
        sessionManager: { getSessionId: () => SESSION, getSessionDir: () => mock.directory },
        ui: { setWorkingMessage: (line: string | undefined) => lines.push(line), notify: () => undefined },
      } as unknown as ExtensionContext;
      await emit(registered, "session_start", {}, uiContext);
      mock.turns.push({ text: "abcdef", chunk: 1, delayMs: 5 });
      let clearedAt: number | undefined;
      await stream(context([user("hello")]), {
        sessionId: SESSION,
        onProviderStreamEvent: (raw) => {
          if ((raw as { event: string }).event === "text_delta" && clearedAt === undefined) {
            void emit(registered, hook, {}, uiContext);
            clearedAt = lines.length;
          }
        },
      });
      assert.ok(clearedAt !== undefined);
      assert.equal(lines.at(-1), undefined);
      assert.equal(lines.length, clearedAt);
      await emit(registered, "session_shutdown", {}, uiContext);
    });
  });
}

test("session_before_compact summarizes on the live wire session at zero prefill", async () => {
  await withExtension(async ({ mock, registered, stream, ctx }) => {
    mock.turns.push({ text: "answer", stop: "stop" }, { text: "## Goal\nship it", stop: "stop" });
    const events = await stream(context([user("hello")]), { sessionId: SESSION });
    const assistant = lastAssistant(events);
    mock.reset();

    const event = compactionEvent([user("hello") as AgentMessage, assistant as AgentMessage]);
    const result = (await emit(registered, "session_before_compact", event, ctx)) as
      | SessionBeforeCompactResult
      | undefined;

    assert.deepEqual(mock.opNames(), ["append", "generate"]);
    const appended = mock.ops[0] as Record<string, unknown>;
    assert.equal(appended["role"], "user");
    assert.equal(String(appended["text"]).includes("The messages above are a conversation to summarize"), true);
    const generate = mock.ops[1] as Record<string, unknown>;
    assert.equal(generate["max_tokens"], summaryMaxTokens(16384, model.maxTokens));
    assert.ok(result?.compaction);
    assert.equal(result.compaction.summary, "## Goal\nship it");
    assert.equal(result.compaction.firstKeptEntryId, "entry-7");
    assert.equal(result.compaction.tokensBefore, 1234);
    assert.equal(result.compaction.usage?.cost.total, 0);
  });
});

test("session_before_compact degrades when the live record does not carry the compacted prefix", async () => {
  await withExtension(async ({ mock, registered, stream, ctx }) => {
    mock.turns.push({ text: "answer", stop: "stop" });
    await stream(context([user("hello")]), { sessionId: SESSION });
    mock.reset();

    const event = compactionEvent([user("a completely different first turn") as AgentMessage]);
    const result = await emit(registered, "session_before_compact", event, ctx);

    assert.equal(result, undefined);
    assert.deepEqual(mock.opNames(), []);
  });
});

test("session_before_compact degrades when the summary turn stops on length", async () => {
  await withExtension(async ({ mock, registered, stream, ctx }) => {
    mock.turns.push({ text: "answer", stop: "stop" }, { text: "truncated summ", stop: "length" });
    const events = await stream(context([user("hello")]), { sessionId: SESSION });
    const assistant = lastAssistant(events);
    mock.reset();

    const event = compactionEvent([user("hello") as AgentMessage, assistant as AgentMessage]);
    const result = await emit(registered, "session_before_compact", event, ctx);

    assert.equal(result, undefined);
    assert.deepEqual(mock.opNames(), ["append", "generate"]);
  });
});

test("session_before_compact degrades when the summary turn stops on a tool call", async () => {
  await withExtension(async ({ mock, registered, stream, ctx }) => {
    mock.turns.push(
      { text: "answer", stop: "stop" },
      { text: "", calls: [{ name: "get_weather", arguments: {} }], stop: "tool_use" },
    );
    const events = await stream(context([user("hello")]), { sessionId: SESSION });
    const assistant = lastAssistant(events);
    mock.reset();

    const event = compactionEvent([user("hello") as AgentMessage, assistant as AgentMessage]);
    const result = await emit(registered, "session_before_compact", event, ctx);

    assert.equal(result, undefined);
  });
});

test("session_before_compact degrades when there is no live wire session", async () => {
  await withExtension(async ({ mock, registered, ctx }) => {
    const event = compactionEvent([user("hello") as AgentMessage]);
    const result = await emit(registered, "session_before_compact", event, ctx);

    assert.equal(result, undefined);
    assert.deepEqual(mock.opNames(), []);
  });
});

test("a failed summary generation leaves the shadow dirty so the next turn rebuilds", async () => {
  await withExtension(async ({ mock, registered, stream, ctx }) => {
    mock.turns.push(
      { text: "answer", stop: "stop" },
      { reject: { code: "context_length_exceeded", error: "prompt has many tokens" } },
      { text: "after", stop: "stop" },
    );
    const events = await stream(context([user("hello")]), { sessionId: SESSION });
    const assistant = lastAssistant(events);
    mock.reset();

    const event = compactionEvent([user("hello") as AgentMessage, assistant as AgentMessage]);
    const result = await emit(registered, "session_before_compact", event, ctx);
    assert.equal(result, undefined);
    mock.reset();

    await stream(context([user("hello"), assistant, user("next")]), { sessionId: SESSION });

    assert.deepEqual(mock.opNames(), ["rebuild", "history", "generate"]);
  });
});

test("compactionPrefixKeys matches the adapter's translated keys", async () => {
  const keys = compactionPrefixKeys([user("hello") as AgentMessage]);
  assert.equal(keys.length, 1);
  assert.match(keys[0] ?? "", /"role":"user"/);
});

test("the compacted session rebuilds on the next provider call", async () => {
  await withExtension(async ({ mock, registered, stream, ctx }) => {
    mock.turns.push(
      { text: "answer", stop: "stop" },
      { text: "## Goal\nship it", stop: "stop" },
      { text: "after compaction", stop: "stop" },
    );
    const events = await stream(context([user("hello")]), { sessionId: SESSION });
    const assistant = lastAssistant(events);

    const event = compactionEvent([user("hello") as AgentMessage, assistant as AgentMessage], {
      tokensBefore: 10,
    });
    await emit(registered, "session_before_compact", event, ctx);
    await emit(
      registered,
      "session_compact",
      { type: "session_compact", fromExtension: true, reason: "threshold", willRetry: false } as unknown as SessionCompactEvent,
      ctx,
    );
    mock.reset();

    await stream(context([user("compacted context")]), { sessionId: SESSION });

    assert.deepEqual(mock.opNames(), ["rebuild", "history", "generate"]);
  });
});

test("session_before_tree issues a wire checkpoint", async () => {
  await withExtension(async ({ mock, registered, stream, ctx }) => {
    mock.turns.push({ text: "answer", stop: "stop" });
    await stream(context([user("hello")]), { sessionId: SESSION });
    mock.reset();

    await emit(
      registered,
      "session_before_tree",
      {
        type: "session_before_tree",
        preparation: {
          targetId: "x",
          oldLeafId: null,
          commonAncestorId: null,
          entriesToSummarize: [],
          userWantsSummary: false,
        },
        signal: new AbortController().signal,
      } as unknown as SessionBeforeTreeEvent,
      ctx,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    assert.deepEqual(mock.opNames(), ["checkpoint"]);
  });
});

test("the summary prompt mirrors pi's compaction prompt shape", () => {
  const initial = buildSummaryPrompt();
  assert.match(initial, /^The messages above are a conversation to summarize\./);
  assert.match(initial, /## Critical Context/);

  const update = buildSummaryPrompt("previous text", "focus on tests");
  assert.match(update, /^<previous-summary>\nprevious text\n<\/previous-summary>/);
  assert.match(update, /The messages above are NEW conversation messages to incorporate/);
  assert.match(update, /Additional focus: focus on tests$/);
});

test("the summary token budget follows pi's min(0.8 * reserve, model maxTokens)", () => {
  assert.equal(summaryMaxTokens(16384, 262144), Math.floor(0.8 * 16384));
  assert.equal(summaryMaxTokens(16384, 4096), 4096);
  assert.equal(summaryMaxTokens(16384, 0), Math.floor(0.8 * 16384));
});

test("adapter checkpoint and markDirty operate on the live session only", async (t) => {
  const h = await harness();
  t.after(() => h.dispose());
  h.mock.turns.push({ text: "a", stop: "stop" }, { text: "b", stop: "stop" });

  await h.adapter.checkpoint("unknown-session");
  assert.deepEqual(h.mock.opNames(), []);

  const first = await collect(h.adapter, context([user("one")]), { sessionId: SESSION });
  h.mock.reset();
  await h.adapter.checkpoint(SESSION);
  assert.deepEqual(h.mock.opNames(), ["checkpoint"]);

  h.adapter.markDirty(SESSION);
  h.mock.reset();
  await collect(h.adapter, context([user("one"), assistantFrom(first), user("two")]), { sessionId: SESSION });
  assert.deepEqual(h.mock.opNames(), ["rebuild", "history", "generate"]);
});

test("checkpoint reports reach the user once for permanent causes and the log for transient ones", async (t) => {
  const h = await harness();
  t.after(() => h.dispose());
  h.mock.turns.push({ text: "a", stop: "stop" });
  await collect(h.adapter, context([user("one")]), { sessionId: SESSION });

  const saved = await h.adapter.checkpoint(SESSION);
  assert.equal(saved?.saved, true);
  const again = await h.adapter.checkpoint(SESSION);
  assert.deepEqual([again?.saved, again?.reason], [false, "nothing_new"]);
  assert.deepEqual(h.notices, []);

  h.mock.checkpointFailure = "io";
  const io = await h.adapter.checkpoint(SESSION);
  assert.deepEqual([io?.saved, io?.reason], [false, "io"]);
  assert.deepEqual(h.notices, []);
  assert.ok(h.logs.some((line) => line.includes("checkpoint (checkpoint) not saved: io")));

  h.mock.checkpointFailure = "budget";
  await h.adapter.checkpoint(SESSION);
  await h.adapter.checkpoint(SESSION);
  assert.equal(h.notices.length, 1);
  assert.match(h.notices[0] ?? "", /will not resume from cache .*cache budget/);
});

test("a disabled snapshot store is announced once at describe and silences no_kvstore checkpoints", async (t) => {
  const h = await harness();
  t.after(() => h.dispose());
  h.mock.kvstore = false;
  h.mock.turns.push({ text: "a", stop: "stop" });
  await collect(h.adapter, context([user("one")]), { sessionId: SESSION });
  assert.equal(h.notices.length, 1);
  assert.match(h.notices[0] ?? "", /snapshot store is disabled/);
  const report = await h.adapter.checkpoint(SESSION);
  assert.deepEqual([report?.saved, report?.reason], [false, "no_kvstore"]);
  assert.equal(h.notices.length, 1);
});
