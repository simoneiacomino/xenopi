import assert from "node:assert/strict";
import test from "node:test";
import { normalizeContext, type Message } from "@earendil-works/pi-ai";
import { compactionPrefixKeys } from "../../src/extensions/provider.js";
import { translateContext } from "../../src/adapter/translate.js";
import { assistantFrom, collect, harness, user } from "./harness.js";

const tool = { name: "echo", description: "Echo", parameters: { type: "object", properties: { value: { anyOf: [{ type: "string" }, { type: "null" }] } } } as never };

test("Pi transcript system deltas resolve into one wire prompt and current tools", () => {
  const messages: Message[] = [
    { role: "system", content: "Base", sections: { rules: "Old" }, toolsAdded: [tool], timestamp: 0 },
    user("hello"),
    { role: "system", content: "Later", sections: { rules: "New" }, toolsRemoved: [{ name: "echo" }], timestamp: 1 },
  ];
  const translated = translateContext(normalizeContext({ messages }));
  assert.match(translated.system!, /Base/);
  assert.match(translated.system!, /Later/);
  assert.match(translated.system!, /New/);
  assert.doesNotMatch(translated.system!, /Old/);
  assert.deepEqual(translated.tools, []);
  assert.deepEqual(translated.messages.map((entry) => entry.message), [{ role: "user", text: "hello" }]);
  assert.deepEqual(compactionPrefixKeys(messages), translated.messages.map((entry) => entry.key));
});

test("changed transcript tools rebuild once and unchanged turns keep the cached prefix", async (t) => {
  const h = await harness();
  t.after(() => h.dispose());
  const messages: Message[] = [{ role: "system", content: "Base", toolsAdded: [tool], timestamp: 0 }, user("hello")];
  const first = await collect(h.adapter, normalizeContext({ messages }), { sessionId: "transcript-test" });
  messages.push(assistantFrom(first), { role: "system", content: "", toolsRemoved: [{ name: "echo" }], timestamp: 1 }, user("continue"));
  h.mock.reset();
  const second = await collect(h.adapter, normalizeContext({ messages }), { sessionId: "transcript-test" });
  assert.equal(second.message.stopReason, "stop");
  assert.deepEqual(h.mock.opNames(), ["rebuild", "history", "generate"]);
  messages.push(assistantFrom(second), user("again"));
  h.mock.reset();
  await collect(h.adapter, normalizeContext({ messages }), { sessionId: "transcript-test" });
  assert.deepEqual(h.mock.opNames(), ["append", "generate"]);
});

test("protocol v1 does not silently discard image input", () => {
  assert.throws(() => translateContext({ messages: [{ role: "user", content: [{ type: "image", data: "data", mimeType: "image/png" }], timestamp: 0 }] }), /text input only/);
});

test("async payload replacements are translated before synchronizing the wire session", async (t) => {
  const h = await harness();
  t.after(() => h.dispose());
  const collected = await collect(h.adapter, normalizeContext({ messages: [user("original")] }), {
    sessionId: "payload-test",
    onPayload: async () => normalizeContext({ systemPrompt: "Replacement", messages: [user("changed")] }),
  });
  assert.equal(collected.message.stopReason, "stop");
  assert.equal(h.mock.ops.find((op) => op.op === "create")?.system, "Replacement");
  assert.equal(h.mock.ops.find((op) => op.op === "append")?.text, "changed");
});

test("a service capability change on reconnect fails before reusing a session", async (t) => {
  const h = await harness();
  t.after(() => h.dispose());
  const first = await collect(h.adapter, normalizeContext({ messages: [user("hello")] }), { sessionId: "capabilities-test" });
  h.adapter.close();
  h.mock.contextWindow = 8192;
  h.mock.reset();
  const next = await collect(h.adapter, normalizeContext({ messages: [user("hello"), assistantFrom(first), user("again")] }), { sessionId: "capabilities-test" });
  assert.equal(next.message.stopReason, "error");
  assert.match(next.message.errorMessage!, /capabilities changed/);
  assert.deepEqual(h.mock.opNames(), ["describe"]);
});
