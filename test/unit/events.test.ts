import assert from "node:assert/strict";
import test from "node:test";
import { isContextOverflow, isRetryableAssistantError, type AssistantMessage } from "@earendil-works/pi-ai";
import { errorMessageForPi } from "../../src/wire/protocol.js";
import { collect, context, harness, model, user } from "./harness.js";

const SESSION = "0199cccc-dddd-7eee-8fff-000011112222";

test("text streaming maps onto start, text_start, text_delta, text_end and done", async (t) => {
  const h = await harness();
  t.after(() => h.dispose());
  h.mock.turns.push({ text: "abcdef", chunk: 2, stop: "stop" });

  const collected = await collect(h.adapter, context([user("hi")]), { sessionId: SESSION });
  const types = collected.events.map((event) => event.type);

  assert.deepEqual(types, [
    "start",
    "text_start",
    "text_delta",
    "text_delta",
    "text_delta",
    "text_end",
    "done",
  ]);
  const end = collected.events.find((event) => event.type === "text_end");
  assert.ok(end && end.type === "text_end");
  assert.equal(end.content, "abcdef");
  assert.equal(end.contentIndex, 0);
  assert.equal(collected.message.content.length, 1);
});

test("reasoning streams as a thinking block before visible text", async (t) => {
  const h = await harness();
  t.after(() => h.dispose());
  h.mock.turns.push({ reasoning: "consider", text: "answer", stop: "stop" });

  const collected = await collect(h.adapter, context([user("hi")]), {
    sessionId: SESSION,
    reasoning: "medium",
  });

  assert.deepEqual(collected.events.map((event) => event.type), [
    "start",
    "thinking_start",
    "thinking_delta",
    "thinking_end",
    "text_start",
    "text_delta",
    "text_end",
    "done",
  ]);
  assert.deepEqual(collected.message.content, [
    { type: "thinking", thinking: "consider" },
    { type: "text", text: "answer" },
  ]);
  assert.ok(collected.message.usage.reasoning && collected.message.usage.reasoning > 0);
  const generate = h.mock.ops.find((op) => op["op"] === "generate");
  assert.deepEqual(generate?.["reasoning"], { effort: "medium" });
});

test("reasoning levels stay semantic at the wire boundary", async (t) => {
  const h = await harness();
  t.after(() => h.dispose());
  for (let index = 0; index < 4; index++)
    h.mock.turns.push({ text: "ok", stop: "stop" });

  await collect(h.adapter, context([user("off")]), {
    sessionId: `${SESSION}-off`,
  });
  await collect(h.adapter, context([user("minimal")]), {
    sessionId: `${SESSION}-minimal`,
    reasoning: "minimal",
    thinkingBudgets: { minimal: 3, low: 11 },
  });
  await collect(h.adapter, context([user("xhigh")]), {
    sessionId: `${SESSION}-xhigh`,
    reasoning: "xhigh",
    thinkingBudgets: { high: 29 },
  });
  await collect(h.adapter, context([user("max")]), {
    sessionId: `${SESSION}-max`,
    reasoning: "max",
    thinkingBudgets: { high: 47 },
  });

  const generated = h.mock.ops.filter((op) => op["op"] === "generate");
  assert.equal(generated[0]?.["reasoning"], false);
  assert.deepEqual(generated[1]?.["reasoning"], {
    effort: "low",
    budget_tokens: 11,
  });
  assert.deepEqual(generated[2]?.["reasoning"], {
    effort: "high",
    budget_tokens: 29,
  });
  assert.deepEqual(generated[3]?.["reasoning"], { effort: "max" });
});

test("tool calls close the text block and carry the wire id verbatim", async (t) => {
  const h = await harness();
  t.after(() => h.dispose());
  h.mock.turns.push({
    text: "checking",
    calls: [
      { name: "get_weather", arguments: { city: "Kyoto" } },
      { name: "get_weather", arguments: { city: "Osaka" } },
    ],
    stop: "tool_use",
  });

  const collected = await collect(h.adapter, context([user("hi")]), { sessionId: SESSION });
  const types = collected.events.map((event) => event.type);

  assert.deepEqual(types, [
    "start",
    "text_start",
    "text_delta",
    "text_end",
    "toolcall_start",
    "toolcall_end",
    "toolcall_start",
    "toolcall_end",
    "done",
  ]);
  const calls = collected.events.filter((event) => event.type === "toolcall_end");
  assert.equal(calls.length, 2);
  assert.ok(calls[0]?.type === "toolcall_end");
  assert.equal(calls[0].toolCall.id, "1");
  assert.equal(calls[0].contentIndex, 1);
  assert.deepEqual(calls[0].toolCall.arguments, { city: "Kyoto" });
  assert.ok(calls[1]?.type === "toolcall_end");
  assert.equal(calls[1].toolCall.id, "2");
  assert.equal(calls[1].contentIndex, 2);
  assert.equal(collected.message.stopReason, "toolUse");
});

