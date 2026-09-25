import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import { assistantFrom, collect, context, harness, toolResult, user } from "./harness.js";

const SESSION = "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000";

const weatherTool = {
  name: "get_weather",
  description: "Get the current weather for a city.",
  parameters: Type.Object({ city: Type.String() }),
};

test("first call creates a wire session, appends the context and generates", async (t) => {
  const h = await harness();
  t.after(() => h.dispose());
  h.mock.turns.push({ text: "hello there", stop: "stop" });

  const collected = await collect(h.adapter, context([user("hi")]), { sessionId: SESSION });

  assert.deepEqual(h.mock.opNames(), ["describe", "create", "append", "generate"]);
  const create = h.mock.ops[1] as Record<string, unknown>;
  assert.equal(create["system"], "You are helpful.");
  const append = h.mock.ops[2] as Record<string, unknown>;
  assert.deepEqual(append, { op: "append", role: "user", text: "hi" });
  assert.equal(collected.message.stopReason, "stop");
  assert.equal(h.adapter.bindingStore.get(SESSION), h.mock.sessionIds()[0]);
});

test("second turn appends only the suffix", async (t) => {
  const h = await harness();
  t.after(() => h.dispose());
  h.mock.turns.push({ text: "one", stop: "stop" }, { text: "two", stop: "stop" });

  const first = await collect(h.adapter, context([user("hi")]), { sessionId: SESSION });
  h.mock.reset();
  const messages = [user("hi"), assistantFrom(first), user("again")];
  const second = await collect(h.adapter, context(messages), { sessionId: SESSION });

  assert.deepEqual(h.mock.opNames(), ["append", "generate"]);
  assert.deepEqual(h.mock.ops[0], { op: "append", role: "user", text: "again" });
  assert.equal(second.message.usage.cacheRead, first.message.usage.totalTokens);
  assert.ok(second.message.usage.input < 5);
});

test("a tool loop appends the tool result against the wire-minted call id", async (t) => {
  const h = await harness();
  t.after(() => h.dispose());
  h.mock.turns.push(
    { text: "", calls: [{ name: "get_weather", arguments: { city: "Kyoto" } }], stop: "tool_use" },
    { text: "It is sunny.", stop: "stop" },
  );

  const first = await collect(h.adapter, context([user("weather?")], "You are helpful.", [weatherTool]), {
    sessionId: SESSION,
  });
  const call = first.message.content.find((block) => block.type === "toolCall");
  assert.ok(call && call.type === "toolCall");
  assert.equal(call.id, "1");
  assert.equal(first.message.stopReason, "toolUse");

  h.mock.reset();
  const messages = [user("weather?"), assistantFrom(first), toolResult(call.id, "get_weather", "sunny")];
  await collect(h.adapter, context(messages, "You are helpful.", [weatherTool]), { sessionId: SESSION });

  assert.deepEqual(h.mock.opNames(), ["append", "generate"]);
  assert.deepEqual(h.mock.ops[0], {
    op: "append",
    role: "tool",
    text: "sunny",
    call_id: 1,
    status: "ok",
  });
});

test("divergence in the middle rewinds to the previous marker and appends", async (t) => {
  const h = await harness();
  t.after(() => h.dispose());
  h.mock.turns.push({ text: "a", stop: "stop" }, { text: "b", stop: "stop" }, { text: "c", stop: "stop" });

  const first = await collect(h.adapter, context([user("one")]), { sessionId: SESSION });
  const second = await collect(
    h.adapter,
    context([user("one"), assistantFrom(first), user("two")]),
    { sessionId: SESSION },
  );
  h.mock.reset();
  h.classifications.length = 0;

  await collect(
    h.adapter,
    context([user("one"), assistantFrom(first), user("two-edited")]),
    { sessionId: SESSION },
  );

  assert.deepEqual(h.mock.opNames(), ["rewind", "append", "generate"]);
  assert.ok(h.classifications.includes("rewind"));
  assert.deepEqual(h.mock.ops[1], { op: "append", role: "user", text: "two-edited" });
  assert.ok(second.message.stopReason === "stop");
});

