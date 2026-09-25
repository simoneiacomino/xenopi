import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { BindingStore, listPiSessionIds } from "../../src/adapter/bindings.js";
import { assistantFrom, collect, context, harness, user } from "./harness.js";

const SESSION_A = "0199aaaa-0000-7000-8000-000000000001";
const SESSION_B = "0199aaaa-0000-7000-8000-000000000002";

test("the binding map persists atomically and reloads", async (t) => {
  const h = await harness();
  t.after(() => h.dispose());
  h.mock.turns.push({ text: "a", stop: "stop" });

  await collect(h.adapter, context([user("one")]), { sessionId: SESSION_A });
  const wireSession = h.adapter.bindingStore.get(SESSION_A);
  assert.ok(wireSession);

  const raw: unknown = JSON.parse(readFileSync(join(h.agentDir, "wire-bindings.json"), "utf8"));
  assert.equal((raw as { version: number }).version, 1);
  const reloaded = new BindingStore(h.agentDir);
  assert.equal(reloaded.get(SESSION_A), wireSession);
});

test("listPiSessionIds finds session ids by filename and by header", async (t) => {
  const h = await harness();
  t.after(() => h.dispose());
  const projectDir = join(h.agentDir, "sessions", "--home-simo-project--");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(projectDir, `2026-08-20T10-00-00-000Z_${SESSION_A}.jsonl`),
    `${JSON.stringify({ type: "session", id: SESSION_A })}\n`,
  );
  writeFileSync(
    join(projectDir, "renamed.jsonl"),
    `${JSON.stringify({ type: "session", id: SESSION_B })}\n`,
  );

  const found = listPiSessionIds(h.agentDir);

  assert.equal(found.has(SESSION_A), true);
  assert.equal(found.has(SESSION_B), true);
});

function writeSessionFile(agentDir: string, sessionId: string): void {
  const projectDir = join(agentDir, "sessions", "--home-simo-project--");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(projectDir, `2026-08-20T10-00-00-000Z_${sessionId}.jsonl`),
    `${JSON.stringify({ type: "session", id: sessionId })}\n`,
  );
}

test("the startup sweep deletes wire sessions whose pi session is gone", async (t) => {
  const h = await harness();
  t.after(() => h.dispose());
  h.mock.turns.push({ text: "a", stop: "stop" }, { text: "b", stop: "stop" });

  const first = await collect(h.adapter, context([user("one")]), { sessionId: SESSION_A });
  await collect(h.adapter, context([user("one"), assistantFrom(first), user("two")]), {
    sessionId: SESSION_A,
  });
  const orphan = h.adapter.bindingStore.get(SESSION_A);
  assert.ok(orphan);
  assert.deepEqual(h.mock.sessionIds(), [orphan]);
  h.adapter.close();
  writeSessionFile(h.agentDir, SESSION_B);

  const restarted = h.newAdapter();
  h.mock.reset();
  const removed = await restarted.sweep();

  assert.deepEqual(removed, [SESSION_A]);
  assert.deepEqual(h.mock.opNames(), ["describe", "delete"]);
  assert.deepEqual(h.mock.sessionIds(), []);
  assert.equal(restarted.bindingStore.get(SESSION_A), undefined);
});

test("an empty session listing is unknown, not empty: the sweep deletes nothing", async (t) => {
  const h = await harness();
  t.after(() => h.dispose());
  h.mock.turns.push({ text: "a", stop: "stop" });

  await collect(h.adapter, context([user("one")]), { sessionId: SESSION_A });
  const binding = h.adapter.bindingStore.get(SESSION_A);
  assert.ok(binding);
  h.adapter.close();

  const restarted = h.newAdapter();
  h.mock.reset();
  const removed = await restarted.sweep();

  assert.deepEqual(removed, []);
  assert.deepEqual(h.mock.opNames(), []);
  assert.deepEqual(h.mock.sessionIds(), [binding]);
  assert.equal(restarted.bindingStore.get(SESSION_A), binding);
});

test("an overridden session dir that lists nothing does not mass-delete wire records", async (t) => {
  const h = await harness();
  t.after(() => h.dispose());
  h.mock.turns.push({ text: "a", stop: "stop" });

  await collect(h.adapter, context([user("one")]), { sessionId: SESSION_A });
  const binding = h.adapter.bindingStore.get(SESSION_A);
  writeSessionFile(h.agentDir, SESSION_B);
  h.adapter.close();

  const restarted = h.newAdapter();
  h.mock.reset();
  const removed = await restarted.sweep(join(h.agentDir, "elsewhere"));

  assert.deepEqual(removed, []);
  assert.deepEqual(h.mock.opNames(), []);
  assert.deepEqual(h.mock.sessionIds(), [binding]);
});

test("a sweep scoped to an overridden session dir keeps sessions listed there", async (t) => {
  const h = await harness();
  t.after(() => h.dispose());
  h.mock.turns.push({ text: "a", stop: "stop" });

  await collect(h.adapter, context([user("one")]), { sessionId: SESSION_A });
  const binding = h.adapter.bindingStore.get(SESSION_A);
  const custom = join(h.agentDir, "custom-sessions");
  mkdirSync(custom, { recursive: true });
  writeFileSync(
    join(custom, `2026-08-20T10-00-00-000Z_${SESSION_A}.jsonl`),
    `${JSON.stringify({ type: "session", id: SESSION_A })}\n`,
  );
  h.adapter.close();

  const restarted = h.newAdapter();
  h.mock.reset();
  const removed = await restarted.sweep(custom);

  assert.deepEqual(removed, []);
  assert.deepEqual(h.mock.sessionIds(), [binding]);
});

test("the sweep keeps bindings whose pi session file still exists", async (t) => {
  const h = await harness();
  t.after(() => h.dispose());
  h.mock.turns.push({ text: "a", stop: "stop" });

  await collect(h.adapter, context([user("one")]), { sessionId: SESSION_A });
  const kept = h.adapter.bindingStore.get(SESSION_A);
  const projectDir = join(h.agentDir, "sessions", "--home-simo-project--");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(projectDir, `2026-08-20T10-00-00-000Z_${SESSION_A}.jsonl`),
    `${JSON.stringify({ type: "session", id: SESSION_A })}\n`,
  );
  h.adapter.close();

  const restarted = h.newAdapter();
  h.mock.reset();
  const removed = await restarted.sweep();

  assert.deepEqual(removed, []);
  assert.deepEqual(h.mock.opNames(), []);
  assert.equal(restarted.bindingStore.get(SESSION_A), kept);
});
