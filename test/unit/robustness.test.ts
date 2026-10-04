import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { XenolithAdapter } from "../../src/adapter/adapter.js";
import { FRAME_TOO_LARGE, openConnection } from "../../src/wire/client.js";
import { assistant, assistantFrom, collect, context, harness, model, settingsFor, toolResult, user } from "./harness.js";
import type { Message } from "@earendil-works/pi-ai";
import { MockWireServer } from "./mock-wire.js";

const SESSION = "0199dddd-2222-7333-8444-555566667777";

const weatherTool = {
  name: "get_weather",
  description: "Get the current weather for a city.",
  parameters: { type: "object", properties: { city: { type: "string" } } } as never,
};

test("a cancel reply on an idle connection never desyncs the next request", async (t) => {
  const mock = await MockWireServer.start();
  t.after(async () => {
    await mock.stop();
    rmSync(mock.directory, { recursive: true, force: true });
  });
  const connection = await openConnection({ settings: settingsFor(mock.socketPath) });
  t.after(() => connection.close());

  const first = await connection.request({ op: "describe" });
  assert.equal(first["protocol"], 1);

  connection.cancel();
  await new Promise<void>((resolve) => setTimeout(resolve, 50));

  const second = await connection.request({ op: "list" });
  assert.ok(Array.isArray(second["sessions"]));
  const third = await connection.request({ op: "describe" });
  assert.equal(third["protocol"], 1);
  assert.equal(connection.pendingCancels, 0);
});

test("an aborted turn leaves the connection usable for the next turn", async (t) => {
  const h = await harness();
  t.after(() => h.dispose());
  h.mock.turns.push({ text: "abcdefghij", chunk: 1, delayMs: 10, stop: "stop" }, { text: "second", stop: "stop" });

  const controller = new AbortController();
  const stream = h.adapter.streamSimple(model, context([user("one")]), {
    sessionId: SESSION,
    signal: controller.signal,
  });
  for await (const event of stream) {
    if (event.type === "text_delta") controller.abort();
  }
  const aborted = await stream.result();
  assert.equal(aborted.stopReason, "aborted");
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  h.mock.reset();

  const next = await collect(h.adapter, context([user("one"), user("two")]), { sessionId: SESSION });

  assert.equal(next.message.stopReason, "stop");
  assert.deepEqual(h.mock.opNames(), ["rebuild", "history", "generate"]);
});

test("an oversized append frame is refused deterministically instead of killing the socket", async (t) => {
  const h = await harness({ contextWindow: 1000000, maxLine: 512 * 1024 });
  t.after(() => h.dispose());
  h.mock.turns.push({ text: "a", stop: "stop" });
  const huge = "x".repeat(1024 * 1024);

  const collected = await collect(h.adapter, context([user(huge)]), { sessionId: SESSION });

  assert.equal(collected.message.stopReason, "error");
  assert.equal(collected.message.errorMessage, FRAME_TOO_LARGE);
  assert.equal(h.mock.opNames().includes("append"), false);
  assert.equal(h.mock.droppedConnections, 0);
});

test("an oversized rebuild frame is refused deterministically", async (t) => {
  // The service advertises its frame bound in describe; the client refuses
  // above it before writing, whatever the token window allows.
  const h = await harness({ contextWindow: 1000000, maxLine: 512 * 1024 });
  t.after(() => h.dispose());
  h.mock.turns.push({ text: "a", stop: "stop" }, { text: "b", stop: "stop" });

  const first = await collect(h.adapter, context([user("one")]), { sessionId: SESSION });
  const huge = "y".repeat(1024 * 1024);
  h.mock.reset();

  const collected = await collect(
    h.adapter,
    context([user("one"), assistantFrom(first), user(huge)], "A different system prompt."),
    { sessionId: SESSION },
  );

  assert.equal(collected.message.stopReason, "error");
  assert.equal(collected.message.errorMessage, FRAME_TOO_LARGE);
  assert.equal(h.mock.opNames().includes("rebuild"), false);
  assert.equal(h.mock.droppedConnections, 0);
});