test("a changed system prompt rebuilds and reads the record back", async (t) => {
  const h = await harness();
  t.after(() => h.dispose());
  h.mock.turns.push({ text: "a", stop: "stop" }, { text: "b", stop: "stop" });

  const first = await collect(h.adapter, context([user("one")]), { sessionId: SESSION });
  h.mock.reset();
  h.classifications.length = 0;

  await collect(
    h.adapter,
    context([user("one"), assistantFrom(first), user("two")], "A different system prompt."),
    { sessionId: SESSION },
  );

  assert.deepEqual(h.mock.opNames(), ["rebuild", "history", "generate"]);
  assert.ok(h.classifications.includes("rebuild"));
  const rebuild = h.mock.ops[0] as Record<string, unknown>;
  assert.equal(rebuild["system"], "A different system prompt.");
  assert.equal((rebuild["messages"] as unknown[]).length, 3);
});

test("divergence at the first message rebuilds", async (t) => {
  const h = await harness();
  t.after(() => h.dispose());
  h.mock.turns.push({ text: "a", stop: "stop" }, { text: "b", stop: "stop" });

  await collect(h.adapter, context([user("one")]), { sessionId: SESSION });
  h.mock.reset();

  await collect(h.adapter, context([user("completely different")]), { sessionId: SESSION });

  assert.deepEqual(h.mock.opNames(), ["rebuild", "history", "generate"]);
});

test("marker_unavailable falls back to a rebuild", async (t) => {
  const h = await harness();
  t.after(() => h.dispose());
  h.mock.turns.push({ text: "a", stop: "stop" }, { text: "b", stop: "stop" }, { text: "c", stop: "stop" });

  const first = await collect(h.adapter, context([user("one")]), { sessionId: SESSION });
  await collect(h.adapter, context([user("one"), assistantFrom(first), user("two")]), { sessionId: SESSION });
  h.mock.reset();
  h.mock.rewindFails = true;

  await collect(h.adapter, context([user("one"), assistantFrom(first), user("two-edited")]), {
    sessionId: SESSION,
  });

  assert.deepEqual(h.mock.opNames(), ["rewind", "rebuild", "history", "generate"]);
});

test("a call without a session id runs as an ephemeral one-off", async (t) => {
  const h = await harness();
  t.after(() => h.dispose());
  h.mock.turns.push({ text: "summary", stop: "stop" });

  const collected = await collect(h.adapter, context([user("summarize")]));

  assert.deepEqual(h.mock.opNames(), ["describe", "ephemeral"]);
  assert.equal(h.mock.sessionIds().length, 0);
  assert.equal(collected.message.stopReason, "stop");
  assert.ok(h.classifications.includes("ephemeral"));
});

test("cacheRetention none is a one-off even with a session id", async (t) => {
  const h = await harness();
  t.after(() => h.dispose());
  h.mock.turns.push({ text: "summary", stop: "stop" });

  await collect(h.adapter, context([user("summarize")]), {
    sessionId: "0199ffff-0000-7000-8000-000000000000",
    cacheRetention: "none",
  });

  assert.deepEqual(h.mock.opNames(), ["describe", "ephemeral"]);
  assert.equal(h.mock.sessionIds().length, 0);
});

test("a restarted process reconciles the shadow from history", async (t) => {
  const h = await harness();
  t.after(() => h.dispose());
  h.mock.turns.push({ text: "a", stop: "stop" }, { text: "b", stop: "stop" });

  const first = await collect(h.adapter, context([user("one")]), { sessionId: SESSION });
  h.adapter.close();

  const restarted = h.newAdapter();
  h.mock.reset();
  h.classifications.length = 0;

  await collect(
    restarted,
    context([user("one"), assistantFrom(first), user("two")]),
    { sessionId: SESSION },
  );

  assert.deepEqual(h.mock.opNames(), ["describe", "open", "history", "append", "generate"]);
  assert.ok(h.classifications.includes("reconcile"));
  assert.deepEqual(h.mock.ops[3], { op: "append", role: "user", text: "two" });
});