test("stop reasons map from the wire vocabulary", async (t) => {
  const h = await harness();
  t.after(() => h.dispose());
  h.mock.turns.push({ text: "x", stop: "length" });

  const collected = await collect(h.adapter, context([user("hi")]), { sessionId: SESSION });

  assert.equal(collected.message.stopReason, "length");
  assert.equal(collected.message.rawStopReason, "length");
});

test("usage carries the wire accounting with zero cost", async (t) => {
  const h = await harness();
  t.after(() => h.dispose());
  h.mock.turns.push({ text: "first", stop: "stop", outputTokens: 7 });

  const collected = await collect(h.adapter, context([user("hi")]), { sessionId: SESSION });
  const usage = collected.message.usage;

  assert.equal(usage.output, 7);
  assert.equal(usage.cacheRead, 0);
  assert.ok(usage.input > 0);
  assert.equal(usage.totalTokens, usage.input + usage.cacheRead + 7);
  assert.equal(usage.cacheWrite, 0);
  assert.equal(usage.reasoning, 0);
  assert.deepEqual(usage.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
});

test("aborting cancels on the wire and reports the aborted error event", async (t) => {
  const h = await harness();
  t.after(() => h.dispose());
  h.mock.turns.push({ text: "abcdefghij", chunk: 1, delayMs: 20, stop: "stop" });

  const controller = new AbortController();
  const stream = h.adapter.streamSimple(model, context([user("hi")]), {
    sessionId: SESSION,
    signal: controller.signal,
  });
  const events: string[] = [];
  const consume = (async () => {
    for await (const event of stream) {
      events.push(event.type);
      if (event.type === "text_delta") controller.abort();
    }
    return stream.result();
  })();

  const message = await consume;
  assert.equal(message.stopReason, "aborted");
  assert.equal(events[events.length - 1], "error");
  assert.ok(h.mock.opNames().includes("cancel"));
});

test("context_length_exceeded is composed by the adapter from the wire code and recognized by pi", async (t) => {
  // 3.7 finding 4: the wire text is ours and digit-free; the adapter, the
  // only layer that knows pi, produces the message pi's generic fallback
  // pattern matches. Pinned against pi's own classifier, not a copy of it.
  const h = await harness({ contextWindow: 24 });
  t.after(() => h.dispose());
  h.mock.turns.push({ text: "never", stop: "stop" });
  const long = "x".repeat(400);

  const collected = await collect(h.adapter, context([user(long)]), { sessionId: SESSION });

  assert.equal(collected.message.stopReason, "error");
  assert.equal(collected.message.errorMessage, errorMessageForPi("context_length_exceeded", "prompt does not fit the context window"));
  assert.doesNotMatch(collected.message.errorMessage ?? "", /\d/);
  assert.equal(isContextOverflow(collected.message, 24), true);
  assert.equal(isRetryableAssistantError(collected.message), false);
  assert.ok(h.logs.some((line) => /context_length_exceeded: prompt of \d+ tokens against a window of 24 tokens/.test(line)));
});

test("every other wire error text reaches pi verbatim and is not mistaken for a retryable one", () => {
  assert.equal(errorMessageForPi("invalid_request", "unknown tool call id"), "unknown tool call id");
  assert.equal(errorMessageForPi("marker_unavailable", "marker is not addressable"), "marker is not addressable");
  const message: AssistantMessage = {
    role: "assistant",
    content: [],
    api: "xenolith-wire",
    provider: "xenolith",
    model: "gemma-4-26B-A4B-it-qat",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "error",
    errorMessage: errorMessageForPi("invalid_request", "unknown tool call id"),
    timestamp: 0,
  };
  assert.equal(isRetryableAssistantError(message), false);
  assert.equal(isContextOverflow(message, 262144), false);
});

test("a wire error event surfaces as a pi error event without invented wording", async (t) => {
  const h = await harness();
  t.after(() => h.dispose());
  h.mock.turns.push({ error: { code: "io_error", error: "engine detached" } });

  const collected = await collect(h.adapter, context([user("hi")]), { sessionId: SESSION });

  assert.equal(collected.message.stopReason, "error");
  assert.equal(collected.message.errorMessage, "engine detached");
  assert.equal(isContextOverflow(collected.message, 262144), false);
});

test("an ephemeral one-off streams events without touching a record", async (t) => {
  const h = await harness();
  t.after(() => h.dispose());
  h.mock.turns.push({ text: "brief", stop: "stop" });

  const collected = await collect(h.adapter, context([user("summarize")]));

  assert.equal(collected.message.stopReason, "stop");
  assert.equal(collected.message.usage.output > 0, true);
  assert.equal(h.mock.sessionIds().length, 0);
});

test("a signal already aborted before the call yields an aborted turn", async (t) => {
  const h = await harness();
  t.after(() => h.dispose());
  h.mock.turns.push({ text: "never seen", chunk: 1, delayMs: 5, stop: "stop" });

  const controller = new AbortController();
  controller.abort();
  const stream = h.adapter.streamSimple(model, context([user("hi")]), {
    sessionId: SESSION,
    signal: controller.signal,
  });
  for await (const event of stream) void event;
  const message = await stream.result();

  assert.equal(message.stopReason, "aborted");
  assert.ok(h.mock.opNames().includes("generate"));
});