test("an over-cap request line is answered and dropped by the service", async (t) => {
  const mock = await MockWireServer.start({ maxLine: 4096 });
  t.after(async () => {
    await mock.stop();
    rmSync(mock.directory, { recursive: true, force: true });
  });
  const connection = await openConnection({ settings: settingsFor(mock.socketPath) });
  t.after(() => connection.close());

  await assert.rejects(
    () => connection.request({ op: "append", role: "user", text: "z".repeat(8192) }),
    /request line is too long/,
  );
  assert.equal(mock.droppedConnections, 1);
});

test("a history response the service cannot frame falls back to a rebuild", async (t) => {
  const h = await harness();
  t.after(() => h.dispose());
  h.mock.turns.push({ text: "a", stop: "stop" }, { text: "b", stop: "stop" });

  const first = await collect(h.adapter, context([user("one")]), { sessionId: SESSION });
  h.adapter.close();

  const restarted = h.newAdapter();
  h.mock.reset();
  h.mock.historyDrops = 1;

  const collected = await collect(
    restarted,
    context([user("one"), assistantFrom(first), user("two")]),
    { sessionId: SESSION },
  );

  assert.equal(collected.message.stopReason, "stop");
  assert.deepEqual(h.mock.opNames(), [
    "describe",
    "open",
    "history",
    "describe",
    "open",
    "rebuild",
    "history",
    "generate",
  ]);
  assert.equal(h.mock.droppedConnections, 1);
});

test("an unreadable record that stays unreadable surfaces a deterministic error", async (t) => {
  const h = await harness();
  t.after(() => h.dispose());
  h.mock.turns.push({ text: "a", stop: "stop" }, { text: "b", stop: "stop" });

  const first = await collect(h.adapter, context([user("one")]), { sessionId: SESSION });
  h.adapter.close();

  const restarted = h.newAdapter();
  h.mock.historyDrops = 2;

  const collected = await collect(
    restarted,
    context([user("one"), assistantFrom(first), user("two")]),
    { sessionId: SESSION },
  );

  assert.equal(collected.message.stopReason, "error");
  assert.match(collected.message.errorMessage ?? "", /too large to read back/);
});

test("a rewind that would drop the anchor's tool calls rebuilds instead", async (t) => {
  const h = await harness();
  t.after(() => h.dispose());
  h.mock.turns.push(
    { text: "", calls: [{ name: "get_weather", arguments: { city: "Kyoto" } }], stop: "tool_use" },
    { text: "sunny", stop: "stop" },
    { text: "rainy", stop: "stop" },
  );

  const first = await collect(h.adapter, context([user("weather?")], "You are helpful.", [weatherTool]), {
    sessionId: SESSION,
  });
  const call = first.message.content.find((block) => block.type === "toolCall");
  assert.ok(call && call.type === "toolCall");
  const withResult = [user("weather?"), assistantFrom(first), toolResult(call.id, "get_weather", "sunny")];
  await collect(h.adapter, context(withResult, "You are helpful.", [weatherTool]), { sessionId: SESSION });
  h.mock.reset();
  h.classifications.length = 0;

  const edited = [user("weather?"), assistantFrom(first), toolResult(call.id, "get_weather", "rainy")];
  await collect(h.adapter, context(edited, "You are helpful.", [weatherTool]), { sessionId: SESSION });

  assert.deepEqual(h.mock.opNames(), ["rebuild", "history", "generate"]);
  assert.equal(h.classifications.includes("rewind"), false);
});