test("reconcile keeps the tool call id mapping across a restart", async (t) => {
  const h = await harness();
  t.after(() => h.dispose());
  h.mock.turns.push(
    { text: "", calls: [{ name: "get_weather", arguments: { city: "Kyoto" } }], stop: "tool_use" },
    { text: "sunny it is", stop: "stop" },
  );

  const first = await collect(h.adapter, context([user("weather?")], "You are helpful.", [weatherTool]), {
    sessionId: SESSION,
  });
  const call = first.message.content.find((block) => block.type === "toolCall");
  assert.ok(call && call.type === "toolCall");
  h.adapter.close();

  const restarted = h.newAdapter();
  h.mock.reset();
  await collect(
    restarted,
    context(
      [user("weather?"), assistantFrom(first), toolResult(call.id, "get_weather", "sunny")],
      "You are helpful.",
      [weatherTool],
    ),
    { sessionId: SESSION },
  );

  assert.deepEqual(h.mock.opNames(), ["describe", "open", "history", "append", "generate"]);
  assert.deepEqual(h.mock.ops[3], {
    op: "append",
    role: "tool",
    text: "sunny",
    call_id: 1,
    status: "ok",
  });
});

test("a missing wire session is recreated and the binding refreshed", async (t) => {
  const h = await harness();
  t.after(() => h.dispose());
  h.mock.turns.push({ text: "a", stop: "stop" }, { text: "b", stop: "stop" });

  await collect(h.adapter, context([user("one")]), { sessionId: SESSION });
  const original = h.adapter.bindingStore.get(SESSION);
  assert.ok(original);
  h.adapter.close();

  const restarted = h.newAdapter();
  const connection = await import("../../src/wire/client.js");
  const scratch = await connection.openConnection({
    settings: (await import("./harness.js")).settingsFor(h.mock.socketPath),
  });
  await scratch.request({ op: "delete", session: original });
  scratch.close();

  h.mock.reset();
  await collect(restarted, context([user("one")]), { sessionId: SESSION });

  assert.deepEqual(h.mock.opNames(), ["describe", "open", "create", "append", "generate"]);
  assert.notEqual(restarted.bindingStore.get(SESSION), original);
});

test("reconcile detects a system prompt change recorded on the wire", async (t) => {
  const h = await harness();
  t.after(() => h.dispose());
  h.mock.turns.push({ text: "a", stop: "stop" }, { text: "b", stop: "stop" });

  const first = await collect(h.adapter, context([user("one")]), { sessionId: SESSION });
  h.adapter.close();

  const restarted = h.newAdapter();
  h.mock.reset();

  await collect(
    restarted,
    context([user("one"), assistantFrom(first), user("two")], "A different system prompt."),
    { sessionId: SESSION },
  );

  assert.deepEqual(h.mock.opNames(), ["describe", "open", "history", "rebuild", "history", "generate"]);
  const rebuild = h.mock.ops[3] as Record<string, unknown>;
  assert.equal(rebuild["system"], "A different system prompt.");
});

test("reconcile detects a tool set change recorded on the wire", async (t) => {
  const h = await harness();
  t.after(() => h.dispose());
  h.mock.turns.push({ text: "a", stop: "stop" }, { text: "b", stop: "stop" });

  const first = await collect(h.adapter, context([user("one")], "You are helpful.", [weatherTool]), {
    sessionId: SESSION,
  });
  h.adapter.close();

  const restarted = h.newAdapter();
  h.mock.reset();

  await collect(
    restarted,
    context([user("one"), assistantFrom(first), user("two")], "You are helpful.", []),
    { sessionId: SESSION },
  );

  assert.deepEqual(h.mock.opNames(), ["describe", "open", "history", "rebuild", "history", "generate"]);
});