test("the mock drops an assistant's calls when rewound to that assistant, matching conversation.c", async (t) => {
  const mock = await MockWireServer.start();
  t.after(async () => {
    await mock.stop();
    rmSync(mock.directory, { recursive: true, force: true });
  });
  const connection = await openConnection({ settings: settingsFor(mock.socketPath) });
  t.after(() => connection.close());
  mock.turns.push({ text: "", calls: [{ name: "get_weather", arguments: {} }], stop: "tool_use" });

  await connection.request({
    op: "create",
    system: "S",
    tools: [{ name: "get_weather", description: "d", parameters: { type: "object", properties: {} } }],
  });
  const appended = await connection.request({ op: "append", role: "user", text: "weather?" });
  for await (const event of connection.stream({ op: "generate" })) void event;
  const pendingBefore = await connection.request({ op: "pending" });
  assert.deepEqual(pendingBefore["calls"], [1]);

  const history = await connection.request({ op: "history" });
  const entries = history["entries"] as { kind: string; marker: number }[];
  const assistant = entries.find((entry) => entry.kind === "assistant");
  assert.ok(assistant);

  await connection.request({ op: "rewind", marker: assistant.marker });
  const pendingAfter = await connection.request({ op: "pending" });
  assert.deepEqual(pendingAfter["calls"], []);
  await assert.rejects(
    () => connection.request({ op: "append", role: "tool", call_id: 1, text: "sunny", status: "ok" }),
    /unknown tool call id 1/,
  );
  assert.ok(Number(appended["marker"]) >= 0);
});

test("an unmapped tool call id forces a rebuild instead of guessing a wire id", async (t) => {
  const h = await harness();
  t.after(() => h.dispose());
  h.mock.turns.push(
    { text: "", calls: [{ name: "get_weather", arguments: { city: "Kyoto" } }], stop: "tool_use" },
    { text: "sunny", stop: "stop" },
  );

  const first = await collect(h.adapter, context([user("weather?")], "You are helpful.", [weatherTool]), {
    sessionId: SESSION,
  });
  const call = first.message.content.find((block) => block.type === "toolCall");
  assert.ok(call && call.type === "toolCall");
  h.mock.reset();

  const foreign = toolResult("42", "get_weather", "sunny");
  await collect(
    h.adapter,
    context([user("weather?"), assistantFrom(first), foreign], "You are helpful.", [weatherTool]),
    { sessionId: SESSION },
  );

  assert.deepEqual(h.mock.opNames(), ["rebuild", "history", "generate"]);
});

test("a rebuild whose readback does not match the sent context fails loudly", async (t) => {
  const h = await harness();
  t.after(() => h.dispose());
  h.mock.turns.push({ text: "a", stop: "stop" }, { text: "b", stop: "stop" });

  const first = await collect(h.adapter, context([user("one")]), { sessionId: SESSION });
  h.mock.corruptHistory = true;

  const collected = await collect(
    h.adapter,
    context([user("one"), assistantFrom(first), user("two")], "A different system prompt."),
    { sessionId: SESSION },
  );

  assert.equal(collected.message.stopReason, "error");
  assert.match(collected.message.errorMessage ?? "", /does not match the context it was rebuilt from/);
});

test("concurrent provider calls for one pi session do not interleave on the wire", async (t) => {
  const h = await harness();
  t.after(() => h.dispose());
  h.mock.turns.push(
    { text: "first", chunk: 1, delayMs: 5, stop: "stop" },
    { text: "second", chunk: 1, delayMs: 5, stop: "stop" },
  );

  const first = collect(h.adapter, context([user("one")]), { sessionId: SESSION });
  const second = collect(h.adapter, context([user("one"), user("two")]), { sessionId: SESSION });
  const [a, b] = await Promise.all([first, second]);

  assert.equal(a.message.stopReason, "stop");
  assert.equal(b.message.stopReason, "stop");
  const ops = h.mock.opNames().filter((op) => op === "append" || op === "generate");
  for (let index = 0; index < ops.length; index += 2) {
    assert.equal(ops[index], "append");
    assert.equal(ops[index + 1], "generate");
  }
});

test("a failing spawn reports the binary's stderr in the connect error", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "xenopi-spawn-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = join(directory, "fake-xenolith");
  writeFileSync(bin, '#!/bin/sh\necho "xenolith: another process holds the engine lock" >&2\nexit 1\n');
  chmodSync(bin, 0o755);

  await assert.rejects(
    () =>
      openConnection({
        settings: {
          bin,
          model: "/models/fake.gguf",
          socket: join(directory, "wire.sock"),
          stateDir: undefined,
          cacheDir: undefined,
          idleShutdownMinutes: 30,
          spawn: true,
        },
        attempts: 2,
        baseDelayMs: 50,
      }),
    /another process holds the engine lock/,
  );
});

test("a spawn that cannot start at all reports the spawn failure", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "xenopi-spawn-missing-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  await assert.rejects(
    () =>
      openConnection({
        settings: {
          bin: join(directory, "does-not-exist"),
          model: "/models/fake.gguf",
          socket: join(directory, "wire.sock"),
          stateDir: undefined,
          cacheDir: undefined,
          idleShutdownMinutes: 30,
          spawn: true,
        },
        attempts: 2,
        baseDelayMs: 50,
      }),
    /spawn failed/,
  );
});

test("the adapter discovers a service model without built-in model assumptions", async (t) => {
  const mock = await MockWireServer.start({ model: "some-other-model", contextWindow: 8192 });
  const agentDir = mkdtempSync(join(tmpdir(), "xenopi-describe-"));
  t.after(async () => {
    await mock.stop();
    rmSync(mock.directory, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  });
  const warnings: string[] = [];
  const adapter = new XenolithAdapter({
    agentDir,
    settings: settingsFor(mock.socketPath),
    log: (message) => warnings.push(message),
  });
  t.after(() => adapter.close());
  mock.turns.push({ text: "a", stop: "stop" });

  const info = await adapter.describe();
  assert.equal(info.model, "some-other-model");
  assert.equal(info.context_window, 8192);
  assert.deepEqual(warnings, []);
});

test("a transcript near the window rebuilds and reconciles in one frame each (3.7 finding 3)", async (t) => {
  // Real-window mock: 262144 tokens, frame bound 262144 x 16 = 4 MiB as the
  // service advertises. ~1 MB of prose (above the former 900 KB guard and
  // the former 1 MiB service cap) must rebuild, read back and reconcile.
  const h = await harness({ contextWindow: 262144 });
  t.after(() => h.dispose());
  h.mock.turns.push({ text: "a", stop: "stop" }, { text: "b", stop: "stop" }, { text: "c", stop: "stop" });

  const paragraph =
    "Il problema è che la compaction, per costruzione, è a zero prefill: il riassunto viene generato accodando " +
    "alla sessione viva, quindi la cache è già calcolata. Però prima della compaction la sessione può avvicinarsi " +
    "alla finestra, ed è lì che il limite per riga può mordere. ";
  const page = paragraph.repeat(20); // ~5.8 KB, ~1.5k mock tokens
  const messages: Message[] = [];
  for (let i = 0; i < 95; i++) {
    messages.push(user(`${String(i)} ${page}`));
    messages.push(assistant(`${String(i)} ${page}`));
  }
  const bytes = Buffer.byteLength(JSON.stringify(messages), "utf8");
  assert.ok(bytes > 1024 * 1024, `fixture is ${String(bytes)} bytes`);

  // A fresh adapter with a bound to a missing session goes through rebuild + history.
  const first = await collect(h.adapter, context([...messages, user("next")]), { sessionId: SESSION });
  assert.equal(first.message.stopReason, "stop", first.message.errorMessage ?? "");
  assert.ok(h.mock.opNames().includes("rebuild") || h.mock.opNames().includes("create"));
  h.adapter.close();

  // Restart: history carries the whole transcript back in one frame.
  const restarted = h.newAdapter();
  h.mock.reset();
  const second = await collect(
    restarted,
    context([...messages, user("next"), assistantFrom(first), user("after")]),
    { sessionId: SESSION },
  );
  assert.equal(second.message.stopReason, "stop");
  assert.deepEqual(h.mock.opNames(), ["describe", "open", "history", "append", "generate"]);
  assert.equal(h.mock.droppedConnections, 0);
});