test("reconcile keeps the shadow when the system prompt and tools are unchanged", async (t) => {
  const h = await harness();
  t.after(() => h.dispose());
  h.mock.turns.push({ text: "a", stop: "stop" }, { text: "b", stop: "stop" });

  const first = await collect(h.adapter, context([user("one")], "You are helpful.", [weatherTool]), {
    sessionId: SESSION,
  });
  h.adapter.close();

  const restarted = h.newAdapter();
  h.mock.reset();

  await collect(
    restarted,
    context([user("one"), assistantFrom(first), user("two")], "You are helpful.", [weatherTool]),
    { sessionId: SESSION },
  );

  assert.deepEqual(h.mock.opNames(), ["describe", "open", "history", "append", "generate"]);
});

test("an ephemeral one-off sends a wire-valid system, tools and message sequence", async (t) => {
  const h = await harness();
  t.after(() => h.dispose());
  h.mock.turns.push({ text: "summary", stop: "stop" });

  const first = { role: "user" as const, content: "weather?", timestamp: 0 };
  const assistant = {
    role: "assistant" as const,
    content: [
      { type: "text" as const, text: "checking" },
      { type: "toolCall" as const, id: "1", name: "get_weather", arguments: { city: "Kyoto" } },
    ],
    api: "xenolith-wire",
    provider: "xenolith",
    model: "gemma-4-26B-A4B-it-qat",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse" as const,
    timestamp: 0,
  };
  const result = toolResult("1", "get_weather", "sunny");
  const collected = await collect(
    h.adapter,
    context([first, assistant, result, { role: "user", content: "summarize", timestamp: 0 }], "System.", [
      weatherTool,
    ]),
  );

  assert.equal(collected.message.stopReason, "stop");
  assert.deepEqual(h.mock.opNames(), ["describe", "ephemeral"]);
  const request = h.mock.ops[1] as Record<string, unknown>;
  assert.equal(request["system"], "System.");
  assert.equal((request["tools"] as unknown[]).length, 1);
  assert.deepEqual(request["messages"], [
    { role: "user", text: "weather?" },
    { role: "assistant", text: "checking", calls: [{ name: "get_weather", arguments: { city: "Kyoto" } }] },
    { role: "tool", text: "sunny", tool: "get_weather", status: "ok" },
    { role: "user", text: "summarize" },
  ]);
});

test("an ephemeral request the wire would reject is reported, not silently accepted", async (t) => {
  const h = await harness();
  t.after(() => h.dispose());
  h.mock.turns.push({ text: "summary", stop: "stop" });

  const orphan = toolResult("1", "get_weather", "sunny");
  const collected = await collect(h.adapter, context([orphan], "System.", [weatherTool]));

  assert.equal(collected.message.stopReason, "error");
  assert.match(collected.message.errorMessage ?? "", /no open model turn for a tool result/);
});

test("a restart with an empty system prompt appends instead of rebuilding", async (t) => {
  const h = await harness();
  t.after(() => h.dispose());
  h.mock.turns.push({ text: "a", stop: "stop" }, { text: "b", stop: "stop" });

  const first = await collect(h.adapter, context([user("one")], ""), { sessionId: SESSION });
  h.adapter.close();

  const restarted = h.newAdapter();
  h.mock.reset();

  await collect(restarted, context([user("one"), assistantFrom(first), user("two")], ""), {
    sessionId: SESSION,
  });

  assert.deepEqual(h.mock.opNames(), ["describe", "open", "history", "append", "generate"]);
});

test("a restart with no system prompt at all appends instead of rebuilding", async (t) => {
  const h = await harness();
  t.after(() => h.dispose());
  h.mock.turns.push({ text: "a", stop: "stop" }, { text: "b", stop: "stop" });

  const bare = { messages: [user("one")] };
  const first = await collect(h.adapter, bare, { sessionId: SESSION });
  h.adapter.close();

  const restarted = h.newAdapter();
  h.mock.reset();

  await collect(
    restarted,
    { messages: [user("one"), assistantFrom(first), user("two")] },
    { sessionId: SESSION },
  );

  assert.deepEqual(h.mock.opNames(), ["describe", "open", "history", "append", "generate"]);
});
